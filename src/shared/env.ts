/**
 * Environment capture — ONE function, run twice.
 *
 * At record time the content script calls it. At replay time the Playwright runner
 * ships the same source into the page and calls it again. The field-by-field delta
 * between the two IS the environment section of the parity report, which is why
 * capture and verification must never be two different implementations.
 *
 * CONSTRAINT: self-contained (serialized with `toString()` — see pageExpr).
 */

import type { EnvRecord } from "../types/flow";

/**
 * Environment capture is synchronous everywhere it is used, but permission state is
 * only available asynchronously — so it is read separately and merged in.
 */
export async function capturePermissions(): Promise<string[]> {
  const candidates = [
    "geolocation",
    "notifications",
    "camera",
    "microphone",
    "clipboard-read",
  ];
  const granted: string[] = [];
  for (const name of candidates) {
    try {
      const status = await navigator.permissions.query({
        name: name as PermissionName,
      });
      if (status.state === "granted") granted.push(name);
    } catch {
      // Not a permission this browser knows — nothing to record.
    }
  }
  return granted;
}

export function captureEnv(): EnvRecord {
  const probeStrings = ["MMMMMMMMWWWWiiiil", "Hamburgefonstiv"];

  /** Families actually used by rendered text — not every family in the stylesheet. */
  const familiesInUse = (): string[] => {
    const found = new Set<string>();
    const nodes = document.querySelectorAll("body, body *");
    let seen = 0;
    for (const node of nodes) {
      if (seen++ > 400) break; // bounded: this runs on the interaction-free path
      const family = getComputedStyle(node).fontFamily.split(",")[0];
      const clean = family.replace(/["']/g, "").trim();
      if (clean) found.add(clean);
      if (found.size >= 12) break;
    }
    return Array.from(found);
  };

  /**
   * A font's identity by its metrics. `document.fonts` only knows about webfonts,
   * so it cannot tell you that "Inter" silently fell back to Arial on a machine
   * that never had it — but the rendered width of a probe string can.
   */
  const probeFonts = (): EnvRecord["fonts"] => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    return familiesInUse().map((family) => {
      const widths = probeStrings.map((text) => {
        ctx.font = `16px "${family}", sans-serif`;
        return Math.round(ctx.measureText(text).width * 100) / 100;
      });
      let loaded = false;
      try {
        loaded = document.fonts.check(`16px "${family}"`);
      } catch {
        /* exotic family name — leave false */
      }
      return { family, loaded, widths };
    });
  };

  const webgl = (): { vendor: string; renderer: string } | undefined => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
      if (!gl) return undefined;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (!info) return undefined;
      return {
        vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)),
        renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
      };
    } catch {
      return undefined;
    }
  };

  const ua = navigator.userAgent;
  const match = /(Chrome|Firefox|Edg|Safari)\/([\d.]+)/.exec(ua);
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } })
    .userAgentData;

  const media = (query: string): boolean => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    layoutWidth: document.documentElement.clientWidth,
    // Classic vs overlay scrollbars shift every centered element by ~7-8px.
    scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
    deviceScaleFactor: window.devicePixelRatio || 1,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availHeight: window.screen.availHeight,
    },
    userAgent: ua,
    platform: uaData?.platform ?? navigator.platform,
    browser: { name: match ? match[1] : "unknown", version: match ? match[2] : "0" },
    locale: navigator.language,
    languages: Array.from(navigator.languages ?? [navigator.language]),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeOrigin: performance.timeOrigin,
    colorScheme: media("(prefers-color-scheme: dark)") ? "dark" : "light",
    reducedMotion: media("(prefers-reduced-motion: reduce)"),
    forcedColors: media("(forced-colors: active)"),
    isMobile: uaData?.mobile ?? /Mobi|Android/i.test(ua),
    hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    fonts: probeFonts(),
    webgl: webgl(),
  };
}
