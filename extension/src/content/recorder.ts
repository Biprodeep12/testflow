/**
 * Content script — every page, every frame, document_start.
 *
 * Inert until the service worker says this tab is in "record" or "replay" mode, so
 * browsing normally costs nothing. Records interactions as DevTools-Recorder steps
 * (same selector engine as v2) and executes steps during replay. All traffic goes
 * through chrome.runtime — the page's CSP and origin are irrelevant, and it survives
 * every navigation because the browser re-injects it.
 */

import type { CsToSw, FlowStep, SwToCs, TabMode } from "../shared/flow";

let mode: TabMode = "off";
let stepCount = 0;
let badge: HTMLElement | null = null;

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
  const text = norm(el.textContent);
  return text && text.length <= 60 ? text : "";
}

function cssFor(el: Element): string {
  if (el.classList.length > 0) {
    const classes = Array.from(el.classList).slice(0, 3).map(cssEsc);
    const short = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
    try {
      if (document.querySelectorAll(short).length === 1) return short;
    } catch {
      /* invalid class combo — fall through */
    }
  }
  if (el.id) {
    const byId = `#${cssEsc(el.id)}`;
    try {
      if (document.querySelectorAll(byId).length === 1) return byId;
    } catch {
      /* fall through */
    }
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    if (node.id) {
      parts.unshift(`#${cssEsc(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter(
        (child) => child.tagName === node!.tagName,
      );
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

function xpathFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let anchor = "";
  while (node && node.nodeType === 1) {
    if (node.id) {
      anchor = `//*[@id="${node.id}"]`;
      break;
    }
    const parent: Element | null = node.parentElement;
    let segment = node.tagName.toLowerCase();
    if (parent) {
      const same = Array.from(parent.children).filter(
        (child) => child.tagName === node!.tagName,
      );
      if (same.length > 1) segment += `[${same.indexOf(node) + 1}]`;
    }
    parts.unshift(segment);
    node = parent;
  }
  return anchor
    ? anchor + (parts.length ? `/${parts.join("/")}` : "")
    : `/${parts.join("/")}`;
}

/** Escapes a value for use inside [attr="..."]. */
const attrEsc = (value: string): string => value.replace(/["\\]/g, "\\$&");

/** True when the selector matches exactly one element — ambiguous ones would cast
 *  votes for the wrong element during consensus replay, so they're skipped. */
function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
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
function selectorsFor(el: Element): string[][] {
  const out: string[][] = [];
  const push = (selector: string): void => {
    if (isUnique(selector)) out.push([selector]);
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

  // 4. Structure: CSS path, XPath, shadow-piercing variant.
  const css = cssFor(el);
  if (css) out.push([css]);
  const xp = xpathFor(el);
  if (xp) out.push([`xpath/${xp}`]);
  if (css) out.push([`pierce/${css}`]);

  // 5. Visible text — last resort.
  const text = norm(el.textContent);
  if (text && text.length <= 60 && el.children.length === 0) {
    out.push([`text/${text.slice(0, 25)}`]);
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

function record(step: FlowStep): void {
  stepCount++;
  updateBadge();
  send({ type: "cs-step", step });
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

document.addEventListener(
  "pointerup",
  (event) => {
    const drag = dragState;
    dragState = null;
    if (!drag || !drag.moved || mode !== "record" || !event.isTrusted) return;
    const dx = Math.round(event.clientX - drag.startClientX);
    const dy = Math.round(event.clientY - drag.startClientY);
    const last = drag.path[drag.path.length - 1];
    if (!last || last.x !== dx || last.y !== dy) drag.path.push({ x: dx, y: dy });
    flushWheel();
    record({
      type: "drag",
      target: "main",
      selectors: selectorsFor(drag.el),
      offsetX: drag.offsetX,
      offsetY: drag.offsetY,
      path: drag.path,
      duration: Date.now() - drag.startedAt,
    });
    suppressClickUntil = Date.now() + 200;
  },
  true,
);

// The browser hands scrolling to the compositor on touch-pan and fires
// pointercancel — that gesture is a scroll, not a drag.
document.addEventListener("pointercancel", () => (dragState = null), true);

document.addEventListener(
  "click",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    if (Date.now() < suppressClickUntil) return; // tail click of a recorded drag
    const el = targetOf(event);
    if (!el || el.closest("#__tf_badge")) return;
    flushWheel(); // a pending wheel burst must land BEFORE this click in the flow
    record({
      type: "click",
      target: "main",
      selectors: selectorsFor(el),
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    });
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
    record({
      type: "click",
      target: "main",
      button: "secondary",
      selectors: selectorsFor(el),
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    });
  },
  true,
);

document.addEventListener(
  "dblclick",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    const el = targetOf(event);
    if (!el) return;
    record({
      type: "doubleClick",
      target: "main",
      selectors: selectorsFor(el),
      offsetX: event.offsetX,
      offsetY: event.offsetY,
    });
  },
  true,
);

// `change` fires once per committed edit — one step per field, DevTools granularity.
document.addEventListener(
  "change",
  (event) => {
    if (mode !== "record" || !event.isTrusted) return;
    const el = targetOf(event);
    if (!el) return;
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (["checkbox", "radio", "file", "button", "submit", "reset"].includes(type))
      return; // checkbox/radio are click steps; files can't replay
    record({
      type: "change",
      target: "main",
      // Passwords are recorded with an empty value — the secret never leaves the page.
      value: type === "password" ? "" : String((el as HTMLInputElement).value ?? ""),
      selectors: selectorsFor(el),
      // Playwright codegen needs this: fill() throws on <select>. Stripped on export.
      tagName: tag.toLowerCase(),
    });
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
      record({ type: "keyDown", target: "main", key });
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
    record({ type: "keyDown", target: "main", key: event.key });
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
        record({ type: "keyUp", target: "main", key: event.key });
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
  record({
    type: "wheel",
    target: "main",
    selectors: selectorsFor(acc.el),
    deltaX: Math.round(acc.deltaX),
    deltaY: Math.round(acc.deltaY),
    offsetX: acc.offsetX,
    offsetY: acc.offsetY,
  });
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
          record({
            type: "scroll",
            target: "main",
            selectors: selectorsFor(target),
            x: Math.round(target.scrollLeft),
            y: Math.round(target.scrollTop),
          });
        } else {
          record({
            type: "scroll",
            target: "main",
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

function deepQuery(selector: string, root: ParentNode = document): Element | null {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch {
    return null;
  }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    if (node.shadowRoot) {
      const found = deepQuery(selector, node.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function byAria(name: string): Element | null {
  const nodes = document.querySelectorAll(
    "button,a,input,select,textarea,summary,label,[role],[aria-label],[tabindex],h1,h2,h3,h4,svg,img",
  );
  for (const node of nodes) if (accName(node) === name) return node;
  return null;
}

function byText(prefix: string): Element | null {
  let best: Element | null = null;
  const all = document.body.getElementsByTagName("*");
  for (const node of all) {
    const text = norm(node.textContent);
    if (text && text.startsWith(prefix)) {
      if (!best || (node.textContent ?? "").length < (best.textContent ?? "").length) {
        best = node; // innermost match
      }
    }
  }
  return best;
}

function resolveOne(selector: string): Element | null {
  try {
    if (selector.startsWith("aria/")) return byAria(selector.slice(5));
    if (selector.startsWith("xpath/"))
      return document.evaluate(
        selector.slice(6),
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue as Element | null;
    if (selector.startsWith("pierce/")) return deepQuery(selector.slice(7));
    if (selector.startsWith("text/")) return byText(selector.slice(5));
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Consensus resolution: every group is resolved, and the element MOST groups agree
 * on wins — a stale positional path that now points at the wrong element is outvoted
 * by aria/testid/text still agreeing on the right one. First-match-wins can't do that.
 *
 * Nested hits (one group finds the <button>, another its inner <span>) count as
 * agreement — the click bubbles either way — and the bucket keeps the deeper element,
 * matching what was actually recorded. Ties break toward the earlier (more durable)
 * group.
 */
function voteResolve(groups: string[][]): Element | null {
  type Bucket = { el: Element; votes: number; firstIndex: number };
  const buckets: Bucket[] = [];

  groups.forEach((group, index) => {
    const el = group[0] ? resolveOne(group[0]) : null;
    if (!el) return;
    const related = buckets.find(
      (bucket) =>
        bucket.el === el || bucket.el.contains(el) || el.contains(bucket.el),
    );
    if (related) {
      related.votes++;
      if (related.el.contains(el) && related.el !== el) related.el = el; // keep deeper
    } else {
      buckets.push({ el, votes: 1, firstIndex: index });
    }
  });

  if (buckets.length === 0) return null;
  buckets.sort((a, b) => b.votes - a.votes || a.firstIndex - b.firstIndex);
  return buckets[0].el;
}

function resolveEl(groups: string[][], timeoutMs: number): Promise<Element | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = (): void => {
      const el = voteResolve(groups);
      if (el) return resolve(el);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(poll, 120);
    };
    poll();
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

async function execStep(step: FlowStep): Promise<{ ok: boolean; error?: string }> {
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

/* ---------------------------------------------------------------- *
 * Service-worker protocol + badge
 * ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(
  (message: SwToCs, _sender, sendResponse: (r: unknown) => void) => {
    if (message.type === "cs-set-mode") {
      mode = message.mode;
      if (mode === "off") removeBadge();
      else installBadge();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "cs-run") {
      void execStep(message.step).then((result) => sendResponse(result));
      return true; // async response
    }
    return false;
  },
);

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

function announce(): void {
  if (window.top !== window) return; // one ready per page, from the top frame
  send({
    type: "cs-ready",
    url: location.href,
    title: document.title,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });
  if (mode !== "off") installBadge();

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
    mode = reply?.mode ?? "off";
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", announce);
    } else {
      announce();
    }
  })
  .catch(() => {
    /* SW asleep during navigation — it will re-set mode when it wakes */
  });
