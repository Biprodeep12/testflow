/**
 * Content script — every page, every frame, document_start.
 *
 * Inert until the service worker says this tab is in "record" or "replay" mode, so
 * browsing normally costs nothing. Records interactions as DevTools-Recorder steps
 * (same selector engine as v2) and executes steps during replay. All traffic goes
 * through chrome.runtime — the page's CSP and origin are irrelevant, and it survives
 * every navigation because the browser re-injects it.
 */

import {
  MAX_UPLOAD_BYTES,
  type CsToSw,
  type DialogRecord,
  type FlowStep,
  type FrameLink,
  type LocateResult,
  type ScrollRecord,
  type StepMeta,
  type SwToCs,
  type TabMode,
} from "../shared/flow";
import { initFrames, myFrameChain, myViewportOffset } from "./frames";
import {
  cursorPosition,
  installCursor,
  moveCursorTo,
  placeCursor,
  pulseCursor,
  removeCursor,
} from "./cursor";

/** Default glide time; the cursor shortens it for short hops. */
const CURSOR_GLIDE_MS = 420;
import { resolveInPage } from "../../../src/shared/resolve";
import { captureEnv, capturePermissions } from "../../../src/shared/env";
import { evaluateKnownExpression } from "../../../src/shared/expressions";

let mode: TabMode = "off";
let stepCount = 0;
let badge: HTMLElement | null = null;

/**
 * This frame's chain, resolved once when the session turns on. Every recorded step
 * waits on this ONE promise, so `.then` callbacks fire in registration order and
 * step ordering survives even when the chain takes a moment to negotiate.
 */
let chainReady: Promise<FrameLink[]> = Promise.resolve([]);

/** Monotonic — immune to NTP steps, unlike Date.now(). */
const monoNow = (): number => performance.timeOrigin + performance.now();

const send = (msg: CsToSw): void => {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch {
    // Extension reloaded/updated under us — nothing sensible to do from the page.
  }
};

/* ---------------------------------------------------------------- *
 * Selector generation — DevTools Recorder's candidate set
 * ---------------------------------------------------------------- */

const cssEsc: (v: string) => string =
  window.CSS && CSS.escape ? CSS.escape : (v) => v.replace(/([^\w-])/g, "\\$1");

const norm = (t: string | null | undefined): string =>
  (t ?? "").replace(/\s+/g, " ").trim();

function accName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (norm(aria)) return norm(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (norm(text)) return norm(text);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const text = norm(labels[0].textContent);
    if (text) return text;
  }
  for (const attr of ["alt", "title", "placeholder"]) {
    const value = el.getAttribute(attr);
    if (norm(value)) return norm(value);
  }
  // textContent on a container serialises its whole subtree — on a listing page that
  // is tens of thousands of nodes, built only to be thrown away by the 60-character
  // limit below. childElementCount is O(1) and anything with a real accessible name
  // (button, link, label, input) is small.
  if (el.childElementCount > 8) return "";
  const text = norm(el.textContent);
  return text && text.length <= 60 ? text : "";
}

/**
 * 1-based position among same-tag siblings, or 0 when it is the only one.
 *
 * One pass, no array allocation — this runs once per ancestor, for every recorded
 * step, on the click handler's critical path.
 */
function nthOfType(node: Element): number {
  const parent = node.parentElement;
  if (!parent) return 0;
  let count = 0;
  let index = 0;
  for (const child of parent.children) {
    if (child.tagName !== node.tagName) continue;
    count++;
    if (child === node) index = count;
  }
  return count > 1 ? index : 0;
}

/**
 * The ancestor chain, walked ONCE.
 *
 * Both the CSS path and the XPath need each ancestor's position among its same-tag
 * siblings, and that scan is the expensive part: a leaf in a listing has a parent
 * with thousands of children. Walking twice doubled the cost of every recorded step
 * for no new information.
 *
 * Leaf-first. Stops at the first ancestor with an id, which is where both builders
 * would have stopped anyway.
 */
type PathNode = { tag: string; nth: number; id: string };

function ancestorPath(el: Element): PathNode[] {
  const path: PathNode[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    if (node.id) {
      path.push({ tag: node.tagName.toLowerCase(), nth: 0, id: node.id });
      break;
    }
    path.push({ tag: node.tagName.toLowerCase(), nth: nthOfType(node), id: "" });
    node = node.parentElement;
  }
  return path;
}

