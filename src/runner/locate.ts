/**
 * Where a step runs: which frame, and which element.
 *
 * Element resolution ships the SHARED resolver into the page rather than mapping
 * DevTools selectors onto Playwright locators. That mapping is necessarily a guess
 * (`aria/Name` carries a name but no role), and a guess would resolve differently
 * here than it does in the extension — the two executors have to agree.
 */

import type { ElementHandle, Frame, Page } from "playwright";
import { pageExpr, resolveInPage } from "../shared/resolve";
import type { FrameLink, ScrollRecord } from "../types/flow";

export type FrameHow = "main" | "index" | "signature";

const POLL_MS = 100;

/** Consensus resolution, polled until it lands or the budget runs out. */
export async function resolveHandle(
  frame: Frame,
  selectors: string[][] | undefined,
  timeoutMs: number,
): Promise<ElementHandle<Element> | null> {
  const groups = selectors ?? [];
  if (groups.length === 0) return null;
  const expression = pageExpr(resolveInPage, { selectors: groups });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await frame.evaluateHandle(expression);
      const element = handle.asElement() as ElementHandle<Element> | null;
      if (element) return element;
      await handle.dispose();
    } catch {
      // Navigating out from under us — retry against the new document.
    }
    if (Date.now() >= deadline) return null;
    await frame.page().waitForTimeout(POLL_MS);
  }
}

/**
 * Walks the recorded iframe chain.
 *
 * The iframe ELEMENT's selectors are tried first because they survive frame
 * reordering (ad slots, lazy mounts) that invalidates indices; the native index
 * path is the fallback. Which one worked is reported, because a chain that only
 * resolves by index is one page change away from breaking.
 */
export async function frameFor(
  page: Page,
  chain: FrameLink[] | undefined,
  timeoutMs: number,
): Promise<{ frame: Frame; how: FrameHow } | { frame: null; how: FrameHow; missing: number }> {
  let frame = page.mainFrame();
  let how: FrameHow = "main";

  for (let depth = 0; depth < (chain?.length ?? 0); depth++) {
    const link = chain![depth];
    let child: Frame | null = null;

    if (link.selectors?.length) {
      const handle = await resolveHandle(frame, link.selectors, timeoutMs);
      if (handle) {
        child = await handle.contentFrame();
        await handle.dispose();
        if (child) how = how === "main" ? "signature" : how;
      }
    }
    if (!child) {
      const frames = await frame.$$("iframe, frame");
      const el = frames[link.index];
      if (el) {
        child = await el.contentFrame();
        if (child) how = "index";
      }
    }
    if (!child) return { frame: null, how, missing: depth };
    frame = child;
  }

  return { frame, how };
}

/**
 * Puts every recorded scroll container back where it was.
 *
 * Not cosmetic: acting on an element at a different scroll offset than the
 * recording produces a correct action and a different picture, and every frame
 * after it inherits the offset.
 */
export async function restoreScroll(
  frame: Frame,
  state: ScrollRecord[] | undefined,
  timeoutMs: number,
): Promise<string[]> {
  const notes: string[] = [];
  for (const entry of state ?? []) {
    if (!entry.selectors) {
      await frame.evaluate(
        ([x, y]) => window.scrollTo(x, y),
        [entry.x, entry.y] as const,
      );
      continue;
    }
    const handle = await resolveHandle(frame, entry.selectors, Math.min(timeoutMs, 1000));
    if (!handle) {
      notes.push(`scroll container ${entry.selectors[0]?.[0] ?? "?"} not found`);
      continue;
    }

    // Content position first: in a virtualized or infinite list the recorded pixel
    // offset points at whatever row happens to live there this run, which is how a
    // replay ends up looking right and being somewhere else entirely.
    let anchored = false;
    if (entry.anchor) {
      const anchor = await resolveHandle(frame, entry.anchor.selectors, 500);
      if (anchor) {
        // Scroll so the anchor sits exactly where it sat: `offset` pixels of it
        // hidden above the container's top edge.
        await handle.evaluate(
          (container, args) => {
            // The CONTENT box, not the border box: getBoundingClientRect() includes
            // the border, so a bordered container is off by its border width on
            // every restore — small, constant, and wrong on every step.
            const box = container.getBoundingClientRect();
            const border = parseFloat(getComputedStyle(container).borderTopWidth) || 0;
            const rect = args.anchor.getBoundingClientRect();
            container.scrollTo(
              args.x,
              container.scrollTop + (rect.top - (box.top + border)) + args.offset,
            );
          },
          { anchor, x: entry.x, offset: entry.anchor.offsetY },
        );
        await anchor.dispose();
        anchored = true;
      } else {
        notes.push(
          `scroll anchor ${entry.anchor.selectors[0]?.[0] ?? "?"} is gone — restored by pixel offset, which may be a different row`,
        );
      }
    }
    if (!anchored) {
      await handle.evaluate((el, pos) => el.scrollTo(pos.x, pos.y), {
        x: entry.x,
        y: entry.y,
      });
    }
    await handle.dispose();
  }
  return notes;
}
