/**
 * Page-side determinism controls, installed before any page script runs.
 *
 * These do not make a replay "more correct" — they remove the sources of run-to-run
 * variation that would otherwise be indistinguishable from a real difference. A flow
 * that fails only because Math.random() returned something else is noise, and noise
 * is what makes a suite get ignored.
 *
 * What is deliberately NOT here: freezing timers. An app whose debounces and
 * transitions never fire behaves differently from the one that was recorded, which
 * trades one kind of divergence for a worse one. Time comes from page.clock's fixed
 * Date instead (see env.ts), which leaves setTimeout alone.
 *
 * CONSTRAINT: self-contained (serialized into the page by addInitScript).
 */

export type DeterminismConfig = {
  /** PRNG seed — the same flow replays the same "random" sequence every run. */
  seed: number;
  /** Neutralise smooth scrolling so a restored offset lands exactly, immediately. */
  instantScroll: boolean;
  /** Hold media at frame zero: autoplaying video is a moving target under any test. */
  pauseMedia: boolean;
};

export function installDeterminism(config: DeterminismConfig): void {
  // mulberry32: tiny, seedable, and good enough that an app cannot tell it from
  // the platform PRNG by inspection.
  let state = config.seed >>> 0;
  Math.random = function seeded(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  if (config.pauseMedia) {
    // Autoplaying media never renders the same twice, and a <video> that keeps
    // playing changes what every later step sees. Pausing at load leaves an
    // explicit play() alone — a flow that tests playback still works.
    const pause = (): void => {
      for (const media of document.querySelectorAll("video, audio")) {
        const element = media as HTMLMediaElement;
        if (element.autoplay) {
          element.autoplay = false;
          element.pause();
          element.currentTime = 0;
        }
      }
    };
    document.addEventListener("DOMContentLoaded", pause, { once: true });
    document.addEventListener("play", (event) => {
      const element = event.target as HTMLMediaElement;
      if (element.autoplay) element.pause();
    }, true);
  }

  if (config.instantScroll) {
    // scroll-behavior: smooth turns "restore this offset" into an animation that is
    // still running when the next step reads the page. Native scrolling by real
    // input is unaffected; only the interpolation is removed.
    const style = document.createElement("style");
    style.textContent =
      "html, body, * { scroll-behavior: auto !important; }";
    const attach = (): void => {
      (document.head ?? document.documentElement)?.appendChild(style);
    };
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  }
}
