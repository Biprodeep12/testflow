# The TestFlow extension — exactly how it works

A Manifest V3 Chrome extension that records browser sessions as Chrome DevTools
Recorder flows and replays them. It is the *capture and in-browser execution* layer;
the Next.js dashboard owns storage, review, and codegen, and the Playwright runner is
the second execution engine.

Everything below is drawn from the source in [extension/](extension/) and the shared
modules it bundles from [src/shared/](src/shared/) and [src/types/flow.ts](src/types/flow.ts).

---

## 1. Build and shape

`npm run build:ext` runs [build.mjs](extension/build.mjs): esbuild, no framework, five
entry points bundled IIFE into `extension/dist/`, plus a copy of the manifest and
`popup.html`. `extension/dist/` is the folder you "Load unpacked" at
`chrome://extensions`.

| Bundle | Source | Runs in |
|---|---|---|
| `recorder.js` | [content/recorder.ts](extension/src/content/recorder.ts) | isolated world, every frame, `document_start` |
| `main-world.js` | [content/main-world.ts](extension/src/content/main-world.ts) | **page** world, every frame, `document_start` |
| `bridge.js` | [content/bridge.ts](extension/src/content/bridge.ts) | isolated world, dashboard origin only, `document_idle` |
| `sw.js` | [sw/index.ts](extension/src/sw/index.ts) + [sw/cdp.ts](extension/src/sw/cdp.ts) | MV3 service worker |
| `popup.js` | [popup/popup.ts](extension/src/popup/popup.ts) | action popup |

[manifest.json](extension/manifest.json) — MV3. Permissions: `storage`, `tabs`,
`debugger`, `downloads`. Host permissions: `<all_urls>`. The bridge is matched only on
`http://localhost:3000/*`, which is why the dashboard never needs to know the
extension's id.

[shared/flow.ts](extension/src/shared/flow.ts) is a one-line re-export of the
dashboard's [src/types/flow.ts](src/types/flow.ts) — the extension and the app compile
against literally the same types, and the types vanish at build time so no Next.js code
lands in the bundle.

---

## 2. Component topology

```
 page world           isolated world              extension
┌──────────────┐     ┌──────────────────┐      ┌───────────────────────┐
│ main-world.js│◄───►│   recorder.js    │◄────►│      sw.js            │
│  kbd events  │ Cus │ record + replay  │chrome│  sessions, routing,   │
│  history.*   │ tom │ selectors, cursor│.runt │  storage, CDP input   │
│  alert/…     │Event│ frame identity   │ ime  │                       │
│  eval        │     └──────────────────┘      └───────┬───────────────┘
└──────────────┘                                       │ port "tf-bridge"
                                                       ▼
                     dashboard page  ◄─postMessage─► bridge.js
```

Four hops, each chosen because the one before it cannot cross the boundary:

1. **page ↔ isolated world**: `CustomEvent` with a **JSON string** in `detail`.
   Only primitives survive Chrome's world boundary, so objects are serialized.