function cssFrom(el: Element, path: PathNode[]): string {
  if (el.classList.length > 0) {
    const classes = Array.from(el.classList).slice(0, 3).map(cssEsc);
    const short = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
    if (resolvesTo(short, el)) return short;
  }
  if (el.id) {
    const byId = `#${cssEsc(el.id)}`;
    if (resolvesTo(byId, el)) return byId;
  }
  const parts: string[] = [];
  for (const node of path) {
    if (node.id) {
      parts.unshift(`#${cssEsc(node.id)}`);
      break;
    }
    // The document root and <body> are implied by a descendant path.
    if (node.tag === "body" || node.tag === "html") break;
    parts.unshift(node.nth > 0 ? `${node.tag}:nth-of-type(${node.nth})` : node.tag);
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

function xpathFrom(path: PathNode[]): string {
  const parts: string[] = [];
  let anchor = "";
  for (const node of path) {
    if (node.id) {
      anchor = `//*[@id="${node.id}"]`;
      break;
    }
    parts.unshift(node.nth > 0 ? `${node.tag}[${node.nth}]` : node.tag);
  }
  return anchor
    ? anchor + (parts.length ? `/${parts.join("/")}` : "")
    : `/${parts.join("/")}`;
}

/** Escapes a value for use inside [attr="..."]. */
const attrEsc = (value: string): string => value.replace(/["\\]/g, "\\$&");

/**
 * True when this selector resolves to THIS element — which is exactly the question
 * replay asks, since resolution there is `document.querySelector(selector)`.
 *
 * Deliberately not `querySelectorAll(...).length === 1`: that walks the entire
 * document and materialises a NodeList for every candidate, on every recorded step,
 * inside a click handler. `querySelector` stops at the first match. On a large page
 * this is the difference between a recorder you notice and one you do not.
 */
function resolvesTo(selector: string, el: Element): boolean {
  try {
    return document.querySelector(selector) === el;
  } catch {
    return false;
  }
}

const TESTID_ATTRS = ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa"];

/**
 * As many independent descriptions of the element as it offers. Ordered most-durable
 * first — the order is also the tie-break during consensus replay and drives which
 * locator the Playwright export prefers.
 */
/**
 * Time spent describing elements since the last recorded step.
 *
 * Recording runs synchronously inside the page's own event handlers, so anything
 * slow here is felt directly as a sluggish page. Accumulated by selectorsFor and
 * read by record(), which reports it when it crosses the threshold below — a
 * measurement beats a hunch when someone says "it feels slow sometimes".
 */
let selectorMs = 0;

/** Above this, a step is slow enough for a person to notice. */
const SLOW_STEP_MS = 120;

function selectorsFor(el: Element): string[][] {
  const started = performance.now();
  const out = describeElement(el);
  selectorMs += performance.now() - started;
  return out;
}

function describeElement(el: Element): string[][] {
  const out: string[][] = [];
  const push = (selector: string): void => {
    if (resolvesTo(selector, el)) out.push([selector]);
  };

  // 1. Explicit test hooks — exist to be stable; strongest signal there is.
  for (const attr of TESTID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) {
      push(`[${attr}="${attrEsc(value)}"]`);
      break;
    }
  }

  // 2. Accessible name.
  const name = accName(el);
  if (name) out.push([`aria/${name}`]);

  // 3. Stable attributes browsers/forms rely on.
  const tag = el.tagName.toLowerCase();
  const nameAttr = el.getAttribute("name");
  if (nameAttr && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) {
    push(`${tag}[name="${attrEsc(nameAttr)}"]`);
  }
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) push(`${tag}[placeholder="${attrEsc(placeholder)}"]`);
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href && href !== "#") push(`a[href="${attrEsc(href)}"]`);
  }
  const title = el.getAttribute("title");
  if (title) push(`[title="${attrEsc(title)}"]`);

  // 4. Structure: CSS path, XPath, shadow-piercing variant — one ancestor walk.
  const path = ancestorPath(el);
  const css = cssFrom(el, path);
  if (css) out.push([css]);
  const xp = xpathFrom(path);
  if (xp) out.push([`xpath/${xp}`]);
  if (css) out.push([`pierce/${css}`]);

  // 5. Visible text — last resort. Leaf elements only, so textContent is small.
  if (el.childElementCount === 0) {
    const text = norm(el.textContent);
    if (text && text.length <= 60) out.push([`text/${text.slice(0, 25)}`]);
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Recording
 * ---------------------------------------------------------------- */

const SPECIAL_KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

function targetOf(event: Event): Element | null {
  const path = event.composedPath?.();
  const el = path && path.length > 0 ? path[0] : event.target;
  return el instanceof Element ? el : null;
}

/**
 * Containers the user has actually scrolled. Serializing THESE at step time is O(k)
 * in what the user touched — scanning the DOM for scrolled elements on every step
 * would be O(nodes) on the interaction path, which is exactly where cost is not
 * affordable.
 */
const scrolledContainers = new Set<Element>();

/**
 * Descriptions of elements that get re-described on every step.
 *
 * Scroll state names the same containers and the same anchor rows step after step,
 * and describing one costs a handful of document queries. The cache is VALIDATED
 * before reuse — one short-circuiting querySelector confirming the description still
 * points at the same element — so a page that moves things around gets a fresh
 * description rather than a stale one.
 */
const describeCache = new WeakMap<Element, string[][]>();

function describe(el: Element): string[][] {
  const cached = describeCache.get(el);
  if (cached) {
    const check = cached.find((group) => {
      const selector = group[0];
      return (
        selector &&
        !selector.startsWith("aria/") &&
        !selector.startsWith("text/") &&
        !selector.startsWith("xpath/") &&
        !selector.startsWith("pierce/")
      );
    })?.[0];
    if (check && resolvesTo(check, el)) return cached;
  }
  const fresh = selectorsFor(el);
  describeCache.set(el, fresh);
  return fresh;
}

/**
 * What is at the top of a scrolled container, and how far past it we are.
 *
 * This is the position in CONTENT rather than in pixels — the only description that
 * survives a virtualized list whose rows are recycled, or an infinite feed that
 * loaded a different number of items this time.
 */
function anchorFor(container: Element): ScrollRecord["anchor"] {
  // Measured against the CONTENT box: getBoundingClientRect() includes the border,
  // and replay resolves the anchor the same way. Both sides must agree or every
  // restore is off by the border width.
  const box = container.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(container).borderTopWidth) || 0;
  const contentTop = box.top + border;
  // Rows are often wrapped in a sizer element rather than being direct children.
  const rows =
    container.children.length === 1 && container.firstElementChild!.children.length > 1
      ? Array.from(container.firstElementChild!.children)
      : Array.from(container.children);
  for (const child of rows) {
    const rect = child.getBoundingClientRect();
    // The first row whose bottom edge is still below the container's content top.
    if (rect.bottom > contentTop) {
      const selectors = describe(child);
      if (selectors.length === 0) return undefined;
      return { selectors, offsetY: Math.round(contentTop - rect.top) };
    }
  }
  return undefined;
}

function captureScrollState(): ScrollRecord[] {
  const out: ScrollRecord[] = [];
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    out.push({
      selectors: null,
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
    });
  }
  for (const el of scrolledContainers) {
    if (!el.isConnected) {
      scrolledContainers.delete(el);
      continue;
    }
    if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
    out.push({
      selectors: describe(el),
      x: Math.round(el.scrollLeft),
      y: Math.round(el.scrollTop),
      anchor: anchorFor(el),
    });
  }
  return out;
}

/**
 * True when the element offered nothing but its position in the tree. Such a step
 * replays correctly today and breaks on the next markup change, so the recording
 * says so rather than letting replay discover it.
 */
function isPositionalOnly(selectors: string[][]): boolean {
  return selectors.every((group) => {
    const selector = group[0] ?? "";
    return (
      !selector.startsWith("aria/") &&
      !selector.startsWith("text/") &&
      !selector.startsWith("[data-") &&
      !selector.includes("[name=") &&
      !selector.includes("[placeholder=")
    );
  });
}

function record(step: FlowStep, el?: Element, extra?: Partial<StepMeta>): void {
  stepCount++;
  updateBadge();
  // selectorsFor already ran in the caller; this picks up what it cost.
  const describeMs = selectorMs;
  selectorMs = 0;
  const started = performance.now();
  const rect = el?.getBoundingClientRect();
  const selectors = step.selectors ?? [];
  const meta: Omit<StepMeta, "targetId"> = {
    frameChain: [], // filled in below, once this frame knows where it is
    tMono: monoNow(),
    rect: rect
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : undefined,
    scrollState: captureScrollState(),
    ...(selectors.length > 0 && isPositionalOnly(selectors)
      ? { degraded: "positional-only" as const }
      : {}),
    ...extra,
  };
  // Reported, not silently absorbed: this all runs inside the page's own event
  // handler, so if it is slow the page IS slow, and the breakdown says which half.
  const stateMs = performance.now() - started;
  if (describeMs + stateMs > SLOW_STEP_MS) {
    console.warn(
      `[TestFlow] recording this ${step.type} took ${Math.round(describeMs + stateMs)}ms ` +
        `(describing the element ${Math.round(describeMs)}ms, scroll state ${Math.round(stateMs)}ms). ` +
        `The page will feel sluggish while recording.`,
    );
  }

  // One shared promise → callbacks run in registration order → steps stay ordered.
  void chainReady.then((frameChain) => {
    send({ type: "cs-step", step, meta: { ...meta, frameChain } });
  });
}

