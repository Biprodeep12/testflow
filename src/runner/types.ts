/**
 * Runner contract + the failure vocabulary.
 *
 * Every way a live run can diverge from the recording gets a CODE, and the report
 * names exactly one per finding. "The screenshot differs" is not a usable result;
 * "the recording used Inter and this machine substituted a fallback" is.
 */

import type { EnvRecord, FlowStep } from "../types/flow";

/** Ordered by precedence — the first one that fires is the reported cause. */
export const CAUSE = {
  VIEWPORT_CLAMPED: "E_VIEWPORT_CLAMPED",
  DPR_MISMATCH: "E_DPR_MISMATCH",
  SCROLLBAR: "E_SCROLLBAR",
  FONT_SUBSTITUTION: "E_FONT_SUBSTITUTION",
  TIMEZONE: "E_TIMEZONE",
  LOCALE: "E_LOCALE",
  COLOR_SCHEME: "E_COLOR_SCHEME",
  REDUCED_MOTION: "E_REDUCED_MOTION",
  BROWSER_VERSION: "E_BROWSER_VERSION",
  TARGET_MISSING: "E_TARGET_MISSING",
  FRAME_MISSING: "E_FRAME_MISSING",
  FRAME_BY_SIGNATURE: "E_FRAME_BY_SIGNATURE",
  NO_MATCH: "E_NO_MATCH",
  SCROLL_STATE: "E_SCROLL_STATE",
  EXPRESSION: "E_EXPRESSION",
  NAVIGATION: "E_NAVIGATION",
  ACTION_FAILED: "E_ACTION_FAILED",
  /** sealed mode: the live run asked for something the recording never saw */
  CONTENT_DRIFT: "E_CONTENT_DRIFT",
  /** a secret the flow needs was not supplied to the runner */
  SECRET_MISSING: "E_SECRET_MISSING",
  /** the step cannot be replayed faithfully at all, and the recorder knew it */
  DEGRADED: "E_DEGRADED",
  /** something is on top of the target, so real input would land on it instead */
  OCCLUDED: "E_OCCLUDED",
  /** a virtualized list no longer contains the row the scroll was anchored to */
  VIRTUAL_ANCHOR: "E_VIRTUAL_ANCHOR",
  /** the recorded step downloaded a file and this run did not */
  DOWNLOAD_MISSING: "E_DOWNLOAD_MISSING",
} as const;

export type CauseCode = (typeof CAUSE)[keyof typeof CAUSE];

export type EnvDelta = {
  code: CauseCode;
  field: string;
  recorded: string;
  live: string;
  /** true when this alone makes pixel-identical replay impossible */
  blocksParity: boolean;
  hint: string;
};

export type StepResult = {
  index: number;
  type: FlowStep["type"];
  status: "pass" | "fail" | "skipped";
  /** logical tab the step ran in */
  targetId: string;
  /** how the frame was found — "signature" means indices had shifted */
  frameHow?: "main" | "index" | "signature";
  durationMs: number;
  code?: CauseCode;
  error?: string;
  /** non-fatal observations (e.g. the element had to be scrolled into view) */
  notes?: string[];
};

export type RunReport = {
  ok: boolean;
  title: string;
  /**
   * live   — real backend. Content differs run to run by definition, so a visual
   *          difference is information, never a pass/fail.
   * sealed — every response served from the recorded HAR, the clock pinned and the
   *          PRNG seeded. The only mode in which "it looked different" is a result.
   */
  mode: "live" | "sealed";
  startedAt: number;
  durationMs: number;
  env: {
    recorded?: EnvRecord;
    deltas: EnvDelta[];
  };
  steps: StepResult[];
  /** the first blocking cause, if any — what to fix before anything else */
  blockedBy?: EnvDelta;
  /** sealed mode: requests the recording never saw, and therefore could not serve */
  unmatchedRequests?: string[];
  /** problems with the flow ITSELF, found before it ran — e.g. sidecar misalignment */
  warnings?: string[];
};

export type RunOptions = {
  /** headed is the default: background/headless rendering is a drift source */
  headless?: boolean;
  /** match the recording browser rather than bundled Chromium */
  channel?: string;
  /** "recorded" replays the gaps the user left; "fast" is event-driven only */
  speed?: "fast" | "recorded";
  /** per-step wait budget when the step carries none */
  timeout?: number;
  /** freeze Date/Date.now to the recorded moment of each step */
  clock?: "recorded" | "off";
  /** keep going after a failed step instead of stopping at the first one */
  continueOnError?: boolean;
  /** reuse a browser instead of launching one (tests) */
  reuseBrowser?: import("playwright").Browser;
  /**
   * Sealed mode. `record` runs live and writes a HAR; `replay` serves every request
   * from it and aborts anything the recording never saw, so the run is a pure
   * function of the flow plus the archive.
   */
  har?: { path: string; mode: "record" | "replay" };
  /** seed for the page PRNG; same flow, same "random" sequence, every run */
  seed?: number;
  /** hold autoplaying media at frame zero; defaults on in sealed mode only */
  pauseMedia?: boolean;
  /**
   * Values for secrets the recorder deliberately did not capture, keyed by the name
   * on the step's meta. Missing entries fail as E_SECRET_MISSING rather than
   * silently typing an empty password.
   */
  secrets?: Record<string, string>;
};

export const MAX_RECORDED_PAUSE_MS = 10_000;
