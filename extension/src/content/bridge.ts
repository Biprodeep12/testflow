/**
 * Bridge content script — runs ONLY on the dashboard origin (see manifest matches).
 *
 * Relays window.postMessage (dashboard page) <-> chrome.runtime port (service
 * worker). This is how the dashboard talks to the extension without knowing its id:
 * the page posts `tf-hub` messages, the extension answers with `tf-agent` messages —
 * the exact protocol the v2 tab agent spoke, so the dashboard barely changed.
 */

import type { AgentMessage, HubMessage } from "../shared/flow";

let port: chrome.runtime.Port | null = null;

function connect(): chrome.runtime.Port {
  const fresh = chrome.runtime.connect({ name: "tf-bridge" });
  fresh.onMessage.addListener((message: AgentMessage) => {
    window.postMessage(message, window.location.origin);
  });
  fresh.onDisconnect.addListener(() => {
    // SW evicted — reconnect lazily on the next outgoing message.
    if (port === fresh) port = null;
  });
  return fresh;
}

function getPort(): chrome.runtime.Port {
  if (!port) port = connect();
  return port;
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return; // only the page itself
  const data = event.data as HubMessage | undefined;
  if (!data || data.source !== "tf-hub") return;
  try {
    getPort().postMessage(data);
  } catch {
    // Extension reloaded — one retry with a fresh port.
    port = null;
    try {
      getPort().postMessage(data);
    } catch {
      /* give up quietly; the page's timeouts handle it */
    }
  }
});

// Announce on load so the dashboard can flip from "install the extension" to ready.
getPort();
window.postMessage(
  { source: "tf-agent", kind: "bridge-ready" } satisfies AgentMessage,
  window.location.origin,
);
