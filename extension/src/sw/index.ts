/**
 * Service worker — owns sessions and routes everything.
 *
 * MV3 workers are evicted after ~30s idle, so ALL session state lives in
 * chrome.storage.session (survives eviction, dies with the browser — right lifetime
 * for an unsaved recording). Steps are seeded exactly like DevTools: setViewport +
 * navigate(assertedEvents) on the first page ready, assertedEvents pinned onto the
 * causing step on later loads.
 */

import type {
  AgentMessage,
  CsToSw,
  FlowStep,
  HubMessage,
  TabMode,
} from "../shared/flow";

type Session = {
  /** "stopped" keeps the steps around for popup Download until a new session starts */
  mode: "record" | "replay" | "stopped";
  /** every tab participating (popups the flow opened join automatically) */
  tabIds: number[];
  steps: FlowStep[];
  startedAt: number;
  sourceUrl: string;
};

const KEY = "tf-session";

/* ---------------------------------------------------------------- *
 * Session state (storage-backed, eviction-safe)
 * ---------------------------------------------------------------- */

async function getSession(): Promise<Session | null> {
  const data = await chrome.storage.session.get(KEY);
  return (data[KEY] as Session | undefined) ?? null;
}

async function setSession(session: Session | null): Promise<void> {
  if (session) await chrome.storage.session.set({ [KEY]: session });
  else await chrome.storage.session.remove(KEY);
}

/* ---------------------------------------------------------------- *
 * Bridge ports (dashboard tabs) — live connections, re-established by the bridge
 * content script on every dashboard load, so eviction only drops them momentarily.
 * ---------------------------------------------------------------- */

const bridges = new Set<chrome.runtime.Port>();

function broadcast(message: AgentMessage): void {
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
  port.onMessage.addListener((message: HubMessage) => {
    void handleHub(message);
  });
  // A dashboard connecting mid-recording gets the full state — a dashboard reload
  // no longer loses the recording.
  void getSession().then((session) => {
    port.postMessage({
      source: "tf-agent",
      kind: "snapshot",
      recording: session?.mode === "record",
      steps: session?.steps ?? [],
    } satisfies AgentMessage);
  });
});

/* ---------------------------------------------------------------- *
 * Dashboard commands
 * ---------------------------------------------------------------- */

async function setTabMode(tabId: number, mode: TabMode): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "cs-set-mode", mode });
  } catch {
    // Tab not ready yet — the content script will ask via cs-get-mode on load.
  }
}

async function startSession(
  mode: "record" | "replay",
  url: string,
): Promise<void> {
  const existing = await getSession();
  if (existing) await stopSession(); // one session at a time, by design

  const tab = await chrome.tabs.create({ url, active: true });
  await setSession({
    mode,
    tabIds: [tab.id!],
    steps: [],
    startedAt: Date.now(),
    sourceUrl: url,
  });
}

async function stopSession(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  for (const tabId of session.tabIds) {
    void setTabMode(tabId, "off");
    void chrome.action.setBadgeText({ tabId, text: "" });
  }
  await setSession(null);
  broadcast({ source: "tf-agent", kind: "stopped" });
}

async function handleHub(message: HubMessage): Promise<void> {
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
          void chrome.tabs.remove(tabId).catch(() => {});
        }
        await setSession(null);
      }
      return;
    }
    case "runStep": {
      const session = await getSession();
      const tabId = session?.mode === "replay" ? session.tabIds[0] : undefined;
      if (tabId === undefined) {
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: "no replay tab — Run opens one first",
        });
        return;
      }
      try {
        const result = (await chrome.tabs.sendMessage(tabId, {
          type: "cs-run",
          id: message.id,
          step: message.step,
        })) as { ok: boolean; error?: string } | undefined;
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: result?.ok ?? false,
          error: result?.error,
        });
      } catch (err) {
        // The step navigated the page — the receiving document died before replying.
        // The fresh page's cs-ready becomes the signal; report a soft failure the
        // player already knows how to interpret.
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: err instanceof Error ? err.message : "tab did not respond",
        });
      }
      return;
    }
  }
}