2. **isolated world ↔ SW**: `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
   Immune to page CSP and to the page's origin, and re-injected automatically after
   every navigation.
3. **frame ↔ parent frame**: `window.postMessage` — the only cross-origin channel.
4. **SW ↔ dashboard**: a long-lived `chrome.runtime.Port` to the bridge, which relays
   to the page with `window.postMessage(msg, location.origin)`.

---

## 3. Session model (service worker)

MV3 workers are evicted after ~30s idle, so **no session state lives in module memory**.
Everything is in `chrome.storage.session` (survives eviction, dies with the browser —
the correct lifetime for an unsaved recording).

Three key families:

| Key | Holds |
|---|---|
| `tf-session` | the `Session` object — bookkeeping only |
| `tf-s-<id>` | one recorded step + its sidecar: `{ step, meta }` |
| `tf-frames` | the frame registry, capped at the last 300 entries |

The `Session` ([sw/index.ts:38](extension/src/sw/index.ts#L38)) holds `mode`
(`record` | `replay` | `stopped`), `tabIds`, `targets` (tabId → logical id),
`targetUrls`, `stepCount`, `lastStepId`, `nextStepId`, `env`, `startedAt`, `sourceUrl`,
and an optional `storageError`.

**Steps are deliberately not in the session object.** One key per step means the cost of
recording a step is constant; keeping them inline rewrote the whole recording on every
step — linear per step, quadratic per session.
[`getRecorded()`](extension/src/sw/index.ts#L80) reassembles them in id order and is
only called for snapshots and saves, never per step.

### The serialization queue

Every handler that touches the session goes through
[`enqueue()`](extension/src/sw/index.ts#L666). All of them do read-modify-write on one
storage key, so two overlapping handlers means the second writes a session it read
before the first one's change — and that change is simply gone. A popup joining the
session at the same instant its first page announces itself is exactly that collision.

`runStep` is the one deliberate exception: it waits for a tab that a *queued* task binds,
so queueing it would deadlock on itself.

### Session lifecycle

- **Dashboard → record**: `openAndRecord` → [`startSession`](extension/src/sw/index.ts#L237)
  creates a **new tab**, clears frames and steps, writes the session.
- **Dashboard → replay**: `openForReplay` → same, plus `cdp.attach(tab.id)`.
- **Popup → record**: marks the **current** tab instead — writes the session directly,
  sends `cs-set-mode`, then `chrome.tabs.reload()` as the simplest reliable way to
  trigger the seeding `cs-ready` announcement.
- **Stop**: `stopSession` detaches all debuggers, sets every tab to `off`, clears badges,
  deletes the session, broadcasts `stopped`. The popup's Stop is softer — it flips the
  session to `"stopped"` so **Download JSON** still works, and does not broadcast.
- **Last tab closed** → session deleted, `stopped` broadcast
  ([tabs.onRemoved](extension/src/sw/index.ts#L972)).

---

## 4. Recording

The content script is **inert until told otherwise**. On load it asks
`cs-get-mode` and gets `off` unless its tab is in the session, so ordinary browsing costs
nothing ([recorder.ts:1763](extension/src/content/recorder.ts#L1763)).

Every listener is registered in the **capture phase** with `isTrusted` required, so a
step is recorded before the page's own handler runs — which is what makes the
"dialog belongs to the last step" and "navigation belongs to the last step" rules valid.

### 4.1 The selector engine

[`describeElement`](extension/src/content/recorder.ts#L231) produces as many *independent*
descriptions as the element offers, **ordered most-durable first**. The order is also the
tie-break during consensus resolution and drives which locator Playwright codegen prefers.

1. `[data-testid=…]` and friends (`data-test`, `data-test-id`, `data-cy`, `data-qa`)
2. `aria/<accessible name>` — from `aria-label`, `aria-labelledby`, `<label>`, `alt`,
   `title`, `placeholder`, or short text content
3. Stable attributes: `input[name=…]`, `[placeholder=…]`, `a[href=…]`, `[title=…]`
4. Structure: CSS path, `xpath/…`, `pierce/…` (shadow-piercing)
5. `text/<first 25 chars>` — leaf elements only

Three performance decisions are load-bearing, because this runs synchronously inside the
page's own click handler:

- [`resolvesTo`](extension/src/content/recorder.ts#L196) uses `querySelector(...) === el`,
  not `querySelectorAll(...).length === 1` — it short-circuits, and it asks exactly the
  question replay will ask.
- [`ancestorPath`](extension/src/content/recorder.ts#L132) walks the ancestor chain
  **once** and both the CSS path and the XPath are built from it.
- [`accName`](extension/src/content/recorder.ts#L71) bails on `childElementCount > 8`
  rather than serializing a container's whole subtree just to have the 60-char limit
  throw it away.

Cost is measured, not assumed: `selectorMs` accumulates and
[`record()`](extension/src/content/recorder.ts#L406) `console.warn`s with a
describe-vs-scroll-state breakdown when a step crosses 120ms.

### 4.2 What each event produces

| Gesture | Step | Notes |
|---|---|---|
| click | `click` + `offsetX/Y` | pending wheel burst is flushed first so ordering holds |
| right-click | `click` with `button: "secondary"` | native DevTools field |
| dblclick | `doubleClick` | |
| pointer drag | `drag` (TestFlow extension) | 5px threshold, path sampled every 40ms, max 40 points, **relative to the start point**; tail click suppressed for 200ms |
| HTML5 drag | `drag` + `meta.nativeDrag` | `dragstart`/`drag`/`dragend`, because pointer events stop firing once the drag machinery takes over |
| change on input/textarea/select | `change` + `value` + `tagName` | checkbox/radio/button/submit/reset are ignored — they're clicks |
| password change | `change` with `value: ""` + `meta.secretRef` | the secret never leaves the page |
| file input | `change` + `meta.upload` | base64 inline, capped at `MAX_UPLOAD_BYTES` (256 KB) |
| Enter/Tab/Esc/arrows, or any key under Ctrl/Alt/Meta | `keyDown` + `keyUp` | modifiers are emitted **lazily** — only when they actually modify a recordable key |
| user scroll | `scroll` | debounced 350ms, one step per container per burst |
| consumed wheel | `wheel` (TestFlow extension) | see below |
| SPA route change | `waitForExpression` | see §4.5 |

**Scroll intent.** A `scroll` event is `isTrusted: true` no matter who caused it, so it
cannot distinguish a wheel flick from the site calling `scrollIntoView()`. What can: the
*input* that produced it. Wheel/touchmove open a 250ms window, scroll keys a 700ms one,
and a scroll outside any window is treated as site-initiated and ignored
([recorder.ts:899](extension/src/content/recorder.ts#L899)). Known gap: dragging the
scrollbar with the mouse produces no wheel events and is not captured.

**Consumed wheel.** A map, carousel, or canvas calls `preventDefault()` on wheel and
zooms — no scroll event ever fires. The wheel burst is accumulated with a 400ms
debounce; if it produced no scroll, it was consumed, and it becomes a `wheel` step.
`wheel` and `drag` are the only two step types TestFlow adds to the DevTools schema.

### 4.3 The sidecar (`StepMeta`)

Every step carries a parallel record that lives *outside* the step object, so
`exportSteps()` still yields byte-compatible DevTools JSON. Built in
[`record()`](extension/src/content/recorder.ts#L406):

- `frameChain` — which iframe, richly (§5)
- `targetId` — which logical tab, stamped by the SW
- `tMono` — `performance.timeOrigin + performance.now()`, **monotonic**. Wall-clock is
  subject to NTP steps, which silently turns a 200ms gap into a negative one; gaps are
  exactly what "replay as recorded" paces against.
- `rect` — element geometry at action time, so "clicked, but somewhere else" is diagnosable
- `scrollState` — every container scrolled away from origin, with an **anchor**
- `dialog`, `upload`, `download`, `secretRef`, `nativeDrag`
- `degraded` — `"positional-only"` or `"upload-truncated"`

**Scroll anchors.** [`anchorFor`](extension/src/content/recorder.ts#L339) records what was
at the top of a scrolled container and how far past it we were — a position in *content*,
not in pixels. A raw `scrollTop` of 4200px means a different row once a virtualized list
recycles or an infinite feed loads a different number of items. It measures against the
content box (`rect.top + borderTopWidth`) because replay resolves it the same way; if the
two disagreed, every restore would be off by the border width.

**Degradation is declared at record time.**
[`isPositionalOnly`](extension/src/content/recorder.ts#L393) checks whether the element
offered nothing but its position in the tree. Such a step replays fine today and breaks on
the next markup change, so the recording says so rather than letting replay discover it.

Only containers the user actually scrolled are tracked (`scrolledContainers`, a `Set`), so
serializing scroll state is O(touched) rather than O(DOM nodes) on the interaction path.
Element descriptions are memoized in a `WeakMap` and **validated before reuse** — one
short-circuiting `querySelector` confirming the description still points at the same
element.

### 4.4 Step ordering

`chainReady` is a single shared promise resolved when the session turns on
([recorder.ts:1568](extension/src/content/recorder.ts#L1568)). Every step does
`chainReady.then(send)`, so callbacks fire in registration order and ordering survives
even when the frame chain takes a moment to negotiate.

### 4.5 Seeding, navigations, and SPA routes

On the first top-frame `cs-ready`, the SW seeds the flow **exactly the way DevTools does**
([sw/index.ts:780](extension/src/sw/index.ts#L780)): `setViewport` (from the reported
viewport, dpr, and the env record's `isMobile`/`hasTouch`) followed by `navigate` with an
`assertedEvents: [{ type: "navigation", url, title }]`.

On *later* loads, the load was caused by the last interaction — so the SW reads that **one**
step and pins `assertedEvents` onto it, rather than rewriting the recording.

An SPA route change produces no page load at all. `main-world.js` patches
`history.pushState`/`replaceState`, listens to `popstate`, `hashchange`, and the
Navigation API's `navigatesuccess`, and reports the new URL. The SW turns it into a
**native `waitForExpression`**:

```js
location.pathname + location.hash === "/checkout"
```

Query strings are dropped — they carry session tokens and cache-busters that differ every
run. Recording it as a native step means the flow model stays pure DevTools and both
replay engines already know how to execute it. No new step type, no sleep, no guessing.

### 4.6 Dialogs, downloads, environment

**Dialogs.** `alert`/`confirm`/`prompt` are page functions and they *block*.
`main-world.js` patches all three: while recording it calls the real one and then reports
what the user answered; the answer is attached to the last recorded step (valid because
interactions are captured on the capture phase).

**Downloads.** Two independent sources.
[`downloadFor`](extension/src/content/recorder.ts#L715) reads `<a download="…">` at the
source — exact, and available before the download starts. `chrome.downloads.onCreated` in
the SW covers the JS-initiated case, deriving the name from `item.filename` or the URL
path. If neither yields an honest name, nothing is recorded — better absent than invented.

**Environment.** [`captureEnv()`](src/shared/env.ts#L40) runs once, top frame only, first
one wins. Viewport, `layoutWidth`, **`scrollbarWidth`** (`innerWidth - clientWidth` —
classic vs overlay scrollbars shift every centered element by ~7-8px, the single
most-missed source of whole-page drift), dpr, screen, UA, locale, languages, timezone,
`timeOrigin`, color scheme, reduced motion, forced colors, touch, WebGL vendor/renderer,
and **font probes**: canvas `measureText` widths of fixed strings per family in use, which
is the only way to detect that "Inter" silently fell back to Arial. Permissions are read
asynchronously and merged in.

### 4.7 Storage failure

[`pushStep`](extension/src/sw/index.ts#L689) is the single place allowed to append. If the
write fails (storage full, most likely), it decrements the count and sets
`session.storageError`, which rides on every snapshot to the dashboard. A recording that
silently lost a step in the middle is worse than one that stopped, because it looks
complete and replays as something the user never did.

### 4.8 Feedback

Two indicators: a `chrome.action` badge with the live step count on a red background, and
a `#__tf_badge` pill in the page's bottom-right (top frame only, `pointer-events: none`).
Clicks on the badge are ignored by every handler via `el.closest("#__tf_badge")`.

