"use strict";
(() => {
  // extension/src/content/main-world.ts
  (() => {
    const w = window;
    if (w.__tfMainKbd) return;
    w.__tfMainKbd = true;
    window.addEventListener("__tf_kbd", (event) => {
      try {
        const detail = event.detail;
        if (typeof detail !== "string") return;
        const payload = JSON.parse(detail);
        const kbd = new KeyboardEvent(payload.type, {
          key: payload.key,
          code: payload.code,
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: payload.ctrlKey,
          altKey: payload.altKey,
          metaKey: payload.metaKey,
          shiftKey: payload.shiftKey
        });
        Object.defineProperty(kbd, "keyCode", { get: () => payload.keyCode });
        Object.defineProperty(kbd, "which", { get: () => payload.keyCode });
        (document.activeElement ?? document.body).dispatchEvent(kbd);
      } catch {
      }
    });
  })();
})();
