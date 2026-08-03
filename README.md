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

Then replay a recording from the terminal:

```bash
npm run flow -- my-recording.tfflow.json          # exits 0 only if every step passed
npm run flow -- my-recording.tfflow.json --headed --speed recorded
```

Plain-English guide (what it does, what you have to do): **[GUIDE.md](GUIDE.md)**.
Engineering write-up (decisions, failure vocabulary, verification): **[REPORT.md](REPORT.md)**.
Full walkthrough (Firebase for saving, demo page, limits): **[SETUP.md](SETUP.md)**.
Design and the reasoning behind each pivot: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Layout

| Path | What |
|---|---|
| [extension/](extension/) | MV3 extension: recorder content script, service worker, bridge, popup |
| [src/pages/](src/pages/) | Record page, flows list/detail, `/api/flows` |
| [src/types/flow.ts](src/types/flow.ts) | DevTools Recorder types, the sidecars, the bridge message protocol |
| [src/shared/](src/shared/) | code that runs in the page for BOTH replay engines: element resolver, environment capture |
| [src/runner/](src/runner/) | the Playwright runner — an interpreter over the flow, plus the parity report |
| [src/codegen/fromFlow.ts](src/codegen/fromFlow.ts) | flow → Playwright source (readable export) |
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
  (`aria/` → css → `xpath/` → `pierce/` → `text/`); replay resolves every group and
  takes the element most of them agree on, so one stale selector cannot win.
- **Secrets:** password fields record an empty value; the recorder only captures
  trusted (real-user) events.

### What makes a replay match the recording

A flow that performs the same actions is not the same as a flow that looks the same.
Three things carry the difference, all stored beside the DevTools steps rather than
inside them — `steps` stays byte-compatible with DevTools, and downloads strip the rest.

- **Identity.** Every step records which tab (`t0`, `t1`… re-bound at replay to
  whatever windows the flow opens) and which frame (both the native DevTools index
  path and the iframe element's own selectors, which survive frame reordering). Replay
  addresses exactly that frame instead of broadcasting and taking the first answer.
- **Environment.** Viewport, device scale, scrollbar width, fonts (fingerprinted by
  measured width, which is the only way to catch a substituted typeface), locale,
  timezone, colour scheme and browser build are captured once. The runner applies what
  Playwright can emulate and *measures* the rest, so a difference is reported by name
  — `E_FONT_SUBSTITUTION`, `E_VIEWPORT_CLAMPED` — instead of surfacing later as an
  unexplained visual diff.
- **State and timing.** Scroll offsets of every container are restored before each
  step, gaps are paced from a monotonic clock, and `Date`/`Date.now` are pinned to the
  recording's own timeline so date-formatted content renders as it did.

SPA route changes are recorded as native `waitForExpression` steps asserting
`location.pathname + location.hash` — a state-tied wait, never a sleep, and no new
step type.

### Things a step alone cannot express

- **Dialogs.** `confirm()` blocks. A replay that cannot answer it hangs; one that
  answers differently takes the other branch. The answer the user gave is recorded
  and replayed by both engines.
- **Uploads.** The chosen file's bytes travel with the flow (capped at 256 kB, over
  which the step is marked degraded rather than silently unrunnable).
- **Secrets.** Passwords are recorded as a *name*, never a value. The runner takes
  them from `RunOptions.secrets` or `TESTFLOW_SECRET_*`, and fails naming the missing
  one instead of typing an empty string and calling it a pass.
- **Native drag-and-drop.** Indistinguishable from a pan gesture in pointer events,
  and completely different to replay — the browser's drag machinery only starts for
  real input. Recorded as native (with its `dataTransfer` types) so the difference is
  stated rather than discovered.
- **Downloads.** A click that produces a file changes nothing in the DOM, so a
  silently broken download would still pass every assertion. The filename is recorded
  and awaited.
- **Scroll anchors.** A raw `scrollTop` is meaningless in a virtualized list: 4200px
  is a different row once the data shifts. Each scrolled container also records the
  row at its top, so replay restores a position in *content*, and says so when that
  row is gone.
- **Permissions.** What the page already held, granted up front — replay cannot click
  a native permission bubble.

### Real input, and sealed runs

Both replay engines now drive Chrome's Input domain — Playwright directly, the
extension via `chrome.debugger` — so a replayed click is `isTrusted` in both. When
the extension cannot attach, it falls back to synthetic events and labels the
affected steps. See [SETUP.md](SETUP.md) for why the permission is requested.

In-browser replay also draws a **visible cursor** that glides to each target before
acting (toggleable per run). It is `pointer-events: none` for a load-bearing reason:
the replayer hit-tests with `elementFromPoint` before every click, so a cursor that
could be hit would fail the run as occluded by its own pointer. The Playwright runner
has no cursor — nothing is watching it.

`runFlow(flow, { har: { path, mode: "record" | "replay" } })` gives sealed replay:
record the network once, then serve every request from the archive with
`notFound: "abort"`. Combined with the pinned clock and a seeded PRNG, a sealed run
is a pure function of the flow plus the archive — the only mode where a difference
in what the page rendered is a *result* rather than information. Requests the
recording never saw are reported, never silently fetched.

## Checks

```bash
npm test             # unit tests — pure functions, no browser, ~1.5s
npm run typecheck    # dashboard + extension
npm run lint
npm run e2e          # loads the built extension into Chromium, records, asserts JSON
npm run e2e:replay   # replays steps through the extension bridge
npm run e2e:runner   # replays a flow through Playwright: frames, popups, routes, parity
npm run e2e:cli      # the round trip a user takes: record → export bundle → npm run flow
npm run e2e:long     # 200 steps: per-step cost, sidecar alignment at length, replay
npm run e2e:anchor   # anchored selectors and the fragile chip, on hostile markup
```

The E2E suites need `npm run dev` up on :3000, **with auth off** — they drive the
dashboard as an anonymous user, so the sign-in wall blocks them:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY= NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN= \
NEXT_PUBLIC_FIREBASE_PROJECT_ID= npm run dev
```

242 checks in total (56 unit, 186 end-to-end).