/* ---------------------------------------------------------------- *
 * Drag — pointerdown -> moves -> pointerup with real displacement. Map panning,
 * sliders, drag-to-reorder. The cursor path is sampled (relative to the start
 * point) so replay retraces YOUR movement, not a straight line.
 * ---------------------------------------------------------------- */

const DRAG_THRESHOLD_PX = 5;
const DRAG_SAMPLE_MS = 40;
const DRAG_MAX_POINTS = 40;

let dragState: {
  el: Element;
  startClientX: number;
  startClientY: number;
  offsetX: number;
  offsetY: number;
  path: { x: number; y: number }[];
  moved: boolean;
  startedAt: number;
  lastSampleAt: number;
} | null = null;
/** After a drag, the browser still fires a click on pointerup — swallow it. */
let suppressClickUntil = 0;

/**
 * Native HTML5 drag-and-drop, if the browser started one during this gesture.
 *
 * A pointer drag and a native drag look identical in pointer events but replay
 * completely differently: the drag machinery only starts for REAL input, so a
 * synthetic replay of a native drag moves a cursor and drops nothing at all. The
 * recording captures which one it was so that limitation is stated, not discovered.
 */
let pendingNativeDrag: { types: string[] } | null = null;

document.addEventListener(
  "dragstart",
  () => {
    if (mode !== "record") return;
    pendingNativeDrag = { types: [] };
    // Once the drag machinery takes over, pointermove stops firing — so the gesture
    // would never register as "moved" and the whole drag would go unrecorded. A
    // dragstart IS the movement threshold being crossed.
    if (dragState) dragState.moved = true;
  },
  true, // capture: this must happen whatever the page does with the event
);

/**
 * The payload, read AFTER the page's own handler. dataTransfer is empty during the
 * capture phase — setData() is exactly what the source element's dragstart handler
 * is for, and it has not run yet.
 */
document.addEventListener(
  "dragstart",
  (event) => {
    if (mode !== "record" || !pendingNativeDrag) return;
    pendingNativeDrag.types = Array.from(
      (event as DragEvent).dataTransfer?.types ?? [],
    );
  },
  false,
);

/**
 * The path, during a native drag. `drag` fires on the source element in place of
 * pointermove, which the drag machinery has stopped delivering.
 */
document.addEventListener(
  "drag",
  (event) => {
    if (!dragState || !event.isTrusted) return;
    // Chrome reports (0,0) on some drag events (notably the last one); those are
    // not a position, and taking them would record a jump to the page corner.
    if (event.clientX === 0 && event.clientY === 0) return;
    const dx = event.clientX - dragState.startClientX;
    const dy = event.clientY - dragState.startClientY;
    const now = Date.now();
    if (
      now - dragState.lastSampleAt >= DRAG_SAMPLE_MS &&
      dragState.path.length < DRAG_MAX_POINTS
    ) {
      dragState.lastSampleAt = now;
      dragState.path.push({ x: Math.round(dx), y: Math.round(dy) });
    }
  },
  true,
);

document.addEventListener(
  "pointerdown",
  (event) => {
    if (mode !== "record" || !event.isTrusted || event.button !== 0) return;
    const el = targetOf(event);
    if (!el || el.closest("#__tf_badge")) return;
    dragState = {
      el,
      startClientX: event.clientX,
      startClientY: event.clientY,
      offsetX: event.offsetX,
      offsetY: event.offsetY,
      path: [],
      moved: false,
      startedAt: Date.now(),
      lastSampleAt: 0,
    };
  },
  true,
);

document.addEventListener(
  "pointermove",
  (event) => {
    if (!dragState || !event.isTrusted) return;
    const dx = event.clientX - dragState.startClientX;
    const dy = event.clientY - dragState.startClientY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragState.moved = true;
    const now = Date.now();
    if (
      now - dragState.lastSampleAt >= DRAG_SAMPLE_MS &&
      dragState.path.length < DRAG_MAX_POINTS
    ) {
      dragState.lastSampleAt = now;
      dragState.path.push({ x: Math.round(dx), y: Math.round(dy) });
    }
  },
  true,
);

function finishDrag(endX: number, endY: number): void {
  const drag = dragState;
  dragState = null;
  const native = pendingNativeDrag;
  pendingNativeDrag = null;
  if (!drag || !drag.moved || mode !== "record") return;

  const dx = Math.round(endX - drag.startClientX);
  const dy = Math.round(endY - drag.startClientY);
  const last = drag.path[drag.path.length - 1];
  if (!last || last.x !== dx || last.y !== dy) drag.path.push({ x: dx, y: dy });
  flushWheel();
  record(
    {
      type: "drag",
      selectors: selectorsFor(drag.el),
      offsetX: drag.offsetX,
      offsetY: drag.offsetY,
      path: drag.path,
      duration: Date.now() - drag.startedAt,
    },
    drag.el,
    native ? { nativeDrag: native } : undefined,
  );
  suppressClickUntil = Date.now() + 200;
}

document.addEventListener(
  "pointerup",
  (event) => {
    if (!event.isTrusted) {
      dragState = null;
      return;
    }
    finishDrag(event.clientX, event.clientY);
  },
  true,
);

/**
 * A native drag captures the pointer, so pointerup never arrives — `dragend` is the
 * only end-of-gesture signal there is. Without this listener an HTML5 drag records
 * nothing at all.
 */
document.addEventListener(
  "dragend",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    finishDrag(event.clientX, event.clientY);
  },
  true,
);

// The browser hands scrolling to the compositor on touch-pan and fires
// pointercancel — that gesture is a scroll, not a drag. But it ALSO cancels the
// pointer when a native drag takes over, and discarding the gesture there would
// throw away the drag that is about to happen.
document.addEventListener(
  "pointercancel",
  () => {
    if (pendingNativeDrag) return;
    dragState = null;
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    if (Date.now() < suppressClickUntil) return; // tail click of a recorded drag
    const el = targetOf(event);
    if (!el || el.closest("#__tf_badge")) return;
    flushWheel(); // a pending wheel burst must land BEFORE this click in the flow
    const download = downloadFor(el);
    record(
      {
        type: "click",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      },
      el,
      download ? { download } : undefined,
    );
  },
  true,
);

// Right-click — a click step with the NATIVE DevTools `button` field.
document.addEventListener(
  "contextmenu",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    const el = targetOf(event);
    if (!el || el.closest("#__tf_badge")) return;
    record(
      {
        type: "click",
        button: "secondary",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      },
      el,
    );
  },
  true,
);