---

## 5. Frame and tab identity

### Frames

**A frame cannot describe itself** — only the parent document can see the `<iframe>`
element hosting it. So [frames.ts](extension/src/content/frames.ts) has every frame ask
its parent "who am I?" over `postMessage`, and the parent answers with *its own* chain
plus the link to this child. The chain builds top-down and terminates at the main frame,
which answers `[]`. Asked every 200ms (the parent's content script may still be starting
at `document_start`), giving up after 4s with `[]`.

Each `FrameLink` carries **two identities**, because each fails differently:

- `index` — the native DevTools frame path; breaks when frames are reordered
- `selectors` — the `<iframe>` **element's** selector groups, produced by the parent;
  survives reordering, and is what Playwright's `frameLocator()` actually needs

`myViewportOffset()` is a second handshake (`whereami`/`youareat`) that walks up the tree
summing each iframe element's **content** origin (`rect + borderWidth + padding`). Real
input is dispatched in top-frame coordinates, but an element inside an iframe only knows
its position in its own document. It is **never cached** — scrolling the parent moves the
child, and a stale offset aims the click at the wrong place.

Every frame announces itself via `cs-ready`, and the SW keeps a registry.
[`resolveFrameId`](extension/src/sw/index.ts#L164) matches by **signature first**, index
second — the same precedence as the Playwright runner's `frameFor()`, because the two
executors must pick the same frame or the flow means two different things. It is never a
broadcast: sending a step to every frame and taking the fastest reply is how a step lands
in the wrong document.

### Tabs

Real tab ids differ every run, so steps reference **logical targets**: `t0` is where the
session started, `t1` the first popup it opened, and so on. `tabs.onCreated` adds any tab
whose opener is in the session ([sw/index.ts:947](extension/src/sw/index.ts#L947)) and
numbers it in open order — the same order during recording and replay, which re-binds
`t1` to the right window without depending on ids.

In replay, **every** tab gets a debugger attach, not just the first. A synthetic click
carries no user activation, and Chrome's popup blocker refuses `target="_blank"` and
`window.open()` without it — so a popup driven by synthetic events silently never opens
while same-tab navigation from the identical click works fine.

---

## 6. Replay

**The service worker owns the whole run.** The dashboard sends a single
`startReplay { runId, flowId, flow, options }` — the entire flow (steps, sidecars,
timeout) plus the run options (speed, cursor) — and from then on only renders what the
worker streams back: one `runProgress { runId, index, status, error?, note? }` per step
state change and a final `runDone { runId, ok, error? }`
([src/pages/flows/[id].tsx](src/pages/flows/[id].tsx) is a monitor, not a controller).
The single-step `runStep`/`stepResult` path still exists (the e2e scripts drive it) and
executes through the same `runOneStep()` — one execution path, two callers.

The loop used to live in the dashboard page, and that was a real defect: the dashboard
tab is hidden the moment the replay tab takes focus, and Chrome throttles a hidden
page's timers toward one tick per second (and further after five minutes) — so
"as recorded" pacing was quietly distorted, timeouts fired late, and a dashboard reload
killed the run outright because its state lived in a React ref. The worker is not
throttled, and a reloading dashboard rejoins the live run via the `run` field carried on
the snapshot every (re)connect already receives.

How the run loop holds itself together ([sw/index.ts](extension/src/sw/index.ts)):

- **Run state** is split exactly the way the recording's is: constant-size bookkeeping
  under `tf-run` (options, next index, total), the flow under `tf-run-flow` written
  ONCE at start, and one key per reported step (`tf-run-s-<i>`). Reporting a step is
  two constant-size writes — keeping the flow or the statuses inside the bookkeeping
  record would make every report re-serialize the entire recording, the same quadratic
  that once made long *recordings* crawl. Statuses reassemble O(n) only for snapshots,
  never per step. `index` advances only past *completed* steps — a worker evicted
  mid-run resumes on its next wake without re-running a step that already acted
  (re-clicking "purchase" is not a recovery strategy).
- **Keepalive**: MV3 kills a worker after ~30s without events or API calls, and a run's
  longest quiet stretches (a recorded 10s pause, a 15s navigation wait) get close. A 20s
  heartbeat (one cheap storage read) keeps it alive exactly while a run exists; a
  top-level check on worker start resumes any run that died anyway.
- **The queue rule**: the loop runs *outside* the `enqueue()` mutex — the same deadlock
  rule `runStep` always had (it waits on tabs that queued tasks bind) — and its state has
  its own key, so it never read-modify-writes the session against the queue.
  Cancellation: stop, closeReplay, and last-tab-closed all mark the run done;
  `reportStep` checks ownership on every write, so a stopped run halts within one step.
- **Navigation waits** are top-frame `ready`/`settled` counters bumped by
  `cs-ready`/`cs-settled`. Top frame only, on purpose: an iframe announcing itself must
  not satisfy a navigation wait — the old dashboard counters counted *every* frame's
  ready against top-only settles, so on iframe-heavy pages the settle early-exit never
  held and each navigation burned the full timeout. The ready baseline is captured
  *before* a step fires, so a same-tick load can never be missed. Two stall-killers on
  top: a new top page **moots the previous page's outstanding settle** (a JS redirect
  that interrupts a load would otherwise desync the counters permanently, and every
  later settle gate would burn its full timeout), and the asserted-navigation gate is
  **SPA-aware** — an SPA route change never creates a document, so `waitAssertedNav`
  also polls the tab's URL (pathname+hash, like the recorded route assertions) and
  accepts a match once the document proves answerable, instead of sitting out a 15s
  ready-timeout on every route-changing click.
- **Pacing is deadline-scheduled, not gap-slept.** A virtual timeline is computed once
  from the monotonic stamps; each step fires at an absolute deadline on it. Sleeping
  the recorded gap after each step (the old design) stacked execution overhead —
  locate round-trips, the cursor glide, navigation settles — on top of every pause, so
  the replay drifted behind the recording by n×overhead and long flows looked
  progressively slower. Against deadlines, a step that ran long shortens the next
  wait instead: drift cannot accumulate, and "as recorded" tracks the recording's
  actual duration (gaps capped at 10s). **Fast compresses think time instead of
  discarding it**: gaps ≤150ms are input mechanics (key holds, double-click spacing)
  and are kept exactly; longer gaps are scaled to 15% and capped at 600ms — and since
  overhead counts toward each deadline, most compressed pauses cost nothing extra
  while the page keeps the breathing room that makes fast replays land where recorded
  ones did. Behind-schedule runs never rush a step below its mechanics floor.
- **The rest is a transplant, not a redesign**: the skip rules (setViewport, the
  initial navigate) and the three navigation cases — navigate waits ready+settled; a
  step that kills the document before replying treats the reload's ready as the real
  outcome; a successful step with `assertedEvents` still waits out the reload — are
  the dashboard loop's logic, verbatim.

### 6.1 Two execution paths

For each step the SW picks one of three routes (`runOneStep()` in
[sw/index.ts](extension/src/sw/index.ts) — shared by the run loop and the single-step
`runStep` message):

**a) Real input over CDP** — when the debugger is attached and the step is
`click` / `doubleClick` / `drag` / `wheel` / `keyDown` / `keyUp`.

Two phases:
1. `cs-locate` to the specific frame. The content script resolves the element, restores
   scroll state, arms any dialog, scrolls the target into view if off-screen, runs an
   **occlusion check** with `elementFromPoint`, and returns the aim point in **top-frame
   viewport coordinates**.
2. The SW dispatches through `chrome.debugger` `Input.*`
   ([cdp.ts](extension/src/sw/cdp.ts)).

This is the whole reason CDP is here: a `dispatchEvent()` from a content script produces
`isTrusted: false`, no real hover, no `:focus-visible`, and no native scrolling.
Playwright's input has none of those limits, so the same flow would genuinely mean two
different things in the two engines. `chrome.debugger` is the same channel Playwright uses.

The stated cost: attaching shows Chrome's "started debugging this browser" infobar. It is
attached for **replay only** and detached the moment the run ends — during a *recording*
that infobar would shrink the very viewport being measured, which is a fidelity bug.

**b) Expression over CDP** — `waitForExpression` in the main frame. Almost every real site
ships a CSP without `unsafe-eval`, so the page cannot evaluate a string at all.
`Runtime.evaluate` is not page script and is not subject to the page's CSP. Wrapped as
`!!(expr)`, `silent: true` so a throwing page reads as "not true yet" rather than a crashed
run.

