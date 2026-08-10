/**
 * Chrome DevTools Recorder flow format — the exact JSON shape DevTools exports and
 * @puppeteer/replay consumes. This is the storage format for recordings: interoperable
 * with DevTools (import/export both ways) and with puppeteer's replay tooling.
 *
 * A selector *group* is string[] (a chain, for shadow-DOM hops); a step carries a list
 * of groups, each prefixed by engine: `aria/`, `xpath/`, `pierce/`, `text/`, or raw CSS.
 */

export type SelectorGroup = string[];

export type AssertedEvent = {
  type: "navigation";
  url?: string;
  title?: string;
};

/* ------------------------------------------------------------------ *
 * Target & frame identity.
 *
 * A recorded step happens in exactly one (tab, frame) pair. Both must survive
 * into the flow or replay has to guess — and guessing is what this system is
 * built to avoid. Tabs are logical ids ("t0" = where the session started, "t1" =
 * the first popup it opened), because real tab ids differ every run.
 * ------------------------------------------------------------------ */

export type TargetId = string;

/**
 * One hop down the iframe chain. `index` is the position among the parent
 * document's frames — the same number DevTools puts in its native `frame` path.
 * `selectors` describes the <iframe> ELEMENT itself and is produced by the PARENT
 * document, so it survives frame reordering (ads, lazy mounts) that breaks indices,
 * and it is what Playwright's frameLocator() needs.
 */
export type FrameLink = {
  index: number;
  selectors?: SelectorGroup[];
  url?: string;
  name?: string;
};

/** A scroll offset that was in effect when the step ran — replay restores these. */
export type ScrollRecord = {
  /** null selectors = the document itself */
  selectors: SelectorGroup[] | null;
  x: number;
  y: number;
  /**
   * What was actually at the top of the container.
   *
   * A raw scrollTop is meaningless in a virtualized or infinite list: 4200px is a
   * different row once item heights change or the data shifts by one. The anchor
   * says "this element, this far down" — a position in CONTENT rather than pixels —
   * and replay reports it when the anchor is gone instead of landing somewhere else
   * and looking fine.
   */
  anchor?: { selectors: SelectorGroup[]; offsetY: number };
};

/**
 * TestFlow sidecar carried alongside `steps`, one entry per step at the SAME index.
 * It lives outside the step objects so `exportSteps()` still yields byte-compatible
 * DevTools JSON — the recording model is preserved exactly, and everything replay
 * needs to reproduce the session rides next to it.
 */
export type StepMeta = {
  /**
   * The step this belongs to.
   *
   * `steps` and `meta` are also kept in index lockstep, but that alignment is a
   * convention maintained across the content script, the service worker, the
   * dashboard, two Firestore blobs, the export and the runner — one filter or sort
   * anywhere in that chain silently attaches every step to the wrong context. The
   * id makes the correct pairing checkable instead of assumed.
   */
  stepId?: number;
  targetId: TargetId;
  /** empty = the target's main frame */
  frameChain: FrameLink[];
  /**
   * performance.timeOrigin + performance.now() — a MONOTONIC stamp. Wall-clock
   * (Date.now) is subject to NTP steps and cannot measure a keyboard hold or an
   * inter-step gap reliably, and gaps are exactly what "as recorded" replays.
   */
  tMono: number;
  /** element geometry at action time — diagnoses "clicked, but somewhere else" */
  rect?: { x: number; y: number; width: number; height: number };
  /** every container that was scrolled away from origin when the step ran */
  scrollState?: ScrollRecord[];
  /**
   * A native dialog this step opened, and what the user answered. Replay must give
   * the same answer: an unanswered confirm() blocks the page forever, and a
   * different answer takes a different branch through the app.
   */
  dialog?: DialogRecord;
  /** files chosen for an <input type="file"> */
  upload?: UploadRecord;
  /**
   * The gesture was a native HTML5 drag-and-drop, not just a pointer drag.
   *
   * The distinction decides whether replay can work at all: the browser's drag
   * machinery only starts for REAL input, so a synthetic replay of this step moves
   * a cursor and drops nothing. Recorded so that limitation is reported up front.
   */
  nativeDrag?: { types: string[] };
  /** the step started a file download — replay waits for it and checks the name */
  download?: { filename: string };
  /**
   * The step needs a value the recorder deliberately did not capture (a password).
   * Replay supplies it by name, or fails saying which one is missing — it never
   * types the empty string and calls that a pass.
   */
  secretRef?: string;
  /** the recorder already knows this step cannot replay faithfully, and why */
  degraded?: DegradedReason;
};