document.addEventListener(
  "dblclick",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    const el = targetOf(event);
    if (!el) return;
    record(
      {
        type: "doubleClick",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY,
      },
      el,
    );
  },
  true,
);

/**
 * The file a click is about to download, when the page says so itself.
 *
 * `<a download="report.csv">` is the answer at the source — exact, available before
 * the download even starts, and independent of how the browser later names the file
 * on disk. The service worker's downloads listener covers the JS-initiated case; it
 * cannot do better than this one for links.
 */
function downloadFor(el: Element): { filename: string } | undefined {
  const anchor = el.closest("a[download]") as HTMLAnchorElement | null;
  if (!anchor) return undefined;
  const explicit = anchor.getAttribute("download");
  if (explicit) return { filename: explicit };
  // download with no value: the browser names it from the URL path.
  try {
    const name = new URL(anchor.href, location.href).pathname.split("/").pop();
    return name ? { filename: name } : undefined;
  } catch {
    return undefined;
  }
}

/** A stable name for the secret this field wants — how replay is asked for it. */
function secretNameFor(el: Element): string {
  const name =
    el.getAttribute("name") ||
    el.getAttribute("id") ||
    accName(el) ||
    "password";
  return name.replace(/[^\w]+/g, "_").toUpperCase().slice(0, 40);
}

/**
 * File inputs. The bytes are carried in the flow (capped) because a replay that
 * cannot supply the file is not a replay of the same flow — but a recording is not
 * an asset store either, so anything larger keeps its name and is marked degraded.
 */
async function recordUpload(input: HTMLInputElement): Promise<void> {
  const files = Array.from(input.files ?? []);
  const selectors = selectorsFor(input);
  if (files.length === 0) return;

  let truncated = false;
  const encoded: { name: string; mimeType: string; base64: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      truncated = true;
      encoded.push({ name: file.name, mimeType: file.type, base64: "" });
      continue;
    }
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        resolve(result.slice(result.indexOf(",") + 1)); // strip the data: prefix
      };
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
    encoded.push({ name: file.name, mimeType: file.type, base64 });
  }

  record(
    { type: "change", value: "", selectors, tagName: "input" },
    input,
    {
      upload: { files: encoded, truncated },
      ...(truncated ? { degraded: "upload-truncated" as const } : {}),
    },
  );
}

// `change` fires once per committed edit — one step per field, DevTools granularity.
document.addEventListener(
  "change",
  (event) => {
    if (mode !== "record") return;
    const el = targetOf(event);
    if (!el) return;
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (["checkbox", "radio", "button", "submit", "reset"].includes(type)) return; // clicks
    if (type === "file") {
      // The ONE place trust is not required. Picking a file produces no trusted
      // change event under automation, and a page cannot open a file picker on its
      // own — so the risk this gate exists to stop does not apply here, while
      // enforcing it would mean uploads can never be recorded except by hand.
      void recordUpload(el as HTMLInputElement);
      return;
    }
    if (!event.isTrusted) return;
    record(
      {
        type: "change",
        // Passwords are recorded with an empty value — the secret never leaves the page.
        value: type === "password" ? "" : String((el as HTMLInputElement).value ?? ""),
        selectors: selectorsFor(el),
        // Playwright codegen needs this: fill() throws on <select>. Stripped on export.
        tagName: tag.toLowerCase(),
      },
      el,
      // A password step carries a NAME, not a value: replay supplies the secret and
      // says which one is missing if it cannot, instead of typing "" and passing.
      type === "password" ? { secretRef: secretNameFor(el) } : undefined,
    );
  },
  true,
);

/* Keyboard: special keys, shortcuts, and press-AND-HOLD.
 *
 * DevTools models holds natively — keyDown and keyUp are separate steps — so a
 * combo records as: keyDown Control -> keyDown b -> keyUp b -> keyUp Control, and
 * "As recorded" replay even reproduces hold durations via step timestamps.
 *
 * Modifiers are captured LAZILY: a modifier's keyDown is emitted only at the moment
 * it modifies a recordable key — so holding Shift while typing text stays silent
 * (the change step owns typing), but Ctrl+B records the full sequence. */

const MODIFIER_KEYS = ["Control", "Alt", "Meta", "Shift"];
/** modifiers whose keyDown we emitted — their keyUp must close the hold */
const openModifiers = new Set<string>();
/** non-modifier keys whose keyDown we emitted — keyUp mirrors exactly these */
const openKeys = new Set<string>();

function isRecordableKey(event: KeyboardEvent): boolean {
  if (SPECIAL_KEYS.includes(event.key)) return true;
  // Any key becomes recordable under a shortcut modifier (Ctrl/Alt/Meta —
  // not bare Shift, which is just capitalisation).
  return event.ctrlKey || event.altKey || event.metaKey;
}

function emitHeldModifiers(event: KeyboardEvent): void {
  const active: [string, boolean][] = [
    ["Control", event.ctrlKey],
    ["Alt", event.altKey],
    ["Meta", event.metaKey],
    ["Shift", event.shiftKey],
  ];
  for (const [key, held] of active) {
    if (held && !openModifiers.has(key)) {
      openModifiers.add(key);
      record({ type: "keyDown", key });
    }
  }
}

document.addEventListener(
  "keydown",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    if (MODIFIER_KEYS.includes(event.key)) return; // lazy — see above
    if (!isRecordableKey(event)) return;
    emitHeldModifiers(event);
    openKeys.add(event.key);
    record({ type: "keyDown", key: event.key });
  },
  true,
);

document.addEventListener(
  "keyup",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    if (MODIFIER_KEYS.includes(event.key)) {
      // Close the hold only if we opened it.
      if (openModifiers.delete(event.key)) {
        record({ type: "keyUp", key: event.key });
      }
      return;
    }
    // Mirror exactly the downs we recorded — modifier state at keyup time is
    // irrelevant (Ctrl may already be released when `b` comes up).
    if (openKeys.delete(event.key)) {
      record({ type: "keyUp", target: "main", key: event.key });
    }
  },
  true,
);

/* ---------------------------------------------------------------- *
 * Scroll — record USER scrolls only.
 *
 * A scroll event is isTrusted:true no matter who caused it, so the event itself
 * can't tell a wheel flick from the site calling scrollTo()/scrollIntoView(). What
 * CAN: the input that produces scrolling — wheel / touchmove / scroll keys are only
 * trusted from a real human. So a scroll is recorded only if it lands inside a
 * short window after such input. Known gap: dragging the scrollbar with the mouse
 * produces no wheel events and is therefore not captured.
 * ---------------------------------------------------------------- */

const SCROLL_KEYS = [" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"];

let userScrollIntentUntil = 0;
const bumpIntent = (ms: number): void => {
  userScrollIntentUntil = Math.max(userScrollIntentUntil, Date.now() + ms);
};

