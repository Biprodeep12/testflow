"use strict";
(() => {
  // extension/src/content/bridge.ts
  var port = null;
  function connect() {
    const fresh = chrome.runtime.connect({ name: "tf-bridge" });
    fresh.onMessage.addListener((message) => {
      window.postMessage(message, window.location.origin);
    });
    fresh.onDisconnect.addListener(() => {
      if (port === fresh) port = null;
    });
    return fresh;
  }
  function getPort() {
    if (!port) port = connect();
    return port;
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "tf-hub") return;
    try {
      getPort().postMessage(data);
    } catch {
      port = null;
      try {
        getPort().postMessage(data);
      } catch {
      }
    }
  });
  getPort();
  window.postMessage(
    { source: "tf-agent", kind: "bridge-ready" },
    window.location.origin
  );
})();
