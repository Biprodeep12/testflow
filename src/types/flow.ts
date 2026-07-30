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
  target?: string; // "main" for the main frame
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
};

/** Pure-DevTools copy of the steps: TestFlow-only fields removed. */
export function exportSteps(steps: FlowStep[]): FlowStep[] {
  return steps.map((step) => {
    const rest = { ...step };
    delete rest.timestamp;
    delete rest.tagName;
    return rest;
  });
}

/** The exact top-level shape DevTools exports. */
export type FlowJson = {
  title: string;
  steps: FlowStep[];
  /** Native flow-level wait budget (ms); @puppeteer/replay defaults to 5000. */
  timeout?: number;
};

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
    }
  | { source: "tf-agent"; kind: "step"; step: FlowStep }
  | {
      source: "tf-agent";
      /** full session state — sent when the dashboard (re)connects mid-recording */
      kind: "snapshot";
      recording: boolean;
      steps: FlowStep[];
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
    };

/** dashboard page -> extension */
export type HubMessage =
  | { source: "tf-hub"; kind: "ping" }
  | { source: "tf-hub"; kind: "openAndRecord"; url: string }
  | { source: "tf-hub"; kind: "stop" }
  | { source: "tf-hub"; kind: "openForReplay"; url: string }
  | { source: "tf-hub"; kind: "runStep"; id: number; step: FlowStep }
  | { source: "tf-hub"; kind: "closeReplay" };

/* Content script <-> service worker (chrome.runtime messages) */

export type CsToSw =
  | {
      type: "cs-ready"; // page loaded in a tracked tab
      url: string;
      title: string;
      width: number;
      height: number;
      dpr: number;
    }
  | { type: "cs-step"; step: FlowStep }
  | { type: "cs-settled"; url: string }
  | { type: "cs-get-mode" };

export type SwToCs =
  | { type: "cs-run"; id: number; step: FlowStep }
  | { type: "cs-set-mode"; mode: TabMode };

export type TabMode = "off" | "record" | "replay";