/* Consumed-wheel capture: a map/carousel/canvas calls preventDefault() on wheel and
 * ZOOMS — no scroll event ever fires, so the scroll recorder can't see it. Track the
 * wheel burst; if it produced no scroll, it was consumed → record a `wheel` step
 * (TestFlow extension — the DevTools schema has no wheel step at all). */
let lastScrollEventAt = 0;
let wheelAcc: {
  el: Element;
  deltaX: number;
  deltaY: number;
  offsetX: number;
  offsetY: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

function flushWheel(): void {
  if (!wheelAcc) return;
  const acc = wheelAcc;
  clearTimeout(acc.timer);
  wheelAcc = null;
  if (mode !== "record") return;
  // A scroll during the burst means this was ordinary scrolling — the scroll
  // recorder owns it. Only the consumed case becomes a wheel step.
  if (lastScrollEventAt >= acc.startedAt) return;
  record(
    {
      type: "wheel",
      selectors: selectorsFor(acc.el),
      deltaX: Math.round(acc.deltaX),
      deltaY: Math.round(acc.deltaY),
      offsetX: acc.offsetX,
      offsetY: acc.offsetY,
    },
    acc.el,
  );
}

window.addEventListener(
  "wheel",
  (event) => {
    if (!event.isTrusted) return;
    bumpIntent(250);
    if (mode !== "record") return;
    const el = targetOf(event);
    if (!el || el.closest("#__tf_badge")) return;
    if (wheelAcc && wheelAcc.el !== el) flushWheel(); // moved to another element
    if (wheelAcc) {
      clearTimeout(wheelAcc.timer);
      wheelAcc.deltaX += event.deltaX;
      wheelAcc.deltaY += event.deltaY;
      // Zoom centers on the cursor — keep the latest position.
      wheelAcc.offsetX = event.offsetX;
      wheelAcc.offsetY = event.offsetY;
      wheelAcc.timer = setTimeout(flushWheel, 400);
    } else {
      wheelAcc = {
        el,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        offsetX: event.offsetX,
        offsetY: event.offsetY,
        startedAt: Date.now(),
        timer: setTimeout(flushWheel, 400),
      };
    }
  },
  { capture: true, passive: true },
);
window.addEventListener(
  "touchmove",
  (event) => {
    if (event.isTrusted) bumpIntent(250);
  },
  { capture: true, passive: true },
);
document.addEventListener(
  "keydown",
  (event) => {
    // Keyboard scrolls animate smoothly well after the keypress — longer window.
    if (event.isTrusted && SCROLL_KEYS.includes(event.key)) bumpIntent(700);
  },
  true,
);

let scrollTimer: ReturnType<typeof setTimeout> | null = null;
// The browser routes a wheel to the container UNDER THE CURSOR; that container is
// what fires the scroll event, so capturing event.target preserves "where the
// cursor was" without storing coordinates. null = the document itself.
// A Set, because one burst can scroll several containers (nested scroll chaining:
// the feed under the cursor hits bottom, then the page takes over) — each gets its
// own step, in the order it first scrolled.
const pendingScrollTargets = new Set<Element | null>();

document.addEventListener(
  "scroll",
  (event) => {
    if (!event.isTrusted) return;
    lastScrollEventAt = Date.now(); // tells the wheel path "this wasn't consumed"
    // Remember every container that has ever scrolled — user-driven or not. The
    // rendered page depends on ALL of their offsets, so the scroll state a step
    // carries must include containers the site scrolled on its own.
    if (event.target instanceof Element) scrolledContainers.add(event.target);
    if (mode !== "record") return;
    if (Date.now() > userScrollIntentUntil) return; // site-initiated — ignore
    pendingScrollTargets.add(
      event.target instanceof Element ? event.target : null,
    );
    // Debounce: one step per container per burst, holding the FINAL positions.
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (mode !== "record") {
        pendingScrollTargets.clear();
        return;
      }
      for (const target of pendingScrollTargets) {
        if (target) {
          record(
            {
              type: "scroll",
              selectors: selectorsFor(target),
              x: Math.round(target.scrollLeft),
              y: Math.round(target.scrollTop),
            },
            target,
          );
        } else {
          record({
            type: "scroll",
            x: Math.round(window.scrollX),
            y: Math.round(window.scrollY),
          });
        }
      }
      pendingScrollTargets.clear();
    }, 350);
  },
  { capture: true, passive: true },
);

/* ---------------------------------------------------------------- *
 * Replay
 * ---------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Element resolution is the SHARED implementation (src/shared/resolve.ts) — the
 * Playwright runner ships the same function into the page. Two copies would
 * eventually resolve the same step to two different elements, which is precisely
 * the browser-vs-Playwright divergence this system exists to remove.
 */
function resolveEl(groups: string[][], timeoutMs: number): Promise<Element | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = (): void => {
      const el = resolveInPage({ selectors: groups });
      if (el) return resolve(el);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(poll, 120);
    };
    poll();
  });
}

/** Puts every recorded scroll container back where it was when the step ran. */
function restoreScrollState(state: ScrollRecord[] | undefined): void {
  for (const entry of state ?? []) {
    if (!entry.selectors) {
      window.scrollTo(entry.x, entry.y);
      continue;
    }
    const el = resolveInPage({ selectors: entry.selectors });
    if (el) el.scrollTo(entry.x, entry.y);
  }
}

/**
 * Evaluates an expression in the PAGE's world (the isolated world's CSP forbids
 * eval) and polls until it is truthy or the budget runs out.
 */
function waitForExpression(expression: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  let seq = 0;
  const evaluate = (): Promise<{ ok: boolean; value: boolean; error?: string }> =>
    new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        window.removeEventListener("__tf_expr_result", onResult);
        resolve({ ok: false, value: false, error: "main world did not answer" });
      }, 1000);
      function onResult(event: Event): void {
        try {
          const detail = (event as CustomEvent).detail;
          if (typeof detail !== "string") return;
          const payload = JSON.parse(detail) as {
            id: number;
            ok: boolean;
            value: boolean;
            error?: string;
          };
          if (payload.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener("__tf_expr_result", onResult);
          resolve(payload);
        } catch {
          /* malformed — let the timeout handle it */
        }
      }
      window.addEventListener("__tf_expr_result", onResult);
      window.dispatchEvent(
        new CustomEvent("__tf_expr", { detail: JSON.stringify({ id, expression }) }),
      );
    });

  const started = Date.now();
  return new Promise((resolve) => {
    const poll = async (): Promise<void> => {
      // The recorder's own assertions need no evaluator, so they work on pages
      // that forbid one.
      const known = evaluateKnownExpression(expression);
      const result =
        known === undefined
          ? await evaluate()
          : { ok: true, value: known, error: undefined };

      if (result.ok && result.value) return resolve({ ok: true });
      if (Date.now() - started > timeoutMs) {
        const cspBlocked = (result.error ?? "").includes("unsafe-eval");
        return resolve({
          ok: false,
          error: cspBlocked
            ? "this page's Content-Security-Policy forbids evaluating expressions, and this one is not a recorded route assertion. Replay it in Playwright, or run it in a tab the extension can attach its debugger to."
            : (result.error ?? "expression never became true"),
        });
      }
      setTimeout(() => void poll(), 120);
    };
    void poll();
  });
}

