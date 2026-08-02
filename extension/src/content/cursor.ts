/**
 * The replay cursor — a visible pointer that glides to each target before the click
 * lands, so a run can be watched rather than just read afterwards.
 *
 * Two rules it must never break:
 *
 *   pointer-events: none — the replayer hit-tests with elementFromPoint before every
 *   click, and a cursor sitting on the target would be reported as the topmost
 *   element. The run would fail as occluded, by its own cursor.
 *
 *   Top frame only, in top-frame coordinates — the same space the input itself is
 *   dispatched in, so what you see is literally where the click goes.
 *
 * Built with CSSOM and createElementNS rather than innerHTML or a <style> tag: a
 * strict CSP (Trusted Types, no unsafe-inline) blocks those, and this has to work on
 * the sites that ship one.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const ID = "__tf_cursor";

let root: HTMLElement | null = null;
let ripple: HTMLElement | null = null;
let guard: MutationObserver | null = null;
/** Where the cursor is now, so a glide starts from the right place. */
let at = { x: -100, y: -100 };

function build(): HTMLElement | null {
  if (!document.body) return null;

  const container = document.createElement("div");
  container.id = ID;
  const style = container.style;
  style.position = "fixed";
  style.left = "0";
  style.top = "0";
  style.zIndex = "2147483647";
  style.pointerEvents = "none"; // see the file header — this one is load-bearing
  style.width = "0";
  style.height = "0";
  style.transform = `translate(${at.x}px, ${at.y}px)`;
  style.willChange = "transform";
  // Hidden until it has a real position. A fresh document knows nothing about where
  // the run left the cursor, and flashing it in the corner of every page load is
  // exactly what makes it look broken.
  style.visibility = "hidden";

  // A pointer arrow: white body, dark outline, so it reads on any background.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.style.position = "absolute";
  svg.style.left = "-2px";
  svg.style.top = "-2px";
  svg.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.4))";

  const arrow = document.createElementNS(SVG_NS, "path");
  arrow.setAttribute("d", "M5 3 L5 19 L9.2 15 L11.8 20.6 L14.8 19.2 L12.2 13.8 L18 13.6 Z");
  arrow.setAttribute("fill", "#ffffff");
  arrow.setAttribute("stroke", "#111111");
  arrow.setAttribute("stroke-width", "1.4");
  arrow.setAttribute("stroke-linejoin", "round");
  svg.appendChild(arrow);

  // The click pulse — a ring that expands and fades from the cursor's hotspot.
  const pulse = document.createElement("div");
  const pulseStyle = pulse.style;
  pulseStyle.position = "absolute";
  pulseStyle.left = "-11px";
  pulseStyle.top = "-11px";
  pulseStyle.width = "22px";
  pulseStyle.height = "22px";
  pulseStyle.borderRadius = "50%";
  pulseStyle.border = "2px solid rgba(37, 99, 235, .9)";
  pulseStyle.background = "rgba(37, 99, 235, .18)";
  pulseStyle.opacity = "0";
  pulseStyle.transform = "scale(.3)";

  container.appendChild(pulse);
  container.appendChild(svg);
  document.body.appendChild(container);
  ripple = pulse;
  return container;
}

function ensure(): HTMLElement | null {
  // Rebuilt when the page replaced its body — a SPA route change often does.
  if (root && root.isConnected) return root;
  root = build();
  if (root && !guard) {
    // A framework that re-renders into <body> throws the cursor away with everything
    // else. Without this it stays gone until the next step that happens to move it,
    // which is most of a run on an app that re-renders often.
    guard = new MutationObserver(() => {
      if (root && !root.isConnected && document.body) document.body.appendChild(root);
    });
    try {
      guard.observe(document.body, { childList: true });
    } catch {
      guard = null; // no body yet; the next ensure() will try again
    }
  }
  return root;
}

/**
 * Creates the cursor without moving it.
 *
 * Called on every page load of a replaying tab, for the same reason the badge is:
 * a navigation destroys the document, and a cursor that only appears when something
 * moves it is missing for every load, every wait, and every step that has no target.
 */
export function installCursor(): void {
  if (ensure()) return;
  // document_start — there is no body to attach to yet.
  document.addEventListener("DOMContentLoaded", () => void ensure(), { once: true });
}

/** Puts the cursor somewhere with no animation — used to restore it after a load. */
export function placeCursor(x: number, y: number): void {
  const el = ensure();
  at = { x, y };
  if (!el) return;
  el.style.transition = "none";
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.visibility = "visible";
}

/** Glides to a point in top-frame viewport coordinates. Resolves when it arrives. */
export function moveCursorTo(x: number, y: number, durationMs: number): Promise<void> {
  const el = ensure();
  if (!el) {
    at = { x, y }; // remember it anyway, so the next install lands in the right place
    return Promise.resolve();
  }

  const distance = Math.hypot(x - at.x, y - at.y);
  // A short hop should not take as long as a trip across the page, and the first
  // move of a run (from off-screen) should not crawl.
  const duration = distance < 4 ? 0 : Math.min(durationMs, Math.max(120, distance * 1.1));
  at = { x, y };

  el.style.transition =
    duration > 0 ? `transform ${Math.round(duration)}ms cubic-bezier(.22,.61,.36,1)` : "none";
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.visibility = "visible";

  if (duration === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", done);
      resolve();
    };
    el.addEventListener("transitionend", done);
    // A transition on a hidden or replaced element never fires transitionend.
    setTimeout(done, duration + 80);
  });
}

/** The click pulse. Fire-and-forget: the real input must not wait on an animation. */
export function pulseCursor(): void {
  const el = ensure();
  if (!el || !ripple) return;
  const style = ripple.style;
  style.transition = "none";
  style.opacity = "1";
  style.transform = "scale(.3)";
  // Next frame, so the reset above is committed before the animation starts.
  requestAnimationFrame(() => {
    style.transition = "transform 380ms ease-out, opacity 380ms ease-out";
    style.opacity = "0";
    style.transform = "scale(2.2)";
  });
}

export function removeCursor(): void {
  guard?.disconnect();
  guard = null;
  root?.remove();
  root = null;
  ripple = null;
  at = { x: -100, y: -100 };
}

/** Where the cursor is, so the service worker can restore it after a navigation. */
export function cursorPosition(): { x: number; y: number } {
  return at;
}
