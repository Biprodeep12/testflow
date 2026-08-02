/**
 * The recording environment, applied to Playwright and then verified.
 *
 * Applying it is half the job. Chrome silently CLAMPS a requested viewport to the
 * screen work area in headed mode, a DPR override can be refused, and a font the
 * recording used may not exist on this machine — all of which look like rendering
 * bugs later. So the environment is measured again inside the live page with the
 * SAME capture function the recorder used, and the delta is reported up front.
 */

import type { Browser, BrowserContextOptions, LaunchOptions, Page } from "playwright";
import { captureEnv } from "../shared/env";
import { pageExpr } from "../shared/resolve";
import type { EnvRecord } from "../types/flow";
import { CAUSE, type EnvDelta } from "./types";

export function launchOptionsFrom(
  env: EnvRecord | undefined,
  opts: { headless?: boolean; channel?: string },
): LaunchOptions {
  return {
    headless: opts.headless ?? false,
    channel: opts.channel,
    args: [
      // Headed Chrome applies device scale per PROCESS: without this the context's
      // deviceScaleFactor is emulated on top of the OS one and screenshots differ.
      ...(env ? [`--force-device-scale-factor=${env.deviceScaleFactor}`] : []),
      // Rendering determinism: colour management, subpixel antialiasing and font
      // hinting all vary by machine and all change pixels.
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      // Apps that behave differently under automation would replay a different UI.
      "--disable-blink-features=AutomationControlled",
      // bfcache restores skip the load event the settle logic waits on.
      "--disable-features=BackForwardCache",
    ],
  };
}

export function contextOptionsFrom(env: EnvRecord | undefined): BrowserContextOptions {
  if (!env) return {};
  return {
    viewport: env.viewport,
    screen: env.screen,
    deviceScaleFactor: env.deviceScaleFactor,
    isMobile: env.isMobile,
    hasTouch: env.hasTouch,
    userAgent: env.userAgent,
    locale: env.locale,
    timezoneId: env.timeZone,
    colorScheme: env.colorScheme,
    reducedMotion: env.reducedMotion ? "reduce" : "no-preference",
    forcedColors: env.forcedColors ? "active" : "none",
  };
}

const near = (a: number, b: number, tolerance = 0.5): boolean =>
  Math.abs(a - b) <= tolerance;

/**
 * Measures the live page with the recorder's own capture function and returns the
 * differences, most-blocking first.
 */
export async function verifyEnv(page: Page, recorded: EnvRecord): Promise<EnvDelta[]> {
  const live = (await page.evaluate(pageExpr(captureEnv, undefined as never))) as EnvRecord;
  const deltas: EnvDelta[] = [];

  const push = (
    code: EnvDelta["code"],
    field: string,
    a: unknown,
    b: unknown,
    blocksParity: boolean,
    hint: string,
  ): void => {
    deltas.push({
      code,
      field,
      recorded: String(a),
      live: String(b),
      blocksParity,
      hint,
    });
  };

  if (
    live.viewport.width !== recorded.viewport.width ||
    live.viewport.height !== recorded.viewport.height
  ) {
    push(
      CAUSE.VIEWPORT_CLAMPED,
      "viewport",
      `${recorded.viewport.width}x${recorded.viewport.height}`,
      `${live.viewport.width}x${live.viewport.height}`,
      true,
      "Headed Chrome clamps a viewport larger than the screen work area. Run headless, use a larger display, or re-record at this size.",
    );
  }
  if (!near(live.deviceScaleFactor, recorded.deviceScaleFactor, 0.01)) {
    push(
      CAUSE.DPR_MISMATCH,
      "deviceScaleFactor",
      recorded.deviceScaleFactor,
      live.deviceScaleFactor,
      true,
      "Device scale is per browser process. Launch with --force-device-scale-factor, or group flows by DPR.",
    );
  }
  if (live.scrollbarWidth !== recorded.scrollbarWidth) {
    push(
      CAUSE.SCROLLBAR,
      "scrollbarWidth",
      recorded.scrollbarWidth,
      live.scrollbarWidth,
      true,
      `Classic vs overlay scrollbars: every centered element shifts by ${Math.abs(live.scrollbarWidth - recorded.scrollbarWidth)}px.`,
    );
  }

  for (const font of recorded.fonts) {
    const match = live.fonts.find((f) => f.family === font.family);
    if (!match) continue; // the page no longer uses it — a content change, not a font fault
    const substituted = font.widths.some((w, i) => !near(w, match.widths[i] ?? -1));
    if (substituted) {
      push(
        CAUSE.FONT_SUBSTITUTION,
        `font:${font.family}`,
        font.widths.join("/"),
        match.widths.join("/"),
        true,
        `"${font.family}" renders at a different width here — it resolved to a different face. Install the font or run in a container with the recording's font set.`,
      );
    }
  }

  if (live.timeZone !== recorded.timeZone) {
    push(CAUSE.TIMEZONE, "timeZone", recorded.timeZone, live.timeZone, true,
      "Every rendered date and time differs. Set timezoneId on the context.");
  }
  if (live.locale !== recorded.locale) {
    push(CAUSE.LOCALE, "locale", recorded.locale, live.locale, true,
      "Number, date and currency formatting differ. Set locale on the context.");
  }
  if (live.colorScheme !== recorded.colorScheme) {
    push(CAUSE.COLOR_SCHEME, "colorScheme", recorded.colorScheme, live.colorScheme, true,
      "The page is rendering its other theme.");
  }
  if (live.reducedMotion !== recorded.reducedMotion) {
    push(CAUSE.REDUCED_MOTION, "reducedMotion", recorded.reducedMotion, live.reducedMotion, false,
      "Animations run differently; transient frames will differ.");
  }
  const major = (v: string): string => v.split(".")[0];
  if (major(live.browser.version) !== major(recorded.browser.version)) {
    push(
      CAUSE.BROWSER_VERSION,
      "browser",
      `${recorded.browser.name} ${recorded.browser.version}`,
      `${live.browser.name} ${live.browser.version}`,
      false,
      "Different engine build: form controls, default fonts and rasterisation can all shift. Use channel: 'chrome' to match the recording.",
    );
  }

  return deltas.sort((a, b) => Number(b.blocksParity) - Number(a.blocksParity));
}

/** Applies the recording's t0 to the context clock without touching timers. */
export async function pinClock(
  context: { clock: { setFixedTime(time: Date): Promise<void> } },
  epochMs: number,
): Promise<void> {
  // setFixedTime (not install) on purpose: it makes Date/Date.now deterministic
  // WITHOUT freezing setTimeout, so debounces and animations still behave.
  await context.clock.setFixedTime(new Date(epochMs));
}

export type { Browser };
