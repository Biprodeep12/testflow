/**
 * MAIN-world helper (manifest `world: "MAIN"`) — the one thing the isolated-world
 * recorder cannot do itself: dispatch keyboard events whose legacy keyCode/which
 * overrides are visible to PAGE handlers. Property overrides don't cross Chrome's
 * isolated-world boundary; an event built here lives in the page's world, so its
 * getters are the ones page code reads.
 *
 * Bridge: the recorder fires a CustomEvent with a JSON-string detail (primitives
 * cross worlds; objects don't).
 */

type KbdPayload = {
  type: "keydown" | "keyup";
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

(() => {
  const w = window as Window & { __tfMainKbd?: boolean };
  if (w.__tfMainKbd) return;
  w.__tfMainKbd = true;

  window.addEventListener("__tf_kbd", (event: Event) => {
    try {
      const detail = (event as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const payload = JSON.parse(detail) as KbdPayload;
      const kbd = new KeyboardEvent(payload.type, {
        key: payload.key,
        code: payload.code,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: payload.ctrlKey,
        altKey: payload.altKey,
        metaKey: payload.metaKey,
        shiftKey: payload.shiftKey,
      });
      Object.defineProperty(kbd, "keyCode", { get: () => payload.keyCode });
      Object.defineProperty(kbd, "which", { get: () => payload.keyCode });
      (document.activeElement ?? document.body).dispatchEvent(kbd);
    } catch {
      /* malformed payload — ignore */
    }
  });
})();