function fire(
  el: Element,
  Ctor: typeof MouseEvent | typeof KeyboardEvent | typeof WheelEvent | typeof Event,
  type: string,
  init: Record<string, unknown>,
): void {
  try {
    el.dispatchEvent(
      new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }),
    );
  } catch {
    /* a hostile page can seal prototypes; skip rather than crash the run */
  }
}

function clickPoint(el: Element, step: FlowStep): { cx: number; cy: number } {
  const rect = el.getBoundingClientRect();
  const cx =
    rect.left +
    (typeof step.offsetX === "number" && step.offsetX <= rect.width
      ? step.offsetX
      : rect.width / 2);
  const cy =
    rect.top +
    (typeof step.offsetY === "number" && step.offsetY <= rect.height
      ? step.offsetY
      : rect.height / 2);
  return { cx, cy };
}

async function doClick(el: Element, step: FlowStep, dbl: boolean): Promise<void> {
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    /* detached mid-scroll */
  }
  await sleep(80);
  const { cx, cy } = clickPoint(el, step);
  const PE = window.PointerEvent ?? MouseEvent;

  // Hover pre-events: menus/tooltips that open on hover need these before the
  // press lands, exactly as a real cursor would deliver them.
  const hoverInit = { clientX: cx, clientY: cy, view: window };
  fire(el, PE, "pointerover", hoverInit);
  fire(el, MouseEvent, "mouseover", hoverInit);
  fire(el, MouseEvent, "mousemove", hoverInit);

  if (step.button === "secondary") {
    const init = { clientX: cx, clientY: cy, button: 2, detail: 1, view: window };
    fire(el, PE, "pointerdown", init);
    fire(el, MouseEvent, "mousedown", init);
    fire(el, PE, "pointerup", init);
    fire(el, MouseEvent, "mouseup", init);
    fire(el, MouseEvent, "contextmenu", init);
    return;
  }

  const init = { clientX: cx, clientY: cy, button: 0, detail: 1, view: window };
  fire(el, PE, "pointerdown", init);
  fire(el, MouseEvent, "mousedown", init);
  try {
    (el as HTMLElement).focus?.();
  } catch {
    /* not focusable */
  }
  fire(el, PE, "pointerup", init);
  fire(el, MouseEvent, "mouseup", init);
  fire(el, MouseEvent, "click", init);
  if (dbl) fire(el, MouseEvent, "dblclick", { ...init, detail: 2 });
}

async function doDrag(el: Element, step: FlowStep): Promise<void> {
  const { cx, cy } = clickPoint(el, step);
  const PE = window.PointerEvent ?? MouseEvent;
  const path = step.path?.length ? step.path : [{ x: 0, y: 0 }];
  // Pace the retrace over the recorded duration, clamped to sane per-point gaps.
  const gap = Math.min(
    Math.max((step.duration ?? 300) / path.length, 5),
    40,
  );

  fire(el, PE, "pointerover", { clientX: cx, clientY: cy, view: window });
  fire(el, MouseEvent, "mouseover", { clientX: cx, clientY: cy, view: window });
  const downInit = { clientX: cx, clientY: cy, button: 0, view: window };
  fire(el, PE, "pointerdown", downInit);
  fire(el, MouseEvent, "mousedown", downInit);

  let lastX = cx;
  let lastY = cy;
  for (const point of path) {
    lastX = cx + point.x;
    lastY = cy + point.y;
    const moveInit = { clientX: lastX, clientY: lastY, button: 0, view: window };
    fire(el, PE, "pointermove", moveInit);
    fire(el, MouseEvent, "mousemove", moveInit);
    await sleep(gap);
  }

  const upInit = { clientX: lastX, clientY: lastY, button: 0, view: window };
  fire(el, PE, "pointerup", upInit);
  fire(el, MouseEvent, "mouseup", upInit);
  // Deliberately NO click — a drag is not a click, and pages debounce on that.
}

function setNativeValue(el: Element, value: string): void {
  // React tracks the value setter — go through the prototype's native one.
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else (el as HTMLInputElement).value = value;
}

/** Keys currently held during replay — keyDown adds, keyUp removes. */
const heldKeys = new Set<string>();

/**
 * Real keyboard events carry THREE identities — key ("b"), code ("KeyB"), and
 * legacy keyCode/which (66) — and handlers in the wild check any of them. Derive
 * code+keyCode from the recorded key so all three match a physical press.
 */
const KEY_INFO: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Meta: { code: "MetaLeft", keyCode: 91 },
};

function keyInfo(key: string): { code: string; keyCode: number } {
  const known = KEY_INFO[key];
  if (known) return known;
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(key)) {
    return { code: `Digit${key}`, keyCode: 48 + Number(key) };
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return { code: key, keyCode: 111 + Number(key.slice(1)) };
  }
  return { code: key, keyCode: 0 };
}

/** Per-step wait budget: native `timeout` field, clamped like @puppeteer/replay. */
function budgetOf(step: FlowStep): number {
  const t = typeof step.timeout === "number" ? step.timeout : 5000;
  return Math.min(Math.max(t, 500), 30000);
}

