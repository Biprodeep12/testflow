# TestFlow — weak-point audit & upgrade prompt

**Audited:** 2026-07-31 · full repo (dashboard + extension + scripts + docs), ~3.6k LOC of source.

---

## 0. Calibration: what is genuinely strong

Stated first so the criticism below reads at the right altitude. This is a well-built prototype, not a mess.

- **The capture layer is the right architecture.** MV3 content script at `document_start` on `<all_urls>` beats every injection trick, and the reasoning in `ARCHITECTURE.md` for why is correct.
- **The bridge pattern is elegant** — `window.postMessage` ↔ `chrome.runtime` port, scoped by manifest `matches`, so the dashboard never hardcodes an extension ID.
- **Consensus selector resolution** (`voteResolve`, [recorder.ts:680](extension/src/content/recorder.ts#L680)) is better than the first-match-wins that DevTools and most recorders use, and the E2E test proves it with a deliberately wrong-but-resolving first candidate.
- **Session state in `chrome.storage.session`** correctly anticipates MV3 worker eviction.
- **The consumed-wheel and drag capture** (map zoom, panning) is real engineering that DevTools Recorder itself does not do.
- **The keyboard main-world trick** ([main-world.ts](extension/src/content/main-world.ts)) — dispatching in the page's world so `keyCode`/`which` overrides are visible to page handlers — is a genuinely non-obvious correct solution.
- **Comments explain *why*, not *what*.** Rare and valuable.

The gap is not craftsmanship. The gap is that **this is a recorder that hasn't yet become a test tool**, plus a set of correctness bugs concentrated at the frame/session boundaries.

---

## A. Correctness bugs (wrong today)

### A1. Replay messages broadcast to every frame; the fastest reply wins — **high**

[sw/index.ts:159](extension/src/sw/index.ts#L159) calls `chrome.tabs.sendMessage(tabId, {type:"cs-run"…})` with **no `frameId`**. Chrome delivers that to *every* frame in the tab, and the recorder in each frame returns `true` from `onMessage` and calls `sendResponse`. Only the first response is delivered; the rest are dropped.

Consequence: on any page with iframes (ads, embeds, payment widgets, `<iframe>` design systems), each step is a race. It usually works by accident — a frame that *finds* the element replies fast, a frame that doesn't burns the full 5 s budget before replying `null` — but two frames that both match produce nondeterministic clicks, and a step whose element genuinely doesn't exist can be resolved by a stray iframe.

Fix: record the originating `frameId` on the step, route with `chrome.tabs.sendMessage(tabId, msg, { frameId })`.

### A2. Frame identity is discarded at record time — **high**

`target: "main"` is hardcoded on every recorded step ([recorder.ts:204](extension/src/content/recorder.ts#L204) and every `record({…})` call site). The content script runs in **all frames** (`all_frames: true`), and nothing gates recording to the top frame — only `announce()` and `installBadge()` are top-frame-only. So an interaction inside an iframe is recorded with iframe-local selectors labelled as belonging to the main frame.

The README claims the extension "sees iframes." It sees them; it cannot replay them. This is the root cause of A1 — fix them together. DevTools' own format uses `target` for exactly this (a frame URL, not the string `"main"`).

### A3. SPA navigations are invisible — **high**

There is no `webNavigation` permission, no `history.pushState` hook, and no `onHistoryStateUpdated` listener anywhere (verified by grep). `assertedEvents` are inferred purely from a fresh content script's `cs-ready` ([sw/index.ts:232](extension/src/sw/index.ts#L232)), which only fires on a **document load**.

Consequence: recording a React/Next/Vue app — i.e. most modern apps, including this dashboard — produces a flow with **one** `navigate` step and **zero** route-change assertions. Client-side routing simply doesn't appear. `ARCHITECTURE.md` lists "E3 — `webNavigation` navigate/assertedEvents" as part of the built plan; it was never implemented.

### A4. `exportSteps` does not make the JSON DevTools-compatible — **high**

[types/flow.ts:90](src/types/flow.ts#L90) strips the TestFlow-only *fields* `timestamp` and `tagName`, but `wheel` and `drag` are TestFlow-only **step types** (the file says so itself at lines 30–40). They survive export untouched, along with `path`, `deltaX`, `deltaY`, `duration`.

So the headline interop claim in [README.md:8-10](README.md#L8) — "saved flows are exact DevTools Recorder JSON, so they're importable into Chrome DevTools and directly runnable by `@puppeteer/replay`" — is **false for any recording that contains a map zoom, a carousel scroll, or a drag**. `@puppeteer/replay` validates step types against a schema and throws on an unknown `type`; DevTools' importer rejects them too.

The E2E suite even asserts export purity ([e2e-record.mts:251](scripts/e2e-record.mts#L251)) — but only for the two stripped *fields*, so it passes while the actual incompatibility ships. Three honest options: down-convert `wheel`/`drag` to `waitForExpression` on export, emit them behind a "TestFlow-extended" flag with the plain export as default, or stop claiming byte-compatibility. Silently claiming it is the one unacceptable option.

### A5. "Stop" doesn't stop a running replay — **medium**

`stopRun` ([flows/[id].tsx:258](src/pages/flows/[id].tsx#L258)) sends `closeReplay` and sets `runState` to `idle`, but the `for` loop in `runInTab` ([flows/[id].tsx:200](src/pages/flows/[id].tsx#L200)) **has no cancellation check**. It keeps going, fails the next step against the now-closed tab, breaks, and then runs `setRunState("done")` — overwriting the `idle` the user asked for. The UI shows a failure the user caused by stopping. Needs an `AbortController` or a ref-backed cancel flag checked each iteration.

### A6. Session-start race can silently produce a dead recording — **medium**

`startSession` ([sw/index.ts:100](extension/src/sw/index.ts#L100)) creates the tab **before** writing the session. If the new page's content script fires `cs-get-mode` before `setSession` resolves it gets `mode: "off"`, and its subsequent `cs-ready` is rejected by the `session.tabIds.includes(tabId)` guard — so the tab is never armed and never retries. Result: badge never appears, nothing records, no error surfaced. Local pages (`demo.html` on localhost) load fast enough to make this reachable. Either seed the session before the tab can load, or make `cs-ready` self-heal by retrying.

### A7. Two divergent stop paths leave different states — **medium**

The SW's `stopSession` sets the session to `null` ([sw/index.ts:117](extension/src/sw/index.ts#L117)); the popup's stop button writes `{...session, mode:"stopped"}` ([popup.ts:89](extension/src/popup/popup.ts#L89)). The `Session` type documents `"stopped"` as "keeps the steps around for popup Download." So stopping from the **dashboard** destroys the steps the popup would have offered to download, and stopping from the **popup** leaves a session that the dashboard sees as neither recording nor gone. One stop path, one state machine.

### A8. "Record this tab" reloads the tab and destroys page state — **medium**

[popup.ts:71](extension/src/popup/popup.ts#L71): `await chrome.tabs.reload(tab.id)` with the comment "simplest reliable seed." It is — and it also wipes unsaved form input, scroll position, opened modals, and any client-side state the user navigated to. The entire point of "record the tab I'm already on" is that you're mid-flow. Seed from the existing page instead (`chrome.scripting.executeScript` to ask the live content script to re-announce).

### A9. Generated Playwright code for authenticated flows is broken by construction — **medium**

Passwords record as `value: ""` ([recorder.ts:375](extension/src/content/recorder.ts#L375)) — correct. But codegen then emits `.fill('')` ([fromFlow.ts:96](src/codegen/fromFlow.ts#L96)), which *clears* the field. Every exported login test fails, and it fails looking like a selector problem. The v1 design specified `process.env.TEST_PASSWORD!`; the port dropped it. Emit an env-var reference plus a header comment listing the variables the test needs.

### A10. Smaller ones

| Where | Issue |
|---|---|
| [fromFlow.ts:166](src/codegen/fromFlow.ts#L166) | Title is escaped *then* `.slice(200)` — a cut landing mid-escape emits invalid TS. Newlines in a title also break the generated string. Slice first, escape after, strip newlines. |
| [flows/[id].tsx:225](src/pages/flows/[id].tsx#L225) | `void sendStep(...)` for navigate leaves an orphan entry in `waiters.current.result` plus a 15 s timer per navigation. |
| [flows/[id].tsx:103](src/pages/flows/[id].tsx#L103) | `waiters.current.ready = …` overwrites any pending waiter — a second concurrent `waitReady` silently drops the first. |
| [flows.ts:32](src/lib/flows.ts#L32) | `JSON.parse(stepsJson)` unguarded — one corrupt doc 500s the flow page with a parser message. |
| [index.tsx:122](src/pages/index.tsx#L122), [:138](src/pages/index.tsx#L138) | `timeout: 5000` hardcoded twice instead of `DEFAULT_TIMEOUT_MS`, which exists three lines away in the imported module. |
| [sw/index.ts:337](extension/src/sw/index.ts#L337) | A comment containing a leftover self-argument: *"until saved or a new session starts? No — closing every tab ends it."* |
| [recorder.ts:369](extension/src/content/recorder.ts#L369) | `type="file"` inputs are dropped with no step and **no warning** — the user's recording silently loses a step they performed. |
| [recorder.ts:324](extension/src/content/recorder.ts#L324) | Right-click records `button:"secondary"`, but replay can't open a native context menu, so any subsequent menu-item click is unreplayable. Record it or reject it — don't half-support it. |
| — | No `dialog` / `alert` / `confirm` handling anywhere. A page that alerts during replay blocks the content script until the step times out. |

---

## B. Security & privacy

### B1. The API is completely unauthenticated — **critical for any deployment**

`/api/flows` and `/api/flows/[id]` have **no auth of any kind**. Anyone who can reach the origin can list every flow, read every recorded step (including everything ever typed into a form), and `DELETE` any flow. `DEFAULT_PROJECT_ID` is exported from [api.ts:94](src/lib/api.ts#L94) and never used — a vestige of a multi-tenant model that was never built.

This is defensible for `localhost` only. The moment this is deployed — and the whole design targets a deployed dashboard — it is a public, world-writable database of everything anyone recorded. It needs auth before it needs anything else on this list.

### B2. `SETUP.md` instructs users to open their Firestore to the world — **high**

[SETUP.md:32](SETUP.md#L32): "Firestore Database → Create database (**test mode is fine** — nothing touches Firestore from the browser)."

Test mode is `allow read, write: if request.time < …30 days`, i.e. **any client on the internet with the project ID can read and write the whole database**. The parenthetical is exactly backwards as a justification: *because* nothing touches Firestore from the browser, the rules should be deny-all — which `ARCHITECTURE.md §8` itself correctly specifies. Ship a `firestore.rules` with `allow read, write: if false;` and tell the user to deploy it.

### B3. Secret capture is narrower than the threat — **high**

Only `type="password"` is masked. Not masked: `autocomplete="one-time-code"` (2FA), `autocomplete="cc-number"` / `cc-csc` (card data), API-key and token fields (invariably `type="text"`), `contenteditable` fields, and **URLs** — every `navigate` step stores the full URL including query strings, so magic-link tokens, OAuth `?code=`, session IDs, and password-reset tokens are captured verbatim and written to Firestore in plaintext.

The v1 design in `ARCHITECTURE.md §4` specified masking `cc-` and `one-time-code` and a per-session redaction list. The extension port dropped all of it. Needs: an autocomplete-attribute denylist, a URL query-parameter scrubber with a sensible default deny list, a user-configurable redaction selector list, and a visible "N values redacted" indicator so masking is legible rather than silent.

### B4. Any page on the dashboard origin can drive the extension — **medium**

The bridge relays any `window.postMessage` with `source: "tf-hub"` from *any* script on `http://localhost:3000` ([bridge.ts:31](extension/src/content/bridge.ts#L31)), and the SW honours it without further checks. So an XSS anywhere on the dashboard — or, on a shared dev machine, **any other project that happens to be serving on port 3000** — can start a recording on an arbitrary URL and read back every recorded step via the `snapshot` broadcast. Port 3000 collisions are not hypothetical; they're the default for half the JS ecosystem.

Mitigations: a per-install nonce the dashboard must echo, an explicit user confirmation for `openAndRecord` on a URL the user didn't type, and moving the match off a bare port to a configured origin (see D1).

### B5. Always-on injection into every frame of every page — **medium**

Both `recorder.js` and `main-world.js` are injected at `document_start` into **every frame of every URL**, permanently, whether or not a session exists. That is: a parse+execute of the bundle in every frame of every page you browse, forever; a permanent `__tf_kbd` listener in the **main world** of every page; and a `<all_urls>` host permission that makes Web Store review materially harder and asks users for total browsing access up front.

The dynamic alternative — `chrome.scripting.registerContentScripts` when a session starts, `unregister` when it ends, plus `activeTab` for the popup path — costs one refactor and removes the entire always-on surface.

### B6. Raw error messages returned to clients

[api.ts:87-89](src/lib/api.ts#L87) forwards `err.message` to the client, which for Firebase means internal paths, project IDs, and credential-shaped detail. Log the detail, return a generic message plus a correlation ID.

---

## C. Product gaps — why this is a recorder, not a test tool

These are not bugs. They are the difference between "captures what I did" and "tells me when my app breaks."

### C1. You cannot author an assertion — **the single biggest gap**

`waitForElement` exists in the type ([flow.ts:28](src/types/flow.ts#L28)), the validator, the codegen, and the replayer. **Nothing ever creates one.** There is no assert mode in the recorder, no "add assertion" in the UI, no text/value/URL/visibility check. The v1 design had Alt+Click assert mode with four assertion kinds; it did not survive the port.

Consequence: a recorded flow only fails when an element cannot be found. It passes when the button is there but does nothing, when the price is wrong, when the API 500s behind a spinner, when the wrong page loads with the right buttons. A test that can only detect missing elements catches a small minority of real regressions.

**Fix:** Alt+Click (or a badge toggle) → pick element → choose visible / text equals / text contains / value equals / URL matches → emits `waitForElement` with the native DevTools `assertedEvents`, plus explicit assertion steps in the UI. This one feature changes the product category.

### C2. Flows are immutable after saving

The only mutation is the title ([validate.ts:34](src/lib/validate.ts#L34), `patchFlowSchema`). You cannot delete a misclick, reorder, insert a wait, retarget a broken selector, or parameterize a value. Every recording is take-it-or-leave-it, and one stray click means re-recording the whole flow. The v1 design specified an editable step list and a selector-swap dropdown backed by the stored candidate list — the candidates *are* stored, and the UI just doesn't expose them.

### C3. Nothing remembers whether a test passed

Replay results live in `useState` and vanish on reload. There is no `runs` collection, no history, no flake rate, no "this started failing on Tuesday," no artifacts. So the pitch — scheduled testing — has nowhere to write its output even if the runner existed.

### C4. There is no unattended execution

`@puppeteer/replay` is cited five times across the docs as the zero-codegen execution path. **It is not a dependency and there is no script that calls it.** No GitHub Action, no cron, no CLI. Every test run requires a human clicking "Run in tab" in a browser with the extension loaded. For a test tool, unattended execution isn't a feature — it's the point. (`E8`, deferred.)

### C5. Replay drives exactly one tab, with synthetic events

Honestly documented in [SETUP.md:83](SETUP.md#L83), so this is a roadmap item rather than a hidden flaw — but it caps the ceiling. `isTrusted: false` means bot-detection, some drag libraries, and trust-checking handlers all diverge from reality. `chrome.debugger`-based input (E7) closes it.

### C6. One global session, one flow, no organization

`KEY = "tf-session"` is a single global. Two dashboard tabs fight; you cannot record two things; there are no suites, folders, tags, or environments (staging vs prod URLs). The flows list is a flat `orderBy(updatedAt).limit(200)` with no search, no pagination cursor, and no filter.

### C7. Long recordings cannot be saved at all

Steps are one JSON string in one Firestore doc, capped at 900 KB ([api/flows/index.ts:16](src/pages/api/flows/index.ts#L16)). The error tells the user to "split the recording" — with no way to split a recording. A dense 20-minute session hits this and the work is unrecoverable. Chunked subcollections or Cloud Storage for the step blob.

---

## D. Architecture & scale

### D1. Deployment target is hardcoded in three places

`http://localhost:3000` appears in [manifest.json:28](extension/manifest.json#L28) (bridge `matches`), [popup.ts:19](extension/src/popup/popup.ts#L19) (`DASHBOARD_URL`), and implicitly in the E2E scripts. Deploying the dashboard anywhere means editing source, rebuilding, and re-loading unpacked — documented as a known limit, which doesn't make it less of a wall. Use an options page + `chrome.storage.local` for the dashboard origin, with `chrome.permissions.request` for the host at runtime.

### D2. Step writes are O(n²)

Every `cs-step` does a full `chrome.storage.session.get` → push → full `set` of the entire session object ([sw/index.ts:301-308](extension/src/sw/index.ts#L301)). Step 500 rewrites 500 steps. A serialized queue makes it strictly sequential, so it's O(n²) wall-clock in the recording hot path, and it's the reason a long recording feels progressively laggier. Append to a chunked key space (`tf-steps-0`, `-1`, …) or buffer in worker memory with periodic flushes plus an eviction-safe checkpoint.

### D3. Full-state broadcast on every page load

Each `cs-ready` broadcasts the complete step array to every connected dashboard ([sw/index.ts:260](extension/src/sw/index.ts#L260), [:274](extension/src/sw/index.ts#L274)). Combined with per-step `step` messages, the dashboard receives O(n) full snapshots per recording. Send a delta or a version counter and let the dashboard request a resync.

### D4. Selector generation is expensive on the interaction path

`selectorsFor` runs ~8 `querySelectorAll` uniqueness probes plus full ancestor walks for `cssFor` and `xpathFor` — synchronously, inside the capture-phase `click` handler ([recorder.ts:143](extension/src/content/recorder.ts#L143)). On a large DOM that is measurable jank injected into the app under test, which can itself change the behaviour being recorded. Defer to `requestIdleCallback` with the element captured, or cap uniqueness probing.

### D5. Replay resolution is O(DOM) per poll

`byText` walks `document.body.getElementsByTagName("*")` ([recorder.ts:637](extension/src/content/recorder.ts#L637)) and `deepQuery` recurses every element plus every shadow root ([recorder.ts:612](extension/src/content/recorder.ts#L612)) — every 120 ms, for every unresolved selector, for the full 5 s budget. On a heavy app that's tens of thousands of node visits per second per step.

### D6. Accessible-name computation is approximated twice, independently

`accName` ([recorder.ts:35](extension/src/content/recorder.ts#L35)) is a hand-rolled subset of the AX name algorithm used at record time; `byAria` re-runs it at replay time over a fixed tag allowlist ([recorder.ts:629](extension/src/content/recorder.ts#L629)). Any divergence between the two — or any DOM change that shifts a name — silently degrades `aria/` groups into non-matching selectors, which is the most-trusted group in the ranking. This is a flake source that will be very hard to debug in the field. Consider `chrome.automation`/CDP-derived names, or at minimum extract one shared implementation with a test suite of AX edge cases.

### D7. Replay pacing is measured with the wrong clock

Timestamps are stamped in the SW at receive time ([sw/index.ts:303](extension/src/sw/index.ts#L303)), not in the page at event time. The comment justifies it — one clock ordering steps across tabs — and that's a real benefit, but it means "as recorded" pacing includes message latency and, after a worker eviction, the SW's cold-start delay. Stamp in the page *and* in the SW; use the page clock for pacing and the SW clock for ordering.

### D8. The replay player is 150 lines of untestable state machine inside a page component

The handshake logic in [flows/[id].tsx:97-256](src/pages/flows/[id].tsx#L97) — `readyCount`/`settledCount` counters, waiter overwrites, the navigate special case, the "click killed the document" recovery path — is the most intricate logic in the dashboard, and it lives in a React component where it can only be exercised by a full browser E2E. Extract to `lib/player.ts` as a pure state machine over an injected transport, and unit-test the races directly.

---

## E. Testing & engineering hygiene

### E1. No unit tests, and no test framework

Zero. No vitest, no jest, no `*.test.ts` (verified). Every pure function that would be trivial and valuable to test is untested: `voteResolve`, `selectorsFor`, `cssFor`/`xpathFor`, `flowToPlaywright`, `exportSteps`, `fromSnapshot`, `keyInfo`, `budgetOf`. Note that **A4 (the export-compatibility bug) is exactly the class of bug one `exportSteps` unit test would have caught**.

### E2. The E2E suites are hand-rolled and fail-fast

`ok()` calls `process.exit(1)` on the first failure ([e2e-record.mts:27](scripts/e2e-record.mts#L27)), so you fix one assertion at a time instead of seeing all failures. There's no retry, no trace/video on failure, no `--headed` debug switch, no fixtures — and Playwright Test, which is already a dependency, provides every one of those.

### E3. The E2E suites require an undocumented running server

Both scripts assume `http://localhost:3000` is live. Neither `package.json` nor the README's Checks section says so ([README.md:60](README.md#L60)) — `npm run e2e` on a clean checkout just fails at `page.goto`. Use Playwright's `webServer` config to start it.

### E4. Nothing runs in CI

No `.github/` at all (verified). Nothing is enforced: not typecheck, not lint, not the two E2E suites that already exist and already work. Every guarantee in this repo is "someone remembered to run it."

### E5. `scripts/` is never typechecked

[tsconfig.json:28](tsconfig.json#L28) excludes `scripts`, while `include` lists `**/*.mts`; exclude wins. So the E2E scripts — which import from `src/` and would catch signature drift in `flowToPlaywright` — are outside `npm run typecheck`. Give them their own tsconfig and add it to the script.

### E6. `extension/dist/` is not gitignored

Verified: `git check-ignore` says not ignored, and five built bundles plus a duplicate `manifest.json` are sitting untracked, ready to be committed. Build output in git means noise diffs, merge conflicts, and a `dist/manifest.json` that silently drifts from the source of truth.

### E7. No Prettier config, no hooks, no engines, no LICENSE

The code is consistently formatted by hand with no tool enforcing it. No `.nvmrc` or `engines` field. No `CONTRIBUTING.md`. No license, which technically leaves the project all-rights-reserved.

---

## F. Documentation

### F1. `ARCHITECTURE.md` is three stacked versions and actively misleads

735 lines: v3 (current), then v2 "superseded," then the full v1 design. The v1 and v2 sections describe, in the present tense, a large amount of code **that does not exist**:

- `runner/` — the whole directory, `record.ts`, `replay.ts`, the claim loop
- `src/codegen/normalize.ts`, `selector.ts`, `emit.ts` — the real file is `fromFlow.ts`
- `src/types/events.ts`, `models.ts`, `lib/auth.ts`, `components/EventTimeline.tsx`, `StatusBadge.tsx`
- `/api/sessions/*`, `/api/runner/*`, `/api/testcases/*`, `/api/runs/*` — none exist
- `public/tf-recorder.js`, cited at line 138 as a "key file"
- Commands: `npm run smoke:codegen`, `npm --prefix runner run typecheck`
- A build-order table marking **M0–M7 "✅ built"** for a runner that was deleted

`AGENTS.md` instructs every contributor and coding agent to read the docs before writing code. They will read 500 lines of confident description of a system that isn't there. Archive v1/v2 to `docs/history/` with a header stating they describe removed code, and leave `ARCHITECTURE.md` describing only what exists.

### F2. `AGENTS.md` points at a directory that has no content

It says APIs may differ from training data and to read `node_modules/next/dist/docs/`. That directory contains exactly one file — a generic welcome page with no API detail (verified). The instruction cannot be followed as written. Either vendor the pages that matter or state the actual constraint (Next.js 16, Pages Router, React 19, React Compiler on).

### F3. Interop is over-claimed

Per A4 — README's "exact DevTools Recorder JSON" is conditionally false. Add the caveat, or fix the export.

---

## G. UX & UI

The dashboard is clean and well-composed. The gaps are functional.

| | |
|---|---|
| **Destructive delete, no confirmation** | [flows/[id].tsx:342](src/pages/flows/[id].tsx#L342) — one click, permanent, no undo, no confirm. |
| **Flows list never refreshes** | `usePoll(load, null)` — a fetch-once dressed as a poll; no focus revalidation, so a saved flow doesn't appear in an open tab. |
| **Load failure = permanent "Loading…"** | [flows/[id].tsx:293](src/pages/flows/[id].tsx#L293) — `flow` stays null, no retry offered. |
| **No error boundary** | Any render throw = white screen, mid-replay state lost. |
| **`ErrorNote` isn't announced** | No `role="alert"`; screen-reader users never learn a save failed. |
| **Replay progress isn't legible** | Coloured dots only. No elapsed time, no current-step highlight, no auto-scroll to the running step, no screenshot on failure. |
| **Failures aren't debuggable** | "no selector matched" with no indication of which selectors were tried, what the vote was, or what the DOM looked like. The consensus data that would explain it is computed and discarded. |
| **JSON/Playwright tabs are dead text** | No copy button, no syntax highlighting, no download-as-spec. |
| **No dark-mode toggle** | OS-only; no override. |
| **Extension has no icon** | Manifest has no `icons` or `default_icon` — Chrome shows a grey puzzle piece, which reads as "sideloaded junk." |

---

## H. Priority order

**Ship-blocking before any deploy:** B1 (auth), B2 (Firestore rules), B3 (secret capture).

**Correctness, in order:** A1+A2 (frames — one fix), A3 (SPA navigation), A4 (export honesty), A5 (stop), A6 (start race), A7 (stop paths), A9 (password codegen).

**Category change — recorder → test tool:** C1 (assertions) first and by a distance; then C2 (editing), C3 (run history), C4 (unattended execution).

**Foundation that makes the rest safe:** E1 (unit tests), E4 (CI), D8 (extract the player).

**Then:** D1 (deployability), D2/D3/D4/D5 (scale), F1 (docs), G (UX).

---

---

# The upgrade prompt

Copy everything below into a fresh session, alongside this file.

---

You are working on **TestFlow** — a Chrome MV3 extension that records browser interactions as Chrome DevTools Recorder flows, plus a Next.js 16 (Pages Router, React 19, React Compiler) dashboard that displays, stores, replays, and exports them. Read `UPGRADE.md` for a full audit, and `README.md` / `ARCHITECTURE.md` / `SETUP.md` for context — but treat the v1 and v2 sections of `ARCHITECTURE.md` as **historical fiction**: they describe a `runner/` and API surface that no longer exist.

## The gap to close

Today TestFlow **records faithfully and replays approximately**. It is a very good recorder. It is not yet a test tool, because a recorded flow cannot assert anything, cannot be edited, cannot run unattended, and cannot tell you whether it passed yesterday.

Target state: **a recorded flow is a real test.** It asserts what should be true, survives selector drift, runs on a schedule without a human, and reports when it starts failing — while remaining honest about its interop claims and safe to deploy on a public URL.

Do not rewrite what works. The capture layer, the bridge, consensus resolution, and the wheel/drag work are the strong core — build on them.

## Non-negotiable constraints

1. **Never regress recording fidelity.** `npm run e2e` and `npm run e2e:replay` must pass at every commit.
2. **Interop is a promise, not a marketing line.** Either exported JSON is genuinely DevTools/`@puppeteer/replay`-compatible, or the docs say precisely where it isn't. A silent mismatch is the worst option.
3. **Nothing reaches storage without an explicit user save.** That property is load-bearing for trust.
4. **Secrets never leave the page.** Widen masking; never narrow it.
5. **Every fix ships with a test.** Prefer a unit test over an E2E test where a pure function can carry the logic.
6. **Match the existing style:** comments explain *why*; no dependency gets added without a reason that survives being questioned.

## Phase 1 — Make it safe to deploy (do this first)

- **Auth on the API.** `/api/flows*` is fully open — anyone can read every recorded step and delete any flow. Add auth (a shared secret via middleware is acceptable as a first step; Firebase Auth with Google sign-in is the natural end state and reuses the existing project). Scope flows to an owner; make `DEFAULT_PROJECT_ID` mean something or delete it.
- **`firestore.rules` with `allow read, write: if false;`**, committed, plus deploy instructions. Fix `SETUP.md`, which currently tells users "test mode is fine" — that opens their database to the internet, and the stated justification is backwards.
- **Widen secret capture.** Mask by `autocomplete` (`one-time-code`, `cc-*`, `current-password`, `new-password`), scrub sensitive query parameters from recorded URLs (`token`, `code`, `key`, `session`, `auth`, `password`, plus a configurable list), support a user-supplied redaction selector list, and show a visible "N values redacted" count so masking is legible.
- **Harden the bridge.** Any script on the dashboard origin — including an unrelated app on port 3000 — can start recordings and read back every step. Add a per-install nonce the dashboard must echo, and require explicit confirmation for `openAndRecord` on a URL the user didn't type.
- **Stop injecting into every page always.** Move to `chrome.scripting.registerContentScripts` on session start / `unregister` on stop, with `activeTab` for the popup path. Drop `<all_urls>` to runtime-requested hosts.

## Phase 2 — Fix what's wrong

- **Frames (A1 + A2, one fix).** Record the originating `frameId` and a frame URL on each step instead of hardcoding `target: "main"`; route replay with `chrome.tabs.sendMessage(tabId, msg, { frameId })`. Today every step broadcasts to all frames and the fastest reply wins.
- **SPA navigation (A3).** Add the `webNavigation` permission and listen to `onHistoryStateUpdated` + `onCommitted` for real navigation ground truth, so client-side route changes produce `navigate` steps and `assertedEvents`. Currently recording any React/Vue/Next app captures exactly one navigation.
- **Export honesty (A4).** `wheel` and `drag` are TestFlow-only step *types* that survive `exportSteps` and will make `@puppeteer/replay` throw. Pick one: down-convert on export, gate them behind an explicit "TestFlow-extended" export with plain DevTools as the default, or amend the README. Add a unit test that validates exported JSON against the real DevTools schema.
- **Cancellable replay (A5).** `stopRun` doesn't stop the loop, which then overwrites the user's stop with a spurious failure. Use an `AbortController` checked each iteration.
- **Session start race (A6)** and **the two divergent stop paths (A7)** — one state machine, one stop.
- **Record-this-tab without a reload (A8).** The current `chrome.tabs.reload` destroys exactly the mid-flow state the feature exists to capture.
- **Password codegen (A9).** `.fill('')` silently breaks every exported login test. Emit `process.env.TEST_PASSWORD!` (or similar) with a header comment listing required variables.
- Sweep the A10 table.

## Phase 3 — Recorder → test tool (the real work)

- **Assertion authoring — highest value item in this document.** `waitForElement` is fully plumbed through types, validation, codegen, and replay, and *nothing ever creates one*. Add an assert mode (Alt+Click or a badge toggle): hover-highlight an element, pick from visible / hidden / text equals / text contains / value equals / URL matches, emit a real assertion step. Render assertions distinctly in the step list, in the JSON, and in the generated Playwright. **Without this, a flow only fails when an element is missing** — it cannot detect a wrong price, a broken submit, or a 500 behind a spinner.
- **Flow editing.** Delete, reorder, and insert steps; edit values; **swap selectors from the stored candidate list** (the candidates are already saved — the UI just doesn't expose them); add assertions post-hoc; parameterize values as variables. Currently only the title is mutable, so one misclick means re-recording everything.
- **Run history.** A `runs` collection: status, per-step results, duration, timestamps, failure screenshot/DOM snapshot. Show pass/fail history and flake rate on the flow page. Nothing currently survives a page reload.
- **Unattended execution.** `@puppeteer/replay` is cited five times in the docs and is not a dependency. Add it, add `npm run flow:run <id|file>`, and ship a GitHub Actions workflow that runs saved flows on a schedule and posts results back. This is the difference between a recorder and a test tool.
- **Better failure reporting.** "no selector matched" is currently a dead end. Report which selector groups were tried, how the consensus vote went, and what the DOM looked like — that data is computed in `voteResolve` and thrown away.

## Phase 4 — Foundation

- **Unit tests + Vitest** for every pure function: `voteResolve`, `selectorsFor`, `cssFor`/`xpathFor`, `flowToPlaywright`, `exportSteps`, `fromSnapshot`, `keyInfo`. Note that the export bug in A4 is precisely what one `exportSteps` test would have caught.
- **Port the E2E suites to Playwright Test** — `webServer` config so they no longer silently require a running dev server, trace and video on failure, all failures reported instead of `process.exit(1)` on the first.
- **CI**: typecheck, lint, unit tests, both E2E suites, extension build. There is no `.github/` today, so nothing is enforced.
- **Extract the replay player** from `flows/[id].tsx` into `lib/player.ts` as a pure state machine over an injected transport, and unit-test the races (`readyCount`/`settledCount`, waiter overwrites, navigation recovery) directly.
- **Fix the build hygiene**: gitignore `extension/dist/`, typecheck `scripts/`, add Prettier + `.nvmrc` + `engines` + a LICENSE.

## Phase 5 — Scale & deployability

- **Configurable dashboard origin** via an options page + `chrome.storage.local` + `chrome.permissions.request`, replacing the three hardcoded `localhost:3000` sites.
- **O(n) step persistence** — chunked keys or buffered writes; the current full-object rewrite per step is O(n²) in the recording hot path.
- **Delta broadcasts** instead of a full snapshot per page load.
- **Selector generation off the interaction path** (`requestIdleCallback`) so recording doesn't inject jank into the app under test.
- **Chunked storage for long flows** — today a recording over 900 KB simply cannot be saved, and the error advises splitting with no way to split.
- **Suites, tags, and environments** (staging vs prod base URL); search and pagination on the flows list.
- **Trusted replay via `chrome.debugger`** (the planned E7) to close the `isTrusted` gap.

## Phase 6 — Polish

Delete confirmation; error boundary; `role="alert"` on errors; retry on load failure; step-level replay progress with auto-scroll and elapsed time; copy buttons and syntax highlighting on the JSON/Playwright tabs; extension icons; dark-mode toggle; rewrite `ARCHITECTURE.md` to describe only what exists (archive v1/v2 to `docs/history/` with a header saying they describe removed code) and fix `AGENTS.md`, which currently points at a docs directory containing one generic welcome page.

## How to work

Phase 1 first — the API is currently unauthenticated and the setup docs tell users to open their database to the world. Then Phase 2, since correctness bugs undermine every feature built on top. Phase 3 is where the product changes category; C1 (assertions) alone is worth more than the rest of that phase combined.

Ship each phase as a reviewable increment: tests with the code, green CI, docs updated in the same commit. When a fix and the documentation disagree about what the system does, the documentation is what's wrong — but say so explicitly rather than quietly editing it.