export type DialogRecord = {
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  /** false = the user dismissed it */
  accept: boolean;
  /** what was typed into a prompt() */
  promptText?: string;
};

export type UploadRecord = {
  files: { name: string; mimeType: string; base64: string }[];
  /** true when a file exceeded the capture cap and only its name was kept */
  truncated: boolean;
};

export type DegradedReason =
  /** only positional selectors were available — the first DOM change breaks it */
  | "positional-only"
  /** the file was too large to carry in the flow */
  | "upload-truncated";

/** Files above this never enter a flow — a recording is not an asset store. */
export const MAX_UPLOAD_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ *
 * Environment record — captured once, before the first step.
 *
 * This is the minimum set that determines LAYOUT. Anything missing here is a
 * visual difference replay can neither reproduce nor explain, so each field
 * doubles as a named cause in the parity report.
 * ------------------------------------------------------------------ */

export type FontProbe = {
  family: string;
  loaded: boolean;
  /** canvas measureText widths of fixed probe strings — detects substitution */
  widths: number[];
};

export type EnvRecord = {
  viewport: { width: number; height: number };
  /** documentElement.clientWidth — differs from viewport.width by the scrollbar */
  layoutWidth: number;
  /** innerWidth - clientWidth. Classic vs overlay scrollbars shift EVERY centered
   *  element by ~7-8px; this is the single most-missed source of whole-page drift. */
  scrollbarWidth: number;
  deviceScaleFactor: number;
  screen: { width: number; height: number; availHeight: number };
  userAgent: string;
  platform?: string;
  browser: { name: string; version: string };
  locale: string;
  languages: string[];
  timeZone: string;
  /** the recording's t0 — replay pins its fake clock to this */
  timeOrigin: number;
  colorScheme: "light" | "dark";
  reducedMotion: boolean;
  forcedColors: boolean;
  isMobile: boolean;
  hasTouch: boolean;
  maxTouchPoints: number;
  fonts: FontProbe[];
  webgl?: { vendor: string; renderer: string };
  /**
   * Permissions the page already held. A flow recorded with geolocation granted
   * takes a different path than one where the prompt is still pending, and replay
   * cannot click a native permission bubble.
   */
  permissions?: string[];
};

export type FlowStep = {
  type:
    | "setViewport"
    | "navigate"
    | "click"
    | "doubleClick"
    | "change"
    | "keyDown"
    | "keyUp"
    | "scroll"
    | "waitForElement"
    | "waitForExpression"
    /**
     * TestFlow extension (NOT in the DevTools schema, which has no wheel step):
     * wheel input the page CONSUMED instead of scrolling — map zoom, carousels,
     * canvas apps. Replayed as real WheelEvents at the recorded offsets.
     */
    | "wheel"
    /**
     * TestFlow extension: pointer drag — map panning, sliders, drag-to-reorder.
     * Carries the sampled cursor path relative to the start point.
     */
    | "drag";
  // setViewport
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
  // navigate
  url?: string;
  assertedEvents?: AssertedEvent[];
  // element steps
  /** Native DevTools target: "main" for the starting tab, else the popup's URL. */
  target?: string;
  /**
   * Native DevTools frame path: index of each iframe hop from the target's main
   * frame down to the step's frame. Absent/empty = main frame. The richer,
   * reorder-proof description of the same chain is in StepMeta.frameChain.
   */
  frame?: number[];
  selectors?: SelectorGroup[];
  offsetX?: number;
  offsetY?: number;
  // change
  value?: string;
  // keyDown / keyUp
  key?: string;
  // scroll
  x?: number;
  y?: number;
  // wheel (TestFlow extension): summed deltas of the burst
  deltaX?: number;
  deltaY?: number;
  /** click: which mouse button — native DevTools field ("secondary" = right-click) */
  button?: "primary" | "auxiliary" | "secondary" | "back" | "forward";
  // drag (TestFlow extension): cursor path as deltas from the start point + total ms
  path?: { x: number; y: number }[];
  duration?: number;
  // waitForExpression
  expression?: string;
  /** Native DevTools/puppeteer-replay field: per-step wait budget in ms. */
  timeout?: number;
  /**
   * TestFlow extra (NOT part of the DevTools format): epoch ms when the step was
   * recorded — this is what "replay at recorded speed" paces against. Stripped by
   * exportSteps() so downloaded JSON stays byte-compatible with DevTools.
   */
  timestamp?: number;
  /**
   * TestFlow extra on `change` steps: the element's tag — Playwright codegen needs
   * it because fill() throws on <select> (selectOption() is required). Stripped on
   * export; @puppeteer/replay handles selects natively so pure JSON doesn't need it.
   */
  tagName?: string;
  /**
   * TestFlow extra: this step's identity, so its sidecar entry can be matched by
   * something stronger than array position. Stripped on export.
   */
  id?: number;
};

