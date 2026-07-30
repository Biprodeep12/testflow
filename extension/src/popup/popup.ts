/**
 * Popup — record/stop from any tab, without the dashboard being open.
 * The dashboard remains the place to review, save, and replay.
 */

type Session = {
  mode: "record" | "replay" | "stopped";
  tabIds: number[];
  steps: unknown[];
  sourceUrl: string;
};

const statusEl = document.getElementById("status") as HTMLElement;
const recordBtn = document.getElementById("record") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const downloadBtn = document.getElementById("download") as HTMLButtonElement;
const dashLink = document.getElementById("dash") as HTMLAnchorElement;

const DASHBOARD_URL = "http://localhost:3000";
dashLink.href = DASHBOARD_URL;

async function getSession(): Promise<Session | null> {
  const data = await chrome.storage.session.get("tf-session");
  return (data["tf-session"] as Session | undefined) ?? null;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh(): Promise<void> {
  const session = await getSession();
  if (session?.mode === "record") {
    statusEl.textContent = `● recording — ${session.steps.length} steps`;
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
    // Mark THIS tab as the session (no new tab): store the session directly, then
    // flip the content script on and reload-free seed via its cs-ready round trip.
    await chrome.storage.session.set({
      "tf-session": {
        mode: "record",
        tabIds: [tab.id],
        steps: [],
        startedAt: Date.now(),
        sourceUrl: tab.url,
      },
    });
    await chrome.tabs
      .sendMessage(tab.id, { type: "cs-set-mode", mode: "record" })
      .catch(() => {});
    // Seed steps: ask the content script to re-announce.
    await chrome.tabs.reload(tab.id); // simplest reliable seed: reload announces
    window.close();
  })();
});

stopBtn.addEventListener("click", () => {
  void (async () => {
    const session = await getSession();
    if (session) {
      for (const tabId of session.tabIds) {
        void chrome.tabs
          .sendMessage(tabId, { type: "cs-set-mode", mode: "off" })
          .catch(() => {});
        void chrome.action.setBadgeText({ tabId, text: "" });
      }
    }
    // Keep the steps around for Download until a new session starts.
    if (session) {
      await chrome.storage.session.set({
        "tf-session": { ...session, mode: "stopped" },
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
      title: `Recording ${new Date().toLocaleString()}`,
      steps: session.steps,
    };
    const url =
      "data:application/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(flow, null, 4));
    const link = document.createElement("a");
    link.href = url;
    link.download = "recording.json";
    link.click();
  })();
});

void refresh();
setInterval(() => void refresh(), 800);
