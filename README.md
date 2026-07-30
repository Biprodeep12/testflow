# TestFlow

Record what you do in your browser, keep it as a Chrome-DevTools-Recorder flow, and
replay it as a test.

A Chrome extension records every interaction — on any site, across navigations,
through CSP, inside iframes — and streams the steps live into a Next.js dashboard.
Nothing is stored until you explicitly save; saved flows are exact DevTools Recorder
JSON, so they're importable into Chrome DevTools and directly runnable by
`@puppeteer/replay`.

```
extension (MV3)                          dashboard (Next.js + Firestore)
┌───────────────────────────┐            ┌─────────────────────────────┐
│ content script: recorder  │─ steps ───►│ Record page (React state)   │
│ service worker: sessions  │  via       │  └─ Save → flows/{id}       │
│ bridge (dashboard origin) │  bridge    │ Flow page: run-in-tab,      │
│ popup: record anywhere    │◄─ replay ──│  JSON / Playwright views    │
└───────────────────────────┘            └─────────────────────────────┘
```

## Quick start

```bash
npm install
npm run build:ext    # then chrome://extensions → Load unpacked → extension/dist
npm run dev          # http://localhost:3000
```

Full walkthrough (Firebase for saving, demo page, limits): **[SETUP.md](SETUP.md)**.
Design and the reasoning behind each pivot: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Layout

| Path | What |
|---|---|
| [extension/](extension/) | MV3 extension: recorder content script, service worker, bridge, popup |
| [src/pages/](src/pages/) | Record page, flows list/detail, `/api/flows` |
| [src/types/flow.ts](src/types/flow.ts) | DevTools Recorder types + the bridge message protocol |
| [src/codegen/fromFlow.ts](src/codegen/fromFlow.ts) | flow → Playwright source (export) |
| [scripts/](scripts/) | headless E2E: drives the real extension in Chromium |

## How it works

- **Recording** is a content script injected on every page at `document_start` — the
  reason an extension beats any injection trick: it survives hard navigations, ignores
  the page's CSP, sees iframes, and follows popups (`tabs.onCreated` joins them to the
  session).
- **Session state lives in the service worker** (`chrome.storage.session` — MV3
  workers get evicted, module memory doesn't survive). A dashboard reload rejoins a
  recording in progress via a state snapshot.
- **The bridge** content script runs only on the dashboard origin and relays
  `window.postMessage` ↔ `chrome.runtime` — the dashboard never needs the extension id.
- **Selectors** are computed at record time as ranked DevTools groups
  (`aria/` → css → `xpath/` → `pierce/` → `text/`); replay falls back through the
  list until one resolves.
- **Secrets:** password fields record an empty value; the recorder only captures
  trusted (real-user) events.

## Checks

```bash
npm run typecheck    # dashboard + extension
npm run lint
npm run e2e          # loads the built extension into Chromium, records, asserts JSON
npm run e2e:replay   # replays steps through the extension bridge
```