/**
 * The file the Playwright runner eats: the DevTools flow PLUS the sidecars.
 *
 * Two exports exist on purpose. `exportSteps()` produces the interoperable DevTools
 * document — importable into Chrome, runnable by @puppeteer/replay, and free of
 * anything they would not understand. This one is the full recording, and it is what
 * makes a replay reproduce the session rather than merely repeat its actions.
 */
export const BUNDLE_EXTENSION = ".tfflow.json";

export function toBundle(flow: FlowJson): string {
  return JSON.stringify(
    {
      title: flow.title,
      timeout: flow.timeout ?? DEFAULT_TIMEOUT_MS,
      steps: flow.steps,
      meta: flow.meta ?? [],
      env: flow.env,
    },
    null,
    2,
  );
}

/** Pure-DevTools copy of the steps: TestFlow-only fields removed. */
export function exportSteps(steps: FlowStep[]): FlowStep[] {
  return steps.map((step) => {
    const rest = { ...step };
    delete rest.timestamp;
    delete rest.tagName;
    delete rest.id;
    return rest;
  });
}

/**
 * Pairs each step with its sidecar entry — by id where both sides have one, and by
 * position otherwise (older flows, and hand-written ones).
 *
 * Returns a lookup rather than doing a find() per step, because a linear scan per
 * step turns a long recording into an O(n²) walk.
 */
export function metaResolver(flow: FlowJson): (index: number) => StepMeta | undefined {
  const byId = new Map<number, StepMeta>();
  for (const meta of flow.meta ?? []) {
    if (typeof meta.stepId === "number") byId.set(meta.stepId, meta);
  }
  return (index: number) => {
    const id = flow.steps[index]?.id;
    if (typeof id === "number") {
      const hit = byId.get(id);
      if (hit) return hit;
    }
    return flow.meta?.[index];
  };
}

/**
 * Everything wrong with a flow's step/sidecar pairing, in words.
 *
 * Empty means the two agree. A non-empty result is reported rather than thrown:
 * a misaligned flow still replays (by position), it just cannot be trusted to run
 * each step in the tab and frame it was recorded in.
 */
export function alignmentProblems(flow: FlowJson): string[] {
  const problems: string[] = [];
  const meta = flow.meta ?? [];
  if (meta.length === 0) return problems;

  if (meta.length !== flow.steps.length) {
    problems.push(
      `${flow.steps.length} steps but ${meta.length} sidecar entries — one of them has been filtered or reordered`,
    );
  }
  const mismatched = flow.steps.filter((step, index) => {
    const other = meta[index];
    return (
      typeof step.id === "number" &&
      typeof other?.stepId === "number" &&
      other.stepId !== step.id
    );
  }).length;
  if (mismatched > 0) {
    problems.push(
      `${mismatched} step(s) are paired with a sidecar entry belonging to a different step`,
    );
  }
  return problems;
}

/**
 * The exact top-level shape DevTools exports, plus TestFlow sidecars.
 *
 * `title`/`steps`/`timeout` ARE the DevTools document — download strips everything
 * else. `env` and `meta` sit beside it: replay inputs, never part of the recording
 * model, so the captured flow stays exactly what DevTools would have captured.
 */
export type FlowJson = {
  title: string;
  steps: FlowStep[];
  /** Native flow-level wait budget (ms); @puppeteer/replay defaults to 5000. */
  timeout?: number;
  /** TestFlow sidecar: the recording environment, for replay fidelity. */
  env?: EnvRecord;
  /** TestFlow sidecar: one entry per step, same index. */
  meta?: StepMeta[];
};