async function execStep(
  step: FlowStep,
  meta?: StepMeta,
): Promise<{ ok: boolean; error?: string }> {
  // Put the page back where it was before acting. Without this, an element that
  // was mid-viewport during recording is acted on at a different scroll offset and
  // every subsequent frame differs — the action succeeds, the picture doesn't match.
  if (meta?.scrollState?.length && step.type !== "scroll") {
    restoreScrollState(meta.scrollState);
  }
  // The answer has to be in place BEFORE the action, because confirm() blocks the
  // moment the page's handler calls it.
  if (meta?.dialog) armDialog(meta.dialog);
  if (meta?.upload) {
    // The page owns its file input; nothing in an isolated world can put bytes into
    // it. Reported rather than silently skipped — the Playwright runner can.
    return {
      ok: false,
      error: "file uploads cannot be replayed in-browser — run this flow in Playwright",
    };
  }

  switch (step.type) {
    case "setViewport":
      return { ok: true }; // a tab can't resize itself — informational
    case "navigate":
      if (norm(location.href) !== norm(step.url ?? "")) {
        location.assign(step.url ?? "");
      }
      return { ok: true };
    case "scroll": {
      // With selectors it's a scroll container; without, the document.
      if (step.selectors?.length) {
        const el = await resolveEl(step.selectors, budgetOf(step));
        if (!el) return { ok: false, error: "scroll container not found" };
        el.scrollTo({ left: step.x ?? 0, top: step.y ?? 0 });
      } else {
        window.scrollTo(step.x ?? 0, step.y ?? 0);
      }
      return { ok: true };
    }
    case "keyDown":
    case "keyUp": {
      const key = step.key ?? "";
      // Hold state: keys stay "down" between their keyDown and keyUp steps, so a
      // keydown of `b` while Control is held carries ctrlKey:true — how shortcut
      // handlers actually detect combos.
      if (step.type === "keyDown") heldKeys.add(key);
      else heldKeys.delete(key);
      // Dispatched by the MAIN-world helper, not here: a keyCode/which override
      // made in this isolated world is invisible to page handlers — the event
      // must be constructed in the page's own world to carry all three key
      // identities (key, code, keyCode). Payload is a JSON string because only
      // primitives cross the world boundary.
      const info = keyInfo(key);
      try {
        window.dispatchEvent(
          new CustomEvent("__tf_kbd", {
            detail: JSON.stringify({
              type: step.type === "keyDown" ? "keydown" : "keyup",
              key,
              code: info.code,
              keyCode: info.keyCode,
              ctrlKey: heldKeys.has("Control"),
              altKey: heldKeys.has("Alt"),
              metaKey: heldKeys.has("Meta"),
              shiftKey: heldKeys.has("Shift"),
            }),
          }),
        );
      } catch {
        /* nothing sensible to do — the run continues */
      }
      return { ok: true };
    }
    case "wheel": {
      // Consumed-wheel replay (map zoom etc.): real WheelEvents at the recorded
      // cursor offsets, chunked ±120 like a physical wheel — map libraries clamp
      // huge single deltas to one zoom notch, so one big event would under-zoom.
      const el = await resolveEl(step.selectors ?? [], budgetOf(step));
      if (!el) return { ok: false, error: "wheel target not found" };
      const rect = el.getBoundingClientRect();
      const cx =
        rect.left +
        (typeof step.offsetX === "number" && step.offsetX <= rect.width
          ? step.offsetX
          : rect.width / 2);
      const cy =
        rect.top +
        (typeof step.offsetY === "number" && step.offsetY <= rect.height
          ? step.offsetY
          : rect.height / 2);
      fire(el, MouseEvent, "mousemove", { clientX: cx, clientY: cy, view: window });
      const total = { x: step.deltaX ?? 0, y: step.deltaY ?? 0 };
      const chunks = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(total.x), Math.abs(total.y)) / 120),
      );
      for (let i = 0; i < chunks; i++) {
        fire(el, WheelEvent, "wheel", {
          clientX: cx,
          clientY: cy,
          deltaX: total.x / chunks,
          deltaY: total.y / chunks,
          deltaMode: 0,
          view: window,
        });
        await sleep(40);
      }
      return { ok: true };
    }
    case "waitForElement": {
      const el = await resolveEl(step.selectors ?? [], budgetOf(step));
      return el ? { ok: true } : { ok: false, error: "element never appeared" };
    }
    case "waitForExpression":
      // How SPA route changes replay: the recorder writes a location assertion, so
      // the wait is tied to page STATE, never to a sleep.
      return waitForExpression(step.expression ?? "true", budgetOf(step));
    case "click":
    case "doubleClick": {
      const el = await resolveEl(step.selectors ?? [], budgetOf(step));
      if (!el) return { ok: false, error: "no selector matched" };
      await doClick(el, step, step.type === "doubleClick");
      return { ok: true };
    }
    case "drag": {
      const el = await resolveEl(step.selectors ?? [], budgetOf(step));
      if (!el) return { ok: false, error: "drag target not found" };
      await doDrag(el, step);
      return { ok: true };
    }
    case "change": {
      if (meta?.secretRef) {
        // The recorder never captured this value, and there is nowhere safe to keep
        // one in a browser extension. Typing the empty string here and reporting
        // success would "pass" while logging in as nobody — the precise failure the
        // secret reference exists to prevent.
        return {
          ok: false,
          error: `this step needs the secret "${meta.secretRef}", which is not stored in the flow — replay it in Playwright: npm run flow -- <file> --secret ${meta.secretRef}=…`,
        };
      }
      const el = await resolveEl(step.selectors ?? [], budgetOf(step));
      if (!el) return { ok: false, error: "no selector matched" };
      try {
        (el as HTMLElement).focus?.();
      } catch {
        /* not focusable */
      }
      setNativeValue(el, step.value ?? "");
      fire(el, Event, "input", {});
      fire(el, Event, "change", {});
      return { ok: true };
    }
    default:
      return { ok: true }; // unknown step types skip, not fail
  }
}

/**
 * Phase one of real-input replay: resolve the element and report WHERE to aim, in
 * top-frame viewport coordinates. The service worker dispatches the input itself
 * over CDP, so the page receives a trusted event with real hover, focus and native
 * scrolling — none of which a dispatchEvent() can produce.
 */
async function locate(
  step: FlowStep,
  meta?: StepMeta,
  pointOnly?: boolean,
): Promise<LocateResult> {
  // pointOnly exists so the cursor can be positioned without performing any of the
  // side effects the real step is about to perform — arming a dialog twice would
  // queue two answers for one question.
  if (!pointOnly) {
    if (meta?.scrollState?.length && step.type !== "scroll") {
      restoreScrollState(meta.scrollState);
    }
    if (meta?.dialog) armDialog(meta.dialog);
  }

  // The cursor is cosmetic: it must never add a second of latency to a step whose
  // element is not there yet, since the real step is about to wait properly anyway.
  const el = await resolveEl(step.selectors ?? [], pointOnly ? 350 : budgetOf(step));
  if (!el) return { ok: false, error: "no selector matched" };

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return { ok: false, error: "element has no layout box" };
  }
  // Off-screen elements cannot receive real input at all — the cursor would land
  // on whatever is actually there.
  const outside =
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth;
  if (outside) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      /* detached mid-scroll */
    }
    await sleep(60);
  }

  const box = el.getBoundingClientRect();
  const within = (value: number | undefined, size: number): number =>
    typeof value === "number" && value >= 0 && value <= size ? value : size / 2;
  const localX = box.left + within(step.offsetX, box.width);
  const localY = box.top + within(step.offsetY, box.height);

  // Occlusion. Real input lands on whatever is topmost at that pixel, so a sticky
  // header or cookie bar over the target absorbs the click and the step "succeeds"
  // having done nothing. Same check the Playwright runner makes, for the same
  // reason — both engines must refuse the same clicks.
  const hit = pointOnly ? null : document.elementFromPoint(localX, localY);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    const id = hit.id ? `#${hit.id}` : "";
    const cls = hit.classList.length ? `.${hit.classList[0]}` : "";
    return {
      ok: false,
      error: `${hit.tagName.toLowerCase()}${id}${cls} is on top of the target, so the input would land on that instead`,
    };
  }

  const offset = await myViewportOffset();
  const x = offset.x + localX;
  const y = offset.y + localY;

  return {
    ok: true,
    x: Math.round(x),
    y: Math.round(y),
    // Drag paths are recorded relative to the start point, so they need no
    // conversion beyond the origin the caller already has.
    path: step.path,
  };
}

