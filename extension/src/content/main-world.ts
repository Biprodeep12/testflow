/**
 * MAIN-world helper (manifest `world: "MAIN"`) — the three things the isolated-world
 * recorder cannot do itself:
 *
 *   1. Dispatch keyboard events whose legacy keyCode/which overrides are visible to
 *      PAGE handlers. Property overrides don't cross Chrome's isolated-world
 *      boundary; an event built here lives in the page's world, so its getters are
 *      the ones page code reads.
 *   2. See SPA route changes. history.pushState/replaceState are page functions —
 *      patching them from the isolated world patches a different object.
 *   3. Evaluate a `waitForExpression` against page state. The isolated world runs
 *      under the EXTENSION's CSP, which forbids eval outright.
 *
 * Bridge: CustomEvents with JSON-string details (primitives cross worlds; objects
 * don't).
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

  /* ---------------------------------------------------------------- *
   * SPA route changes — first-class navigations.
   *
   * A pushState route change produces no page load, so the recorder's cs-ready
   * handshake never fires and the whole route transition is invisible to the flow.
   * Patch the real history methods here, and also listen to the Navigation API so
   * router libraries that bypass history.* are still caught. Duplicates are fine —
   * the isolated world de-dupes by URL.
   * ---------------------------------------------------------------- */

  const announceRoute = (): void => {
    // A tick of slack: routers set document.title right after committing the URL.
    setTimeout(() => {
      try {
        window.dispatchEvent(
          new CustomEvent("__tf_route", {
            detail: JSON.stringify({ url: location.href, title: document.title }),
          }),
        );
      } catch {
        /* nothing sensible to do from the page's world */
      }
    }, 0);
  };

  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function patched(this: History, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      announceRoute();
      return result;
    } as typeof history.pushState;
  }
  window.addEventListener("popstate", announceRoute);
  window.addEventListener("hashchange", announceRoute);
  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigatesuccess", announceRoute);

  /* ---------------------------------------------------------------- *
   * Native dialogs.
   *
   * alert/confirm/prompt are page functions and they BLOCK. Two jobs:
   *
   *   recording — call the real one, then report what the user answered. A confirm
   *               the flow does not know about takes an unknown branch on replay.
   *   replay    — answer from the recording WITHOUT opening a real dialog, which
   *               would block the run forever with nobody there to click it.
   *
   * The queue is filled by the isolated world just before the step that opens the
   * dialog runs, so the answer is in place before the page can ask.
   * ---------------------------------------------------------------- */

  const answers: { accept: boolean; promptText?: string }[] = [];
  let replaying = false;

  window.addEventListener("__tf_dialog_answer", (event: Event) => {
    try {
      const detail = (event as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const payload = JSON.parse(detail) as {
        replay: boolean;
        accept?: boolean;
        promptText?: string;
      };
      replaying = payload.replay;
      if (payload.replay && typeof payload.accept === "boolean") {
        answers.push({ accept: payload.accept, promptText: payload.promptText });
      }
    } catch {
      /* malformed — the real dialog stays in charge */
    }
  });

  const reportDialog = (
    kind: string,
    message: string,
    accept: boolean,
    promptText?: string,
  ): void => {
    try {
      window.dispatchEvent(
        new CustomEvent("__tf_dialog", {
          detail: JSON.stringify({ kind, message, accept, promptText }),
        }),
      );
    } catch {
      /* nothing sensible to do from the page's world */
    }
  };

  const nativeAlert = window.alert;
  const nativeConfirm = window.confirm;
  const nativePrompt = window.prompt;

  window.alert = function patchedAlert(message?: unknown): void {
    const text = String(message ?? "");
    if (replaying) {
      reportDialog("alert", text, true);
      return; // answered from the recording; never opens
    }
    nativeAlert.call(window, text);
    reportDialog("alert", text, true);
  };

  window.confirm = function patchedConfirm(message?: unknown): boolean {
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

  window.prompt = function patchedPrompt(
    message?: unknown,
    fallback?: unknown,
  ): string | null {
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
    reportDialog("prompt", text, result !== null, result ?? undefined);
    return result;
  };

  /* ---------------------------------------------------------------- *
   * waitForExpression evaluation, in the page's own world.
   * ---------------------------------------------------------------- */

  window.addEventListener("__tf_expr", (event: Event) => {
    let id = 0;
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      window.dispatchEvent(
        new CustomEvent("__tf_expr_result", {
          detail: JSON.stringify({ id, ok, value: Boolean(value), error }),
        }),
      );
    };
    try {
      const detail = (event as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const payload = JSON.parse(detail) as { id: number; expression: string };
      id = payload.id;
      try {
        // Blocked by a page CSP without 'unsafe-eval' — reported, never guessed around.
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