/** The main frame of the tab the session started in. */
export const ROOT_TARGET: TargetId = "t0";

/** Stable key for a frame chain — the index path, e.g. "" (main) or "0/2". */
export function frameKey(chain: FrameLink[] | undefined): string {
  return (chain ?? []).map((link) => link.index).join("/");
}

/** Fallback identity when indices have shifted: the iframe elements' best selectors. */
export function frameSignature(chain: FrameLink[] | undefined): string {
  return (chain ?? [])
    .map((link) => link.selectors?.[0]?.[0] ?? `#${link.index}`)
    .join(" >>> ");
}

/** Our default wait budget for selectors, redirects and loads. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Firestore doc: a FlowJson plus bookkeeping. Saved ONLY on explicit user save. */
export type FlowDoc = FlowJson & {
  id: string;
  sourceUrl: string;
  stepCount: number;
  createdAt: number;
  updatedAt: number;
};

/* ------------------------------------------------------------------ *
 * Message protocol.
 *
 * Dashboard page <-> bridge content script via window.postMessage; the bridge relays
 * to/from the extension service worker over a chrome.runtime port. The dashboard never
 * needs the extension id — the bridge only runs on the dashboard's own origin.
 * ------------------------------------------------------------------ */

/** How a service-worker-driven run executes. */
export type RunOptions = {
  /** "recorded" honours the pauses you left between interactions (capped) */
  speed: "fast" | "recorded";
  /** glide a visible cursor to each target before acting */
  cursor: boolean;
  /**
   * Run the `waitForExpression` steps — in a TestFlow recording these are the SPA
   * route assertions (`location.pathname + location.hash === "…"`). Off skips them,
   * reported as `skipped` so a run that no longer visits the recorded route cannot
   * pass by omission. For flows whose route is legitimately different every run
   * (a session id in the path, an A/B redirect), or an imported DevTools flow with
   * an expression this browser can't satisfy.
   *
   * Optional so an older dashboard, which sends neither field, still runs them.
   */
  routeWaits?: boolean;
};

/** One step's state in a service-worker-driven run. */
export type StepRunResult = {
  status: "pending" | "running" | "pass" | "fail" | "skipped";
  error?: string;
  /** ran, but not as recorded (e.g. synthetic events) — shown, never swallowed */
  note?: string;
};

/** extension -> dashboard page */
export type AgentMessage =
  | { source: "tf-agent"; kind: "bridge-ready" }
  | {
      source: "tf-agent";
      kind: "ready"; // a recorded/replayed page finished loading
      url: string;
      title: string;
      width: number;
      height: number;
      dpr: number;
      /** which logical tab reported it — "t0" is where the session started */
      targetId: TargetId;
    }
  | { source: "tf-agent"; kind: "step"; step: FlowStep; meta: StepMeta }
  | {
      source: "tf-agent";
      /** full session state — sent when the dashboard (re)connects mid-recording */
      kind: "snapshot";
      recording: boolean;
      steps: FlowStep[];
      meta: StepMeta[];
      env?: EnvRecord;
      /**
       * The recording is incomplete and the user must know before saving it.
       *
       * Set when a step could not be stored — storage full, most likely. A flow
       * that silently lost a step in the middle is worse than one that stopped,
       * because it looks complete and replays as something the user never did.
       */
      error?: string;
      /**
       * A service-worker-driven replay in flight. Sent on every (re)connect, which
       * is what lets a dashboard that reloaded mid-run rejoin it live instead of
       * losing it — the run itself never lived in the page.
       */
      run?: {
        runId: number;
        /** the flow doc being replayed, so an unrelated flow page ignores it */
        flowId?: string;
        index: number;
        statuses: StepRunResult[];
      };
    }
  | {
      source: "tf-agent";
      /** one step of a service-worker-driven run changed state */
      kind: "runProgress";
      runId: number;
      index: number;
      status: "running" | "pass" | "fail" | "skipped";
      error?: string;
      note?: string;
    }
  | {
      source: "tf-agent";
      /** a service-worker-driven run ended — completed, failed, or aborted */
      kind: "runDone";
      runId: number;
      ok: boolean;
      error?: string;
    }
  | { source: "tf-agent"; kind: "stopped" }
  | {
      source: "tf-agent";
      /** the current page finished loading fully (window "load" fired) */
      kind: "settled";
      url: string;
    }
  | {
      source: "tf-agent";
      kind: "stepResult";
      id: number;
      ok: boolean;
      error?: string;
      /**
       * The step ran, but not the way the recording did — e.g. synthetic events
       * because real input was unavailable. Surfaced instead of swallowed: it is
       * exactly the kind of difference that explains a later mismatch.
       */
      note?: string;
    };

