"use strict";
(() => {
  // extension/src/sw/index.ts
  var KEY = "tf-session";
  async function getSession() {
    const data = await chrome.storage.session.get(KEY);
    return data[KEY] ?? null;
  }
  async function setSession(session) {
    if (session) await chrome.storage.session.set({ [KEY]: session });
    else await chrome.storage.session.remove(KEY);
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
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "tf-bridge") return;
    bridges.add(port);
    port.onDisconnect.addListener(() => bridges.delete(port));
    port.onMessage.addListener((message) => {
      void handleHub(message);
    });
    void getSession().then((session) => {
      port.postMessage({
        source: "tf-agent",
        kind: "snapshot",
        recording: session?.mode === "record",
        steps: session?.steps ?? []
      });
    });
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
    await setSession({
      mode,
      tabIds: [tab.id],
      steps: [],
      startedAt: Date.now(),
      sourceUrl: url
    });
  }
  async function stopSession() {
    const session = await getSession();
    if (!session) return;
    for (const tabId of session.tabIds) {
      void setTabMode(tabId, "off");
      void chrome.action.setBadgeText({ tabId, text: "" });
    }
    await setSession(null);
    broadcast({ source: "tf-agent", kind: "stopped" });
  }
  async function handleHub(message) {
    switch (message.kind) {
      case "ping":
        broadcast({ source: "tf-agent", kind: "bridge-ready" });
        return;
      case "openAndRecord":
        await startSession("record", message.url);
        return;
      case "openForReplay":
        await startSession("replay", message.url);
        return;
      case "stop":
        await stopSession();
        return;
      case "closeReplay": {
        const session = await getSession();
        if (session?.mode === "replay") {
          for (const tabId of session.tabIds) {
            void chrome.tabs.remove(tabId).catch(() => {
            });
          }
          await setSession(null);
        }
        return;
      }
      case "runStep": {
        const session = await getSession();
        const tabId = session?.mode === "replay" ? session.tabIds[0] : void 0;
        if (tabId === void 0) {
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: false,
            error: "no replay tab \u2014 Run opens one first"
          });
          return;
        }
        try {
          const result = await chrome.tabs.sendMessage(tabId, {
            type: "cs-run",
            id: message.id,
            step: message.step
          });
          broadcast({
            source: "tf-agent",
            kind: "stepResult",
            id: message.id,
            ok: result?.ok ?? false,
            error: result?.error
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
  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      queue = queue.then(() => handleCs(message, sender)).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
  );
  async function handleCs(message, sender) {
    const session = await getSession();
    const tabId = sender.tab?.id;
    if (message.type === "cs-get-mode") {
      const mode = session && session.mode !== "stopped" && tabId !== void 0 && session.tabIds.includes(tabId) ? session.mode : "off";
      return { mode };
    }
    if (tabId === void 0 || !session || session.mode === "stopped" || !session.tabIds.includes(tabId)) {
      return { ok: false };
    }
    if (message.type === "cs-ready") {
      void setTabMode(tabId, session.mode);
      if (session.mode === "record") {
        if (session.steps.length === 0) {
          const now = Date.now();
          session.steps.push(
            {
              type: "setViewport",
              width: message.width,
              height: message.height,
              deviceScaleFactor: message.dpr,
              isMobile: false,
              hasTouch: false,
              isLandscape: false,
              timestamp: now
            },
            {
              type: "navigate",
              url: message.url,
              assertedEvents: [
                { type: "navigation", url: message.url, title: message.title }
              ],
              timestamp: now
            }
          );
          broadcast({ source: "tf-agent", kind: "snapshot", recording: true, steps: session.steps });
        } else {
          const last = session.steps[session.steps.length - 1];
          if ((last.type === "click" || last.type === "doubleClick" || last.type === "keyDown") && !last.assertedEvents) {
            last.assertedEvents = [
              { type: "navigation", url: message.url, title: message.title }
            ];
          }
          broadcast({ source: "tf-agent", kind: "snapshot", recording: true, steps: session.steps });
        }
        await setSession(session);
        void chrome.action.setBadgeText({
          tabId,
          text: String(session.steps.length)
        });
      }
      broadcast({
        source: "tf-agent",
        kind: "ready",
        url: message.url,
        title: message.title,
        width: message.width,
        height: message.height,
        dpr: message.dpr
      });
      return { ok: true };
    }
    if (message.type === "cs-settled") {
      broadcast({ source: "tf-agent", kind: "settled", url: message.url });
      return { ok: true };
    }
    if (message.type === "cs-step" && session.mode === "record") {
      session.steps.push({ ...message.step, timestamp: Date.now() });
      await setSession(session);
      void chrome.action.setBadgeText({
        tabId,
        text: String(session.steps.length)
      });
      broadcast({ source: "tf-agent", kind: "step", step: message.step });
      return { ok: true };
    }
    return { ok: false };
  }
  chrome.tabs.onCreated.addListener((tab) => {
    void (async () => {
      const session = await getSession();
      if (!session || tab.id === void 0) return;
      if (tab.openerTabId !== void 0 && session.tabIds.includes(tab.openerTabId)) {
        session.tabIds.push(tab.id);
        await setSession(session);
      }
    })();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const session = await getSession();
      if (!session || !session.tabIds.includes(tabId)) return;
      session.tabIds = session.tabIds.filter((id) => id !== tabId);
      if (session.tabIds.length === 0) {
        await setSession(null);
        broadcast({ source: "tf-agent", kind: "stopped" });
      } else {
        await setSession(session);
      }
    })();
  });
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
})();
