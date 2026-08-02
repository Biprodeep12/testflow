"use strict";
(() => {
  // src/types/flow.ts
  var MAX_UPLOAD_BYTES = 256 * 1024;
  var ROOT_TARGET = "t0";
  function frameKey(chain) {
    return (chain ?? []).map((link) => link.index).join("/");
  }
  function frameSignature(chain) {
    return (chain ?? []).map((link) => link.selectors?.[0]?.[0] ?? `#${link.index}`).join(" >>> ");
  }

  // extension/src/sw/cdp.ts
  var PROTOCOL_VERSION = "1.3";
  var attached = /* @__PURE__ */ new Set();
  function isAttached(tabId) {
    return attached.has(tabId);
  }
  async function attach(tabId) {
    if (attached.has(tabId)) return true;
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      attached.add(tabId);
      return true;
    } catch {
      return false;
    }
  }
  async function detach(tabId) {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
    }
  }
  async function detachAll() {
    await Promise.all(Array.from(attached).map((tabId) => detach(tabId)));
  }
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== void 0) attached.delete(source.tabId);
  });
  async function send(tabId, method, params) {
    await chrome.debugger.sendCommand({ tabId }, method, params);
  }
  async function evaluate(tabId, expression) {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      // Coerced here so a truthy non-boolean (an element, a non-empty string) means
      // the same thing it would in an `if`.
      expression: `!!(${expression})`,
      returnByValue: true,
      // A page that throws should read as "not true yet", not as a crashed run.
      silent: true
    });
    if (result.exceptionDetails) return false;
    return result.result?.value === true;
  }
  var BUTTON_MASK = { left: 1, right: 2, middle: 4 };
  async function mouseMove(tabId, x, y) {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }
  async function click(tabId, x, y, button, clickCount) {
    await mouseMove(tabId, x, y);
    for (let n = 1; n <= clickCount; n++) {
      const common = { x, y, button, buttons: BUTTON_MASK[button], clickCount: n };
      await send(tabId, "Input.dispatchMouseEvent", { ...common, type: "mousePressed" });
      await send(tabId, "Input.dispatchMouseEvent", {
        ...common,
        type: "mouseReleased",
        buttons: 0
      });
    }
  }
  async function drag(tabId, start, path, durationMs) {
    await mouseMove(tabId, start.x, start.y);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    const points = path.length > 0 ? path : [{ x: 0, y: 0 }];
    const gap = Math.min(Math.max(durationMs / points.length, 5), 40);
    let last = start;
    for (const point of points) {
      last = { x: start.x + point.x, y: start.y + point.y };
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: last.x,
        y: last.y,
        button: "left",
        buttons: 1
      });
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  }
  async function wheel(tabId, x, y, deltaX, deltaY) {
    await mouseMove(tabId, x, y);
    const chunks = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 120));
    for (let i = 0; i < chunks; i++) {
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: deltaX / chunks,
        deltaY: deltaY / chunks
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  var held = /* @__PURE__ */ new Set();
  var MODIFIER_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  var KEY_INFO = {
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
    Meta: { code: "MetaLeft", keyCode: 91 }
  };
  function keyInfo(key2) {
    const known = KEY_INFO[key2];
    if (known) return known;
    if (/^[a-zA-Z]$/.test(key2)) {
      const upper = key2.toUpperCase();
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    if (/^[0-9]$/.test(key2)) return { code: `Digit${key2}`, keyCode: 48 + Number(key2) };
    if (/^F([1-9]|1[0-2])$/.test(key2)) return { code: key2, keyCode: 111 + Number(key2.slice(1)) };
    return { code: key2, keyCode: 0 };
  }
  function resetKeys() {
    held.clear();
  }
  async function key(tabId, down, name) {
    if (down) held.add(name);
    else held.delete(name);
    let modifiers = 0;
    for (const [modifier, bit] of Object.entries(MODIFIER_BIT)) {
      if (held.has(modifier)) modifiers |= bit;
    }
    const info = keyInfo(name);
    const printable = name.length === 1 && !(modifiers & (MODIFIER_BIT.Control | MODIFIER_BIT.Alt | MODIFIER_BIT.Meta));
    await send(tabId, "Input.dispatchKeyEvent", {
      type: down ? printable ? "keyDown" : "rawKeyDown" : "keyUp",
      key: name,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers,
      ...down && printable ? { text: name } : {}
    });
  }

  // extension/src/sw/index.ts
  var KEY = "tf-session";
  var FRAMES_KEY = "tf-frames";
  var STEP_PREFIX = "tf-s-";
  async function getRecorded() {
    const all = await chrome.storage.session.get(null);
    const rows = [];
    for (const [key2, value] of Object.entries(all)) {
      if (key2.startsWith(STEP_PREFIX)) {
        rows.push([Number(key2.slice(STEP_PREFIX.length)), value]);
      }
    }
    rows.sort((a, b) => a[0] - b[0]);
    return {
      steps: rows.map(([, row]) => row.step),
      meta: rows.map(([, row]) => row.meta)
    };
  }
  async function getStep(id) {
    const key2 = STEP_PREFIX + id;
    return (await chrome.storage.session.get(key2))[key2];
  }
  async function putStep(id, row) {
    await chrome.storage.session.set({ [STEP_PREFIX + id]: row });
  }
  async function clearRecorded() {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((key2) => key2.startsWith(STEP_PREFIX));
    if (keys.length > 0) await chrome.storage.session.remove(keys);
  }
  async function getSession() {
    const data = await chrome.storage.session.get(KEY);
    return data[KEY] ?? null;
  }
  async function setSession(session) {
    if (session) await chrome.storage.session.set({ [KEY]: session });
    else await chrome.storage.session.remove(KEY);
  }
  async function getFrames() {
    const data = await chrome.storage.session.get(FRAMES_KEY);
    return data[FRAMES_KEY] ?? [];
  }
  async function registerFrame(entry) {
    const frames = await getFrames();
    const rest = frames.filter(
      (f) => !(f.tabId === entry.tabId && f.frameId === entry.frameId)
    );
    rest.push(entry);
    await chrome.storage.session.set({ [FRAMES_KEY]: rest.slice(-300) });
  }
  async function forgetTabFrames(tabId) {
    const frames = await getFrames();
    await chrome.storage.session.set({
      [FRAMES_KEY]: frames.filter((f) => f.tabId !== tabId)
    });
  }
  async function resolveFrameId(tabId, chain) {
    if (!chain || chain.length === 0) return { frameId: 0, how: "main" };
    const frames = (await getFrames()).filter((f) => f.tabId === tabId);
    const bySig = frames.find((f) => f.signature === frameSignature(chain));
    if (bySig) return { frameId: bySig.frameId, how: "signature" };
    const byIndex = frames.find((f) => f.key === frameKey(chain));
    if (byIndex) return { frameId: byIndex.frameId, how: "index" };
    return null;
  }
  var bridges = /* @__PURE__ */ new Set();
  function broadcast(message) {
    for (const port of bridges) {
      try {
        port.postMessage(message);
      } catch {
        bridges.delete(port);
      }
    }
  }
  async function snapshotOf(session) {
    const recorded = session ? await getRecorded() : { steps: [], meta: [] };
    return {
      source: "tf-agent",
      kind: "snapshot",
      recording: session?.mode === "record",
      steps: recorded.steps,
      meta: recorded.meta,
      env: session?.env,
      error: session?.storageError
    };
  }
  async function broadcastSnapshot(session) {
    broadcast(await snapshotOf(session));
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "tf-bridge") return;
    bridges.add(port);
    port.onDisconnect.addListener(() => bridges.delete(port));
    port.onMessage.addListener((message) => {
      void handleHub(message);
    });
    void getSession().then(async (session) => port.postMessage(await snapshotOf(session)));
  });
  async function setTabMode(tabId, mode) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "cs-set-mode", mode });
    } catch {
    }
  }
  async function startSession(mode, url) {
    const existing = await getSession();
    if (existing) await stopSession();
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.remove(FRAMES_KEY);
    await clearRecorded();
    if (mode === "replay") {
      resetKeys();
      await attach(tab.id);
    }
    await setSession({
      mode,
      tabIds: [tab.id],
      targets: { [tab.id]: ROOT_TARGET },
      targetUrls: { [ROOT_TARGET]: url },
      nextTarget: 1,
      stepCount: 0,
      lastStepId: 0,
      nextStepId: 1,
      startedAt: Date.now(),
      sourceUrl: url
    });
  }
  async function stopSession() {
    const session = await getSession();
    if (!session) return;
    await detachAll();
    for (const tabId of session.tabIds) {
      cursorAt.delete(tabId);
      void setTabMode(tabId, "off");
      void chrome.action.setBadgeText({ tabId, text: "" });
    }
    await setSession(null);
    broadcast({ source: "tf-agent", kind: "stopped" });
  }
  var TARGET_WAIT_MS = 5e3;
  async function findTarget(wantTarget, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const session = await getSession();
      const tabId = Object.keys(session?.targets ?? {}).map(Number).find((id) => session.targets[id] === wantTarget);
      if (tabId !== void 0) return tabId;
      if (Date.now() >= deadline) return void 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  function isInputStep(step) {
    return step.type === "click" || step.type === "doubleClick" || step.type === "drag" || step.type === "wheel" || step.type === "keyDown" || step.type === "keyUp";
  }
  var cursorAt = /* @__PURE__ */ new Map();
  async function cursor(tabId, action, point) {
    if (point && action !== "pulse") cursorAt.set(tabId, point);
    if (action === "hide") cursorAt.delete(tabId);
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { type: "cs-cursor", action, x: point?.x, y: point?.y },
        { frameId: 0 }
      );
    } catch {
    }
  }
  async function restoreCursor(tabId, viewport) {
    const point = cursorAt.get(tabId) ?? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
    await cursor(tabId, "place", point);
  }
  async function pointFor(tabId, step, meta) {
    if (!step.selectors?.length) return null;
    const frame = await resolveFrameId(tabId, meta?.frameChain);
    if (!frame) return null;
    try {
      const located = await chrome.tabs.sendMessage(
        tabId,
        { type: "cs-locate", step, meta, pointOnly: true },
        { frameId: frame.frameId }
      );
      return located?.ok ? { x: located.x, y: located.y } : null;
    } catch {
      return null;
    }
  }
  async function runExpressionStep(tabId, step) {
    const expression = step.expression ?? "true";
    const budget = Math.min(Math.max(step.timeout ?? 5e3, 500), 3e4);
    const deadline = Date.now() + budget;
    for (; ; ) {
      try {
        if (await evaluate(tabId, expression)) return { ok: true };
      } catch (err) {
        if (Date.now() >= deadline) {
          return { ok: false, error: err instanceof Error ? err.message : "evaluation failed" };
        }
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: `expression never became true within ${budget}ms: ${expression}`
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  var CDP_BUTTON = {
    primary: "left",
    secondary: "right",
    auxiliary: "middle"
  };
  async function runInputStep(tabId, step, meta, showCursor) {
    try {
      if (step.type === "keyDown" || step.type === "keyUp") {
        await key(tabId, step.type === "keyDown", step.key ?? "Enter");
        return { ok: true };
      }
      const frame = await resolveFrameId(tabId, meta?.frameChain);
      if (!frame) {
        return {
          ok: false,
          error: `frame ${frameSignature(meta?.frameChain)} never loaded in this tab`
        };
      }
      const located = await chrome.tabs.sendMessage(
        tabId,
        { type: "cs-locate", step, meta },
        { frameId: frame.frameId }
      );
      if (!located?.ok) {
        return { ok: false, error: located?.error ?? "tab did not respond" };
      }
      if (showCursor) await cursor(tabId, "move", located);
      switch (step.type) {
        case "click":
        case "doubleClick":
          if (showCursor) void cursor(tabId, "pulse");
          await click(
            tabId,
            located.x,
            located.y,
            CDP_BUTTON[step.button ?? "primary"] ?? "left",
            step.type === "doubleClick" ? 2 : 1
          );
          return { ok: true };
        case "drag": {
          const path = located.path ?? [];
          if (showCursor) {
            void (async () => {
              const gap = Math.min(Math.max((step.duration ?? 300) / (path.length || 1), 5), 40);
              for (const point of path) {
                await cursor(tabId, "move", {
                  x: located.x + point.x,
                  y: located.y + point.y
                });
                await new Promise((resolve) => setTimeout(resolve, gap));
              }
            })();
          }
          await drag(tabId, located, path, step.duration ?? 300);
          return { ok: true };
        }
        case "wheel":
          await wheel(tabId, located.x, located.y, step.deltaX ?? 0, step.deltaY ?? 0);
          return { ok: true };
        default:
          return { ok: false, error: `not an input step: ${step.type}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "input failed" };
    }
  }
  async function handleHub(message) {
    switch (message.kind) {
      case "ping":
        broadcast({ source: "tf-agent", kind: "bridge-ready" });
        return;
      // Session lifecycle goes on the queue: starting a session while the previous
      // one's last page event is still in flight would let that event write the old
      // session back over the new one. runStep deliberately does NOT — it waits for a
      // tab that a queued task binds, and queueing it would deadlock on itself.
      case "openAndRecord":
        await enqueue(() => startSession("record", message.url));
        return;
      case "openForReplay":
        await enqueue(() => startSession("replay", message.url));
        return;
      case "stop":
        await enqueue(() => stopSession());
        return;
      case "closeReplay":
        await enqueue(async () => {
          const session = await getSession();
          if (session?.mode !== "replay") return;
          await detachAll();
          for (const tabId of session.tabIds) {
            void chrome.tabs.remove(tabId).catch(() => {
            });
          }
          await setSession(null);
        });
        return;
      case "runStep": {
        const session = await getSession();
        if (session?.mode !== "replay") {
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: false,
            error: "no replay tab \u2014 Run opens one first"
          });
          return;
        }
        const wantTarget = message.meta?.targetId ?? ROOT_TARGET;
        const tabId = await findTarget(wantTarget, TARGET_WAIT_MS);
        if (tabId === void 0) {
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: false,
            error: `target ${wantTarget} is not open \u2014 the step that opens it may have failed`
          });
          return;
        }
        const showCursor = message.cursor !== false;
        if (isAttached(tabId) && isInputStep(message.step)) {
          const result = await runInputStep(tabId, message.step, message.meta, showCursor);
          broadcast({ source: "tf-agent", kind: "stepResult", id: message.id, ...result });
          return;
        }
        if (isAttached(tabId) && message.step.type === "waitForExpression" && !message.meta?.frameChain?.length) {
          const result = await runExpressionStep(tabId, message.step);
          broadcast({ source: "tf-agent", kind: "stepResult", id: message.id, ...result });
          return;
        }
        const frame = await resolveFrameId(tabId, message.meta?.frameChain);
        if (!frame) {
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: false,
            error: `frame ${frameSignature(message.meta?.frameChain)} never loaded in this tab`
          });
          return;
        }
        const note = isInputStep(message.step) ? "synthetic events \u2014 real input was unavailable (DevTools open, or another debugger attached). Pages that check isTrusted, :focus-visible or native scrolling may behave differently." : void 0;
        if (showCursor && message.step.selectors?.length) {
          const point = await pointFor(tabId, message.step, message.meta);
          if (point) {
            await cursor(tabId, "move", point);
            if (isInputStep(message.step)) void cursor(tabId, "pulse");
          }
        }
        try {
          const result = await chrome.tabs.sendMessage(
            tabId,
            {
              type: "cs-run",
              id: message.id,
              step: message.step,
              meta: message.meta
            },
            { frameId: frame.frameId }
          );
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: result?.ok ?? false,
            error: result?.error,
            note
          });
        } catch (err) {
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: false,
            error: err instanceof Error ? err.message : "tab did not respond"
          });
        }
        return;
      }
    }
  }
  var queue = Promise.resolve();
  function enqueue(work) {
    const next = queue.then(work, work);
    queue = next.catch(() => void 0);
    return next;
  }
  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      void enqueue(() => handleCs(message, sender)).then(
        sendResponse,
        () => sendResponse({ ok: false })
      );
      return true;
    }
  );
  async function pushStep(session, step, meta) {
    const path = meta.frameChain.map((link) => link.index);
    const id = session.nextStepId++;
    session.stepCount++;
    session.lastStepId = id;
    const stored = {
      ...step,
      id,
      target: meta.targetId === ROOT_TARGET ? "main" : session.targetUrls[meta.targetId] ?? meta.targetId,
      ...path.length > 0 ? { frame: path } : {},
      timestamp: Date.now()
    };
    try {
      await putStep(id, { step: stored, meta: { ...meta, stepId: id } });
    } catch (err) {
      session.stepCount--;
      session.storageError = `A step could not be stored, so this recording is incomplete: ${err instanceof Error ? err.message : "storage write failed"}. Stop and save what you have, or start again.`;
      throw err;
    }
    return stored;
  }
  async function handleCs(message, sender) {
    const session = await getSession();
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (message.type === "cs-get-mode") {
      const mode = session && session.mode !== "stopped" && tabId !== void 0 && session.tabIds.includes(tabId) ? session.mode : "off";
      return { mode };
    }
    if (tabId === void 0 || !session || session.mode === "stopped" || !session.tabIds.includes(tabId)) {
      return { ok: false };
    }
    const targetId = session.targets[tabId] ?? ROOT_TARGET;
    if (message.type === "cs-ready") {
      await registerFrame({
        tabId,
        frameId,
        key: frameKey(message.frameChain),
        signature: frameSignature(message.frameChain)
      });
      void setTabMode(tabId, session.mode);
      const isTopFrame = frameId === 0;
      if (isTopFrame && !session.targetUrls[targetId]) {
        session.targetUrls[targetId] = message.url;
      }
      if (message.env && !session.env) session.env = message.env;
      if (session.mode === "record" && isTopFrame) {
        const meta = { targetId, frameChain: [], tMono: message.tMono };
        if (session.stepCount === 0) {
          await pushStep(
            session,
            {
              type: "setViewport",
              width: message.width,
              height: message.height,
              deviceScaleFactor: message.dpr,
              isMobile: message.env?.isMobile ?? false,
              hasTouch: message.env?.hasTouch ?? false,
              isLandscape: message.width > message.height
            },
            meta
          );
          await pushStep(
            session,
            {
              type: "navigate",
              url: message.url,
              assertedEvents: [
                { type: "navigation", url: message.url, title: message.title }
              ]
            },
            meta
          );
        } else {
          const row = await getStep(session.lastStepId);
          const last = row?.step;
          if (last && (last.type === "click" || last.type === "doubleClick" || last.type === "keyDown") && !last.assertedEvents) {
            last.assertedEvents = [
              { type: "navigation", url: message.url, title: message.title }
            ];
            await putStep(session.lastStepId, row);
          }
        }
        await setSession(session);
        await broadcastSnapshot(session);
        void chrome.action.setBadgeText({
          tabId,
          text: String(session.stepCount)
        });
      } else {
        await setSession(session);
      }
      if (session.mode === "replay" && isTopFrame) {
        void restoreCursor(tabId, { width: message.width, height: message.height });
      }
      broadcast({
        source: "tf-agent",
        kind: "ready",
        url: message.url,
        title: message.title,
        width: message.width,
        height: message.height,
        dpr: message.dpr,
        targetId
      });
      return { ok: true };
    }
    if (message.type === "cs-settled") {
      broadcast({ source: "tf-agent", kind: "settled", url: message.url });
      return { ok: true };
    }
    if (message.type === "cs-step" && session.mode === "record") {
      const meta = { ...message.meta, targetId };
      let stored;
      try {
        stored = await pushStep(session, message.step, meta);
      } catch {
        await setSession(session);
        await broadcastSnapshot(session);
        return { ok: false };
      }
      await setSession(session);
      void chrome.action.setBadgeText({
        tabId,
        text: String(session.stepCount)
      });
      broadcast({
        source: "tf-agent",
        kind: "step",
        step: stored,
        meta: { ...meta, stepId: stored.id }
      });
      return { ok: true };
    }
    if (message.type === "cs-dialog" && session.mode === "record") {
      const row = session.stepCount > 0 ? await getStep(session.lastStepId) : void 0;
      if (row && !row.meta.dialog) {
        row.meta.dialog = message.dialog;
        await putStep(session.lastStepId, row);
        await broadcastSnapshot(session);
      }
      return { ok: true };
    }
    if (message.type === "cs-route" && session.mode === "record") {
      if (session.stepCount === 0) return { ok: true };
      const lastRow = await getStep(session.lastStepId);
      const last = lastRow?.step;
      if (!last) return { ok: true };
      if ((last.type === "click" || last.type === "doubleClick" || last.type === "keyDown" || last.type === "change") && !last.assertedEvents) {
        last.assertedEvents = [
          { type: "navigation", url: message.url, title: message.title }
        ];
        await putStep(session.lastStepId, lastRow);
      }
      const route = new URL(message.url);
      const expression = `location.pathname + location.hash === ${JSON.stringify(
        route.pathname + route.hash
      )}`;
      if (last.type !== "waitForExpression" || last.expression !== expression) {
        await pushStep(
          session,
          { type: "waitForExpression", expression },
          { targetId, frameChain: [], tMono: message.tMono }
        );
      }
      await setSession(session);
      await broadcastSnapshot(session);
      void chrome.action.setBadgeText({
        tabId,
        text: String(session.stepCount)
      });
      return { ok: true };
    }
    return { ok: false };
  }
  chrome.tabs.onCreated.addListener((tab) => {
    void enqueue(async () => {
      const session = await getSession();
      if (!session || tab.id === void 0) return;
      if (tab.openerTabId === void 0 || !session.tabIds.includes(tab.openerTabId)) return;
      session.tabIds.push(tab.id);
      session.targets[tab.id] = `t${session.nextTarget++}`;
      await setSession(session);
      if (session.mode === "replay") {
        await attach(tab.id);
      }
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void enqueue(async () => {
      void forgetTabFrames(tabId);
      void detach(tabId);
      const session = await getSession();
      if (!session || !session.tabIds.includes(tabId)) return;
      session.tabIds = session.tabIds.filter((id) => id !== tabId);
      delete session.targets[tabId];
      if (session.tabIds.length === 0) {
        await setSession(null);
        broadcast({ source: "tf-agent", kind: "stopped" });
      } else {
        await setSession(session);
      }
    });
  });
  chrome.downloads.onCreated.addListener((item) => {
    void enqueue(async () => {
      const session = await getSession();
      if (session?.mode !== "record") return;
      if (session.stepCount === 0) return;
      const row = await getStep(session.lastStepId);
      if (!row || row.meta.download) return;
      let name = item.filename ? item.filename.split(/[\\/]/).pop() : "";
      if (!name) {
        try {
          name = new URL(item.url).pathname.split("/").pop() ?? "";
        } catch {
          name = "";
        }
      }
      if (!name) return;
      row.meta.download = { filename: name };
      await putStep(session.lastStepId, row);
      await broadcastSnapshot(session);
    });
  });
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
})();