/* ---------------------------------------------------------------- *
 * Service-worker protocol + badge
 * ---------------------------------------------------------------- */

/** Every frame negotiates its identity as soon as the session turns on. */
function setMode(next: TabMode): void {
  const wasOff = mode === "off";
  mode = next;
  if (mode === "off") {
    removeBadge();
    removeCursor();
    return;
  }
  if (wasOff) chainReady = myFrameChain();
  // In replay nobody is there to click a dialog, so the page's world answers them
  // from the recording — and defaults to accept for any the recording never saw,
  // because a blocked run reports nothing at all.
  if (mode === "replay") armDialog(undefined);
  installBadge();
  // Installed up front, not on first use: a navigation destroys the document, and a
  // cursor that only appears when something moves it is absent for every page load.
  if (mode === "replay" && window.top === window) installCursor();
}

initFrames({ isActive: () => mode !== "off", selectorsFor });

chrome.runtime.onMessage.addListener(
  (message: SwToCs, _sender, sendResponse: (r: unknown) => void) => {
    if (message.type === "cs-set-mode") {
      setMode(message.mode);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "cs-run") {
      void execStep(message.step, message.meta).then((result) => sendResponse(result));
      return true; // async response
    }
    if (message.type === "cs-locate") {
      void locate(message.step, message.meta, message.pointOnly).then((result) =>
        sendResponse(result),
      );
      return true; // async response
    }
    if (message.type === "cs-cursor") {
      // Top frame only: the cursor lives in one coordinate space, the same one the
      // input is dispatched in.
      if (window.top !== window) {
        sendResponse({ ok: true });
        return false;
      }
      if (message.action === "hide") {
        removeCursor();
        sendResponse({ ok: true });
        return false;
      }
      if (message.action === "pulse") {
        pulseCursor();
        sendResponse({ ok: true });
        return false;
      }
      if (message.action === "install") {
        installCursor();
        sendResponse({ ok: true, ...cursorPosition() });
        return false;
      }
      if (message.action === "place") {
        // After a navigation: put it back where it was, instantly. Gliding in from
        // the corner on every page load reads as a glitch, not as a cursor.
        placeCursor(message.x ?? 0, message.y ?? 0);
        sendResponse({ ok: true });
        return false;
      }
      void moveCursorTo(
        message.x ?? 0,
        message.y ?? 0,
        message.durationMs ?? CURSOR_GLIDE_MS,
      ).then(() => sendResponse({ ok: true }));
      return true; // async: the caller waits for the glide before acting
    }
    return false;
  },
);

/* ---------------------------------------------------------------- *
 * SPA route changes — recorded as a native waitForExpression on location, so the
 * flow model stays pure DevTools and both replay engines already know the step.
 * ---------------------------------------------------------------- */

let lastRouteUrl = location.href;

/* Native dialogs, reported by the main-world patch. */
window.addEventListener("__tf_dialog", (event: Event) => {
  if (mode !== "record") return;
  try {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== "string") return;
    send({ type: "cs-dialog", dialog: JSON.parse(detail) as DialogRecord });
  } catch {
    /* malformed payload — ignore */
  }
});

/** Tells the page's world how to answer the next dialog, before it can be asked. */
function armDialog(dialog: DialogRecord | undefined): void {
  try {
    window.dispatchEvent(
      new CustomEvent("__tf_dialog_answer", {
        detail: JSON.stringify({
          replay: true,
          accept: dialog?.accept,
          promptText: dialog?.promptText,
        }),
      }),
    );
  } catch {
    /* the real dialog stays in charge — it will block, and that is reported */
  }
}

window.addEventListener("__tf_route", (event: Event) => {
  if (mode !== "record") return;
  if (window.top !== window) return; // a framed router isn't a page navigation
  try {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== "string") return;
    const payload = JSON.parse(detail) as { url: string; title: string };
    if (payload.url === lastRouteUrl) return; // replaceState churn, same URL
    lastRouteUrl = payload.url;
    send({
      type: "cs-route",
      url: payload.url,
      title: payload.title,
      tMono: monoNow(),
    });
  } catch {
    /* malformed payload — ignore */
  }
});

function updateBadge(): void {
  if (!badge) return;
  badge.textContent =
    mode === "replay" ? "▶ replaying…" : `● REC · ${stepCount} steps`;
}

function installBadge(): void {
  if (window.top !== window) return; // top frame only
  if (badge || !document.body) return;
  badge = document.createElement("div");
  badge.id = "__tf_badge";
  badge.setAttribute(
    "style",
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:none;" +
      "background:rgba(17,17,17,.92);color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;" +
      "padding:8px 12px;border-radius:999px;box-shadow:0 2px 12px rgba(0,0,0,.35)",
  );
  document.body.appendChild(badge);
  updateBadge();
}

function removeBadge(): void {
  badge?.remove();
  badge = null;
}

/**
 * EVERY frame announces, not just the top one — that registration is what lets the
 * service worker route a replay step to one specific frame instead of broadcasting
 * to all of them and taking whichever answers first.
 */
function announce(): void {
  const isTop = window.top === window;
  void chainReady.then(async (frameChain) => {
    // The environment record is a property of the tab, and only the top frame's
    // measurements describe it. Captured once per page load; the SW keeps the first.
    let env = isTop && mode !== "off" ? captureEnv() : undefined;
    if (env) {
      // Permission state is async, and a flow recorded with geolocation already
      // granted takes a different path than one where the prompt is still pending.
      env = { ...env, permissions: await capturePermissions() };
    }
    send({
      type: "cs-ready",
      url: location.href,
      title: document.title,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      frameChain,
      tMono: monoNow(),
      env,
    });
  });

  if (mode !== "off") installBadge();
  if (!isTop) return;
  if (mode === "replay") installCursor();

  lastRouteUrl = location.href;
  // "settled" = window load fired (all subresources in) — what redirects and slow
  // pages wait on before the next replay step runs.
  const settle = (): void =>
    send({ type: "cs-settled", url: location.href });
  if (document.readyState === "complete") settle();
  else window.addEventListener("load", settle, { once: true });
}

// Ask the SW whether this tab is being tracked, then announce the page load.
void chrome.runtime
  .sendMessage({ type: "cs-get-mode" } satisfies CsToSw)
  .then((reply: { mode?: TabMode } | undefined) => {
    setMode(reply?.mode ?? "off");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", announce);
    } else {
      announce();
    }
  })
  .catch(() => {
    /* SW asleep during navigation — it will re-set mode when it wakes */
  });
