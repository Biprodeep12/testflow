/**
 * Frame identity.
 *
 * A step that happened inside an iframe is meaningless without knowing WHICH frame,
 * and a frame cannot describe itself: only the parent document can see the <iframe>
 * element that hosts it. So every frame asks its parent "who am I?" over
 * window.postMessage — the one channel that works cross-origin — and the parent
 * answers with its own chain plus the link to this child. The chain therefore builds
 * top-down and terminates at the main frame, which answers [].
 *
 * Two identities per hop, because each fails differently:
 *   index      — the native DevTools frame path; breaks when frames are reordered
 *   selectors  — the iframe ELEMENT's selector groups; survives reordering, and is
 *                what Playwright's frameLocator() actually needs
 */

import type { FrameLink } from "../shared/flow";

type WhoAmI = { __tf: "whoami"; id: number };
type YouAre = { __tf: "youare"; id: number; chain: FrameLink[] };
type WhereAmI = { __tf: "whereami"; id: number };
type YouAreAt = { __tf: "youareat"; id: number; x: number; y: number };

const ASK_INTERVAL_MS = 200;
const ASK_TIMEOUT_MS = 4000;

let hooks: {
  isActive: () => boolean;
  selectorsFor: (el: Element) => string[][];
} | null = null;

let cached: FrameLink[] | null = window.top === window ? [] : null;
let pending: Promise<FrameLink[]> | null = null;
let nextId = 1;

/**
 * Wired from the recorder (which owns selector generation) rather than imported,
 * to keep this module free of the recorder's event machinery.
 */
export function initFrames(config: {
  isActive: () => boolean;
  selectorsFor: (el: Element) => string[][];
}): void {
  hooks = config;

  /** Finds the <iframe> element hosting a given child window. */
  const frameElementFor = (source: Window): { el: HTMLIFrameElement; index: number } | null => {
    const frames = Array.from(document.querySelectorAll("iframe, frame"));
    const index = frames.findIndex(
      (el) => (el as HTMLIFrameElement).contentWindow === source,
    );
    return index < 0 ? null : { el: frames[index] as HTMLIFrameElement, index };
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const where = event.data as WhereAmI | undefined;
    if (where && where.__tf === "whereami" && typeof where.id === "number") {
      if (!hooks?.isActive()) return;
      const source = event.source as Window | null;
      if (!source) return;
      const found = frameElementFor(source);
      if (!found) return;
      void myViewportOffset().then((mine) => {
        const rect = found.el.getBoundingClientRect();
        // The child's viewport starts inside the border and padding, not at the
        // element's edge — aiming at the edge is off by the border width.
        const style = getComputedStyle(found.el);
        const inset = {
          left: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          top: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
        };
        source.postMessage(
          {
            __tf: "youareat",
            id: where.id,
            x: mine.x + rect.left + (inset.left || 0),
            y: mine.y + rect.top + (inset.top || 0),
          } satisfies YouAreAt,
          "*",
        );
      });
      return;
    }

    const data = event.data as WhoAmI | undefined;
    if (!data || data.__tf !== "whoami" || typeof data.id !== "number") return;
    // Only while a session is running: the reply describes this document's markup,
    // and a cross-origin child has no business asking otherwise.
    if (!hooks?.isActive()) return;

    const source = event.source as Window | null;
    if (!source) return;
    const found = frameElementFor(source);
    if (!found) return; // not our child
    const { el, index } = found;

    void myFrameChain().then((parentChain) => {
      const link: FrameLink = {
        index,
        selectors: hooks?.selectorsFor(el),
        url: el.getAttribute("src") ?? undefined,
        name: el.getAttribute("name") ?? undefined,
      };
      const reply: YouAre = { __tf: "youare", id: data.id, chain: [...parentChain, link] };
      // "*" is required — a cross-origin child's origin is unknown here.
      source.postMessage(reply, "*");
    });
  });
}

/**
 * Where this frame's viewport sits inside the TOP frame's viewport.
 *
 * Real input is dispatched in top-frame coordinates, but an element inside an iframe
 * only knows its position within its own document. Nothing in the child can see the
 * difference, so the parent measures the iframe element's content origin and adds its
 * own offset, recursively up to the top frame.
 *
 * Never cached: scrolling the parent moves the child, so a stale offset aims the
 * click at the wrong place.
 */
export function myViewportOffset(): Promise<{ x: number; y: number }> {
  if (window.top === window) return Promise.resolve({ x: 0, y: 0 });
  return new Promise((resolve) => {
    const id = nextId++;
    const parent = window.parent;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onReply);
      resolve({ x: 0, y: 0 }); // best effort: aim as if top-level, and it will miss loudly
    }, 1000);

    function onReply(event: MessageEvent): void {
      const data = event.data as YouAreAt | undefined;
      if (!data || data.__tf !== "youareat" || data.id !== id) return;
      if (event.source !== parent) return;
      clearTimeout(timer);
      window.removeEventListener("message", onReply);
      resolve({ x: data.x, y: data.y });
    }

    window.addEventListener("message", onReply);
    parent.postMessage({ __tf: "whereami", id } satisfies WhereAmI, "*");
  });
}

/** This frame's chain from the tab's main frame. [] = main frame. */
export function myFrameChain(): Promise<FrameLink[]> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;

  pending = new Promise<FrameLink[]>((resolve) => {
    const id = nextId++;
    const parent = window.parent;
    let timer: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const done = (chain: FrameLink[]): void => {
      if (timer) clearInterval(timer);
      if (deadline) clearTimeout(deadline);
      window.removeEventListener("message", onReply);
      cached = chain;
      resolve(chain);
    };

    function onReply(event: MessageEvent): void {
      const data = event.data as YouAre | undefined;
      if (!data || data.__tf !== "youare" || data.id !== id) return;
      if (event.source !== parent) return;
      done(Array.isArray(data.chain) ? data.chain : []);
    }

    window.addEventListener("message", onReply);
    const ask = (): void => parent.postMessage({ __tf: "whoami", id } satisfies WhoAmI, "*");
    ask();
    // The parent's content script may still be starting up at document_start.
    timer = setInterval(ask, ASK_INTERVAL_MS);
    // Giving up yields [] — the step still records, attributed to the main frame,
    // and replay reports the mismatch rather than silently acting somewhere else.
    deadline = setTimeout(() => done([]), ASK_TIMEOUT_MS);
  });

  return pending;
}

/** Native DevTools frame path: just the indices. */
export function framePath(chain: FrameLink[]): number[] {
  return chain.map((link) => link.index);
}