/* ---------------------------------------------------------------- *
 * Content-script events
 * ---------------------------------------------------------------- */

// Handlers are serialized: two rapid cs-step messages would otherwise both read the
// same stored session, each push one step, and the second write would erase the first.
let queue: Promise<unknown> = Promise.resolve();

chrome.runtime.onMessage.addListener(
  (message: CsToSw, sender, sendResponse: (r: unknown) => void) => {
    queue = queue
      .then(() => handleCs(message, sender))
      .then(sendResponse, () => sendResponse({ ok: false }));
    return true; // always responds async
  },
);

async function handleCs(
  message: CsToSw,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const session = await getSession();
  const tabId = sender.tab?.id;

      if (message.type === "cs-get-mode") {
        const mode: TabMode =
          session &&
          session.mode !== "stopped" &&
          tabId !== undefined &&
          session.tabIds.includes(tabId)
            ? session.mode
            : "off";
        return { mode };
      }

      if (
        tabId === undefined ||
        !session ||
        session.mode === "stopped" ||
        !session.tabIds.includes(tabId)
      ) {
        return { ok: false };
      }

      if (message.type === "cs-ready") {
        // Make sure the (possibly re-injected) content script knows its mode.
        void setTabMode(tabId, session.mode);

        if (session.mode === "record") {
          if (session.steps.length === 0) {
            // Seed the flow exactly the way DevTools does.
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
                timestamp: now,
              },
              {
                type: "navigate",
                url: message.url,
                assertedEvents: [
                  { type: "navigation", url: message.url, title: message.title },
                ],
                timestamp: now,
              },
            );
            broadcast({ source: "tf-agent", kind: "snapshot", recording: true, steps: session.steps });
          } else {
            // A later load = navigation caused by the last interaction.
            const last = session.steps[session.steps.length - 1];
            if (
              (last.type === "click" ||
                last.type === "doubleClick" ||
                last.type === "keyDown") &&
              !last.assertedEvents
            ) {
              last.assertedEvents = [
                { type: "navigation", url: message.url, title: message.title },
              ];
            }
            broadcast({ source: "tf-agent", kind: "snapshot", recording: true, steps: session.steps });
          }
          await setSession(session);
          void chrome.action.setBadgeText({
            tabId,
            text: String(session.steps.length),
          });
        }

        // Both modes: tell the dashboard a page finished loading.
        broadcast({
          source: "tf-agent",
          kind: "ready",
          url: message.url,
          title: message.title,
          width: message.width,
          height: message.height,
          dpr: message.dpr,
        });
        return { ok: true };
      }

      if (message.type === "cs-settled") {
        broadcast({ source: "tf-agent", kind: "settled", url: message.url });
        return { ok: true };
      }

      if (message.type === "cs-step" && session.mode === "record") {
        // Stamped here (not in the page) so one clock orders steps across tabs.
        session.steps.push({ ...message.step, timestamp: Date.now() });
        await setSession(session);
        void chrome.action.setBadgeText({
          tabId,
          text: String(session.steps.length),
        });
        broadcast({ source: "tf-agent", kind: "step", step: message.step });
        return { ok: true };
      }

      return { ok: false };
}

/* ---------------------------------------------------------------- *
 * Multi-tab: a popup opened from a session tab joins the session — the thing the
 * v2 opener-based design fundamentally could not do.
 * ---------------------------------------------------------------- */

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    const session = await getSession();
    if (!session || tab.id === undefined) return;
    if (tab.openerTabId !== undefined && session.tabIds.includes(tab.openerTabId)) {
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
      // Last session tab closed = the user is done. Recording stays in storage
      // until saved or a new session starts? No — closing every tab ends it.
      await setSession(null);
      broadcast({ source: "tf-agent", kind: "stopped" });
    } else {
      await setSession(session);
    }
  })();
});

chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
