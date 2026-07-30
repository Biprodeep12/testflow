import { useEffect, useRef } from "react";

/**
 * Runs `fn` once immediately, then every `ms` — pass `ms: null` to run it just once.
 * `resetKey` re-triggers the whole cycle (used for the route's `id`).
 *
 * Two deliberate choices:
 *  - The first run is scheduled on a timer rather than called in the effect body, so
 *    the setState it performs happens in a callback (React 19 flags the synchronous form).
 *  - Ticks chain with setTimeout instead of setInterval, so a slow request can never
 *    stack overlapping polls.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  ms: number | null,
  resetKey?: string | number | null,
): void {
  const saved = useRef(fn);

  useEffect(() => {
    saved.current = fn;
  }, [fn]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async (): Promise<void> => {
      // Firestore bills a read per document returned — and a minimum of one even for
      // an empty result. A tab left open in the background would quietly spend the
      // daily quota on data nobody is looking at, so skip the fetch and just requeue.
      if (typeof document !== "undefined" && document.hidden) {
        if (!cancelled && ms !== null) timer = setTimeout(tick, ms);
        return;
      }
      try {
        await saved.current();
      } catch {
        // Reporting is the caller's job — never let one failure kill the loop.
      }
      if (!cancelled && ms !== null) timer = setTimeout(tick, ms);
    };

    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ms, resetKey]);
}