/** dashboard page -> extension */
export type HubMessage =
  | { source: "tf-hub"; kind: "ping" }
  | { source: "tf-hub"; kind: "openAndRecord"; url: string }
  | { source: "tf-hub"; kind: "stop" }
  | { source: "tf-hub"; kind: "openForReplay"; url: string }
  | {
      source: "tf-hub";
      /**
       * Run a whole flow, orchestrated by the service worker. The flow crosses the
       * bridge once; the dashboard then only observes runProgress/runDone.
       *
       * The loop must not live in a page: the dashboard tab is hidden the moment
       * the replay tab takes focus, and Chrome throttles a hidden page's timers —
       * which distorted "as recorded" pacing and made every timeout late. The
       * worker is not throttled, and a run also survives a dashboard reload (the
       * page rejoins via the snapshot's `run`).
       */
      kind: "startReplay";
      /** minted by the dashboard so it can tell its own run's events apart */
      runId: number;
      /** the flow doc id, echoed in snapshots so other flow pages ignore the run */
      flowId?: string;
      flow: FlowJson;
      options: RunOptions;
    }
  | {
      source: "tf-hub";
      kind: "runStep";
      id: number;
      step: FlowStep;
      /** where to run it — omitted means the session's root frame */
      meta?: StepMeta;
      /** glide a visible cursor to the target before acting (in-browser replay only) */
      cursor?: boolean;
    }
  | { source: "tf-hub"; kind: "closeReplay" };

/* Content script <-> service worker (chrome.runtime messages) */

export type CsToSw =
  | {
      type: "cs-ready"; // a FRAME loaded in a tracked tab (every frame announces)
      url: string;
      title: string;
      width: number;
      height: number;
      dpr: number;
      /** this frame's chain from the tab's main frame; [] = main frame */
      frameChain: FrameLink[];
      /** page-side monotonic stamp — the SW's own clock has a different origin */
      tMono: number;
      /** top frame only, once per session: the full environment record */
      env?: EnvRecord;
    }
  | { type: "cs-step"; step: FlowStep; meta: Omit<StepMeta, "targetId"> }
  | {
      /** SPA route change — history.pushState/replaceState/popstate/navigate */
      type: "cs-route";
      url: string;
      title: string;
      tMono: number;
    }
  | {
      /**
       * A native dialog opened and was answered. It belongs to the step that
       * triggered it — which is already recorded, because interactions are captured
       * on the capture phase, before the page's own handler runs.
       */
      type: "cs-dialog";
      dialog: DialogRecord;
    }
  | { type: "cs-settled"; url: string }
  | { type: "cs-get-mode" };

export type SwToCs =
  | { type: "cs-run"; id: number; step: FlowStep; meta?: StepMeta }
  | {
      /**
       * Phase one of real-input replay: the frame resolves the element and reports
       * where to aim, in TOP-FRAME viewport coordinates. The service worker then
       * dispatches the actual input over CDP, which no page-side code can fake.
       */
      type: "cs-locate";
      step: FlowStep;
      meta?: StepMeta;
      /**
       * Resolve and report the point, nothing else — no scroll restore, no dialog
       * arming, no occlusion check. Used to position the replay cursor without
       * performing any of the side effects the real step will perform itself.
       */
      pointOnly?: boolean;
    }
  | {
      /**
       * Drives the visible replay cursor in the TOP frame. Coordinates are top-frame
       * viewport pixels — the same space the input is dispatched in, so the cursor
       * is literally where the click goes.
       */
      type: "cs-cursor";
      action: "install" | "place" | "move" | "pulse" | "hide";
      x?: number;
      y?: number;
      durationMs?: number;
    }
  | { type: "cs-set-mode"; mode: TabMode };

/** Reply to cs-locate: where the input should land, in top-frame viewport pixels. */
export type LocateResult =
  | { ok: true; x: number; y: number; path?: { x: number; y: number }[] }
  | { ok: false; error: string };

export type TabMode = "off" | "record" | "replay";
