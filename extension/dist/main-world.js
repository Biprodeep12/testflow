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
    const announceRoute = () => {
      setTimeout(() => {
        try {
          window.dispatchEvent(
            new CustomEvent("__tf_route", {
              detail: JSON.stringify({ url: location.href, title: document.title })
            })
          );
        } catch {
        }
      }, 0);
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function patched(...args) {
        const result = original.apply(this, args);
        announceRoute();
        return result;
      };
    }
    window.addEventListener("popstate", announceRoute);
    window.addEventListener("hashchange", announceRoute);
    const nav = window.navigation;
    nav?.addEventListener("navigatesuccess", announceRoute);
    const answers = [];
    let replaying = false;
    window.addEventListener("__tf_dialog_answer", (event) => {
      try {
        const detail = event.detail;
        if (typeof detail !== "string") return;
        const payload = JSON.parse(detail);
        replaying = payload.replay;
        if (payload.replay && typeof payload.accept === "boolean") {
          answers.push({ accept: payload.accept, promptText: payload.promptText });
        }
      } catch {
      }
    });
    const reportDialog = (kind, message, accept, promptText) => {
      try {
        window.dispatchEvent(
          new CustomEvent("__tf_dialog", {
            detail: JSON.stringify({ kind, message, accept, promptText })
          })
        );
      } catch {
      }
    };
    const nativeAlert = window.alert;
    const nativeConfirm = window.confirm;
    const nativePrompt = window.prompt;
    window.alert = function patchedAlert(message) {
      const text = String(message ?? "");
      if (replaying) {
        reportDialog("alert", text, true);
        return;
      }
      nativeAlert.call(window, text);
      reportDialog("alert", text, true);
    };
    window.confirm = function patchedConfirm(message) {
      const text = String(message ?? "");
      if (replaying) {
        const answer = answers.shift();
        const accept = answer?.accept ?? true;
        reportDialog("confirm", text, accept);
        return accept;
      }
      const result = nativeConfirm.call(window, text);
      reportDialog("confirm", text, result);
      return result;
    };
    window.prompt = function patchedPrompt(message, fallback) {
      const text = String(message ?? "");
      if (replaying) {
        const answer = answers.shift();
        if (answer && !answer.accept) {
          reportDialog("prompt", text, false);
          return null;
        }
        const typed = answer?.promptText ?? String(fallback ?? "");
        reportDialog("prompt", text, true, typed);
        return typed;
      }
      const result = nativePrompt.call(window, text, String(fallback ?? ""));
      reportDialog("prompt", text, result !== null, result ?? void 0);
      return result;
    };
    window.addEventListener("__tf_expr", (event) => {
      let id = 0;
      const reply = (ok, value, error) => {
        window.dispatchEvent(
          new CustomEvent("__tf_expr_result", {
            detail: JSON.stringify({ id, ok, value: Boolean(value), error })
          })
        );
      };
      try {
        const detail = event.detail;
        if (typeof detail !== "string") return;
        const payload = JSON.parse(detail);
        id = payload.id;
        try {
          const fn = new Function(`return (${payload.expression});`);
          reply(true, fn());
        } catch (err) {
          reply(false, false, err instanceof Error ? err.message : "expression failed");
        }
      } catch {
        reply(false, false, "malformed expression payload");
      }
    });
  })();
})();