**c) Content script** — everything else (`change`, `scroll`, `navigate`,
`waitForElement`), and **input steps when CDP is unavailable** (DevTools open, another
debugger attached, blocked by policy). That fallback attaches a `note` to the result:

> synthetic events — real input was unavailable… Pages that check `isTrusted`,
> `:focus-visible` or native scrolling may behave differently.

A silent downgrade would be the worst outcome: the run passes and nobody knows it proved
less than it appears to.

### 6.2 Element resolution — consensus

[`resolveInPage`](src/shared/resolve.ts#L29) is **one implementation with two consumers**:
the content script imports it, and the Playwright runner ships the same function into the
page as source text via `pageExpr()`. Two copies would eventually resolve the same step to
two different elements, which is precisely the divergence this system exists to remove.
(Hence the constraint that it be self-contained with everything nested — it is serialized
with `toString()`, and the `__name` shim in `pageExpr` restores esbuild's `keepNames`
wrapper.)

It resolves **every** selector group and the element **most groups agree on** wins. A stale
positional path now pointing at the wrong element is outvoted by aria/testid/text still
agreeing on the right one; first-match-wins cannot do that. Nested hits (one group finds
the `<button>`, another its inner `<span>`) count as agreement and the bucket keeps the
deeper element. Ties break toward the earlier, more durable group.

### 6.3 What the content script does per step

[`execStep`](extension/src/content/recorder.ts#L1315), in order: restore `scrollState`
(unless the step *is* a scroll), arm the dialog answer **before** acting (because
`confirm()` blocks the instant the page's handler calls it), then dispatch.

- `click` — `scrollIntoView`, 80ms settle, then hover pre-events (`pointerover`,
  `mouseover`, `mousemove`) so hover-opened menus behave, then the press/focus/release
  sequence at the recorded offset.
- `drag` — press, retrace the recorded path paced over the recorded duration (5–40ms per
  point), release. **Deliberately no click** — a drag is not a click, and pages debounce on
  that.
- `wheel` — real `WheelEvent`s chunked at ±120 like a physical wheel, because map libraries
  clamp one huge delta to a single zoom notch. The same rule in all three engines.
- `change` — `setNativeValue` goes through the prototype's native setter, since React
  tracks the value setter and a plain assignment is invisible to it; then `input` + `change`.
- `keyDown`/`keyUp` — delegated to the main world. A `keyCode`/`which` override made in the
  isolated world is invisible to page handlers; real keyboard events carry **three**
  identities (`key`, `code`, legacy `keyCode`/`which`) and handlers in the wild check any
  of them. Hold state is tracked so `b` under a held `Control` carries `ctrlKey: true`.
- `navigate` — `location.assign` only if the URL actually differs.
- `waitForExpression` — tries [`evaluateKnownExpression`](src/shared/expressions.ts#L38)
  first. The recorder's own route assertions are a few known shapes about `location`, and
  comparing those needs no evaluator, so they work on pages that forbid one. Anything
  hand-written falls through to the main world's `new Function`, and if the page's CSP
  blocks that, the error says so in words.
- `setViewport` — no-op; a tab cannot resize itself.
- Unknown types **skip, not fail**.

Two steps refuse to run and say why rather than passing hollowly:

- **upload** — nothing in an isolated world can put bytes into a page's file input.
  *"file uploads cannot be replayed in-browser — run this flow in Playwright."*
- **secretRef** — typing the empty string and reporting success would "pass" while logging
  in as nobody. The error names the secret and gives the Playwright command.

### 6.4 Occlusion

Before real input, [`locate`](extension/src/content/recorder.ts#L1481) hit-tests the aim
point. If something else is topmost and is neither an ancestor nor a descendant of the
target, the step fails with the offender named — a sticky header or cookie bar would
otherwise absorb the click and the step would "succeed" having done nothing. The Playwright
runner makes the same check; both engines must refuse the same clicks.

### 6.5 The visible cursor

[cursor.ts](extension/src/content/cursor.ts) draws an SVG pointer that glides to each
target *before* the input lands, plus a click pulse. Driven entirely by the SW so the glide
can be **awaited** — the point of a visible cursor is that you see it arrive at the thing
it is about to click.

Four constraints:

- `pointer-events: none`, non-negotiable — the occlusion check above would otherwise report
  the cursor itself as the topmost element, and the run would fail as occluded by its own
  cursor.
- Top frame only, in top-frame coordinates — the same space the input is dispatched in, so
  what you see is literally where the click goes.
- Built with CSSOM and `createElementNS`, never `innerHTML` or a `<style>` tag, because a
  strict CSP (Trusted Types, no `unsafe-inline`) blocks those and this has to work on sites
  that ship one.
- A `MutationObserver` re-attaches it when a framework re-renders into `<body>`.

Position is held in the SW (`cursorAt`, keyed by tab), because a navigation destroys the
document *and* the content script's memory of where the cursor was. After each load it is
`place`d back instantly — gliding in from the corner on every page load reads as a glitch.
With nowhere to return to it starts at the viewport centre.

For steps the content script runs itself, the cursor is positioned via `cs-locate` with
`pointOnly: true` — resolve and report the point, no scroll restore, no dialog arming, no
occlusion check — because the real step is about to perform those itself, and arming a
dialog twice would queue two answers for one question. It also uses a short 350ms budget:
a cosmetic cursor must never add latency to a step that is about to wait properly anyway.

### 6.6 Dialogs in replay

`setMode("replay")` immediately arms the main world with `replay: true` and no specific
answer. Patched `confirm`/`prompt` then answer from a queue filled just before each step,
**defaulting to accept** for any dialog the recording never saw — a real dialog with nobody
there to click it blocks the run forever and reports nothing at all.

### 6.7 Target waiting

The step that opens a popup finishes before the browser has created it, so the very next
step naturally arrives too early. [`findTarget`](extension/src/sw/index.ts#L289) polls for
up to 5s, re-reading the session each time because the tab it waits for is bound by the
`tabs.onCreated` handler — a different task on the same queue.

---

## 7. Message protocol

All shapes live in [src/types/flow.ts](src/types/flow.ts).

**Dashboard → extension (`HubMessage`, `source: "tf-hub"`)**
`ping` · `openAndRecord{url}` · `openForReplay{url}` ·
`startReplay{runId, flowId?, flow, options}` · `runStep{id, step, meta?, cursor?}` ·
`stop` · `closeReplay`

**Extension → dashboard (`AgentMessage`, `source: "tf-agent"`)**
`bridge-ready` · `ready{url,title,width,height,dpr,targetId}` · `settled{url}` ·
`step{step,meta}` · `snapshot{recording,steps,meta,env,error?,run?}` ·
`runProgress{runId,index,status,error?,note?}` · `runDone{runId,ok,error?}` ·
`stepResult{id,ok,error?,note?}` · `stopped`

`snapshot` is sent on every port connect, so a dashboard reload mid-recording no longer
loses the recording — and its `run` field is what lets a reload mid-*replay* rejoin the
live run. `ready` fires when a frame loads; `settled` when `window.load` fires — a
state-tied wait, never a sleep.

**Content script → SW (`CsToSw`)**
`cs-get-mode` · `cs-ready{url,title,width,height,dpr,frameChain,tMono,env?}` ·
`cs-step{step,meta}` · `cs-route{url,title,tMono}` · `cs-dialog{dialog}` · `cs-settled{url}`

**SW → content script (`SwToCs`)**
`cs-set-mode{mode}` · `cs-run{id,step,meta?}` · `cs-locate{step,meta?,pointOnly?}` ·
`cs-cursor{action,x?,y?,durationMs?}`

**Page world ↔ isolated world (`CustomEvent`, JSON-string detail)**
`__tf_kbd` ↓ · `__tf_route` ↑ · `__tf_dialog` ↑ · `__tf_dialog_answer` ↓ · `__tf_expr` ↓ ·
`__tf_expr_result` ↑

**Frame ↔ parent (`postMessage`)**
`whoami` / `youare` · `whereami` / `youareat`

---

## 8. Why the main world exists

Three things the isolated world provably cannot do
([main-world.ts](extension/src/content/main-world.ts)):

1. **Dispatch keyboard events whose legacy `keyCode`/`which` overrides are visible to page
   handlers.** Property overrides don't cross Chrome's isolated-world boundary; an event
   constructed in the page's world has getters page code actually reads.
2. **See SPA route changes.** `history.pushState`/`replaceState` are *page* functions —
   patching them from the isolated world patches a different object.
3. **Evaluate an expression against page state.** The isolated world runs under the
   *extension's* CSP, which forbids `eval` outright.

Plus the dialog patches, which must be on the page's own `window.alert`/`confirm`/`prompt`.

---

## 9. Output formats

The popup's **Download JSON** writes `{ title, steps }` — pure DevTools, importable back
into Chrome. The dashboard saves the full bundle via `toBundle()`: `title`, `timeout`,
`steps`, `meta`, `env`.

`exportSteps()` strips the three TestFlow-only fields (`timestamp`, `tagName`, `id`) so the
downloaded document stays byte-compatible with DevTools and runnable by
`@puppeteer/replay`. `meta` and `env` sit *beside* the document rather than inside it, which
is what keeps the recording model exactly what DevTools would have captured while still
carrying everything replay needs.

Steps and sidecar entries are kept in index lockstep **and** paired by `stepId`, because
that alignment is a convention maintained across the content script, the SW, the dashboard,
two Firestore blobs, the export, and the runner — one filter or sort anywhere in that chain
silently attaches every step to the wrong context. `metaResolver()` prefers the id;
`alignmentProblems()` reports disagreement in words rather than throwing, because a
misaligned flow still replays by position, it just cannot be trusted.

---

## 10. Known limits, as designed

| Limit | Why |
|---|---|
| Scrollbar-drag scrolling isn't recorded | produces no wheel/touch/key input, so scroll intent can't be established |
| File uploads can't replay in-browser | an isolated world cannot put bytes into a page's file input — Playwright can |
| Password steps can't replay in-browser | no value was captured, and there is nowhere safe to keep one in an extension |
| Native HTML5 drags don't replay faithfully | the drag machinery only starts for real input; recorded as `meta.nativeDrag` so it's stated up front |
| Real input needs the debugger | DevTools open or another debugger attached ⇒ synthetic fallback **with a note** |
| The debugger infobar | shown during replay only; attaching during recording would alter the viewport being measured |
| Subframe `waitForExpression` skips CDP | `Runtime.evaluate` targets the main frame; the content script handles subframes |
| Uploads over 256 KB | name kept, bytes dropped, `degraded: "upload-truncated"` |
| One session at a time | by design — `startSession` stops any existing one |
| Bridge is hardcoded to `localhost:3000` | manifest `matches`; change it for a deployed dashboard |
