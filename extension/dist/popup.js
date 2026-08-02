"use strict";
(() => {
  // extension/src/popup/popup.ts
  var STEP_PREFIX = "tf-s-";
  async function recordedSteps() {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all).filter(([key]) => key.startsWith(STEP_PREFIX)).map(([key, value]) => [Number(key.slice(STEP_PREFIX.length)), value]).sort((a, b) => a[0] - b[0]).map(([, value]) => value.step);
  }
  var statusEl = document.getElementById("status");
  var recordBtn = document.getElementById("record");
  var stopBtn = document.getElementById("stop");
  var downloadBtn = document.getElementById("download");
  var dashLink = document.getElementById("dash");
  var DASHBOARD_URL = "http://localhost:3000";
  dashLink.href = DASHBOARD_URL;
  async function getSession() {
    const data = await chrome.storage.session.get("tf-session");
    return data["tf-session"] ?? null;
  }
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  async function refresh() {
    const session = await getSession();
    if (session?.mode === "record") {
      statusEl.textContent = `\u25CF recording \u2014 ${session.stepCount} steps`;
      statusEl.className = "rec";
      recordBtn.hidden = true;
      stopBtn.hidden = false;
      downloadBtn.hidden = false;
    } else {
      statusEl.textContent = "Not recording.";
      statusEl.className = "";
      recordBtn.hidden = false;
      stopBtn.hidden = true;
      downloadBtn.hidden = session ? false : true;
    }
  }
  recordBtn.addEventListener("click", () => {
    void (async () => {
      const tab = await activeTab();
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
        statusEl.textContent = "Open a normal http(s) page first.";
        return;
      }
      await chrome.storage.session.remove("tf-frames");
      const previous = await chrome.storage.session.get(null);
      const stale = Object.keys(previous).filter((key) => key.startsWith(STEP_PREFIX));
      if (stale.length > 0) await chrome.storage.session.remove(stale);
      await chrome.storage.session.set({
        "tf-session": {
          mode: "record",
          tabIds: [tab.id],
          targets: { [tab.id]: "t0" },
          targetUrls: { t0: tab.url },
          nextTarget: 1,
          stepCount: 0,
          lastStepId: 0,
          nextStepId: 1,
          startedAt: Date.now(),
          sourceUrl: tab.url
        }
      });
      await chrome.tabs.sendMessage(tab.id, { type: "cs-set-mode", mode: "record" }).catch(() => {
      });
      await chrome.tabs.reload(tab.id);
      window.close();
    })();
  });
  stopBtn.addEventListener("click", () => {
    void (async () => {
      const session = await getSession();
      if (session) {
        for (const tabId of session.tabIds) {
          void chrome.tabs.sendMessage(tabId, { type: "cs-set-mode", mode: "off" }).catch(() => {
          });
          void chrome.action.setBadgeText({ tabId, text: "" });
        }
      }
      if (session) {
        await chrome.storage.session.set({
          "tf-session": { ...session, mode: "stopped" }
        });
      }
      await refresh();
    })();
  });
  downloadBtn.addEventListener("click", () => {
    void (async () => {
      const session = await getSession();
      if (!session) return;
      const flow = {
        title: `Recording ${(/* @__PURE__ */ new Date()).toLocaleString()}`,
        steps: await recordedSteps()
      };
      const url = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(flow, null, 4));
      const link = document.createElement("a");
      link.href = url;
      link.download = "recording.json";
      link.click();
    })();
  });
  void refresh();
  setInterval(() => void refresh(), 800);
})();
