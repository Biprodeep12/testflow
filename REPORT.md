# Recorder → Playwright: what was built, and why

A report on turning TestFlow from a recorder that *re-performs* a session into one
that *reproduces* it — deterministically, in two engines, with every unreproducible
difference named rather than discovered.

Status: phases 0, 1, 2, 4, 5 and 6 complete. Phase 3 (screenshot parity) skipped at
your direction. **108 automated checks pass**, alongside typecheck, lint, and a
production build.

---

## 1. The premise

Two facts about the codebase decided everything that followed.

**Identity was being thrown away at record time.** Every step was written with
`target: "main"` hardcoded, and the service worker routed replay to `tabIds[0]`. A
click inside an iframe and a click in the top document produced identical records. No
amount of cleverness at replay time can recover information the recording never kept —
so this had to be fixed before anything else could be built on top.

**There was no oracle.** Nothing about the recording environment was captured beyond
width, height and DPR. A replay could not tell whether it looked like the original,
and — more importantly — could not explain why not.

And one truth that shaped the architecture:

> Pixel parity is a property of **content determinism**, not of input fidelity.
> Perfect actions against a live backend still produce different pixels.

That is why the system has two declared modes, and only one of them may assert on
appearance.

---

## 2. Architecture

```
┌─ CAPTURE (MV3 extension) ─────────────────────────────────────┐
│ content script  — all frames, document_start                  │
│                   interactions, selectors, frame identity     │
│ main world      — history API, native dialogs, expressions    │
│ service worker  — session, target graph, frame registry,      │
│                   CDP input during replay, downloads          │
└───────────────────────────┬───────────────────────────────────┘
                            ▼
                     THE FLOW DOCUMENT
   steps[]  ── pure DevTools Recorder JSON, byte-compatible
   meta[]   ── one entry per step, same index (sidecar)
   env      ── the recording environment (sidecar)
                            ▼
┌─ SHARED EXECUTION CORE ───────────────────────────────────────┐
│ src/shared/resolve.ts — consensus element resolution          │
│ src/shared/env.ts     — environment capture                   │
│ ONE implementation, shipped into the page by BOTH engines     │
└───────┬───────────────────────────────┬───────────────────────┘
        ▼                               ▼
  In-browser replay              Playwright runner
  (extension, CDP input)         (interpreter, CDP input)
                                        ▼
                                 PARITY REPORT
                        per step: pass/fail + named cause
                        per env:  delta + the fix for it
```

Three decisions carry the design.

### The runner is an interpreter, not generated code

`src/codegen/fromFlow.ts` produces a *text program* — necessarily a second
implementation of replay semantics, and a lossy one (it maps `aria/Name` onto a
`getByText().or(getByLabel())` guess, and cannot express consensus voting at all).

`src/runner/run.ts` is now the authoritative path: it reads the flow directly.
Codegen remains as the readable export, and where the two disagree the runner is
right. This is stated in the codegen header so nobody has to guess.

### One resolver, shipped into the page by both engines

`resolveInPage` is written self-contained so it can be serialized. The extension
imports and calls it; the runner ships the same source into the page via
`pageExpr()`. Two copies would eventually resolve the same step to two different
elements — precisely the browser-vs-Playwright divergence the system exists to
remove.

The `__name` shim in `pageExpr` is not decoration: esbuild/tsx compile with
`keepNames`, which wraps nested functions in a helper that exists in the bundle but
not in the page. A naively serialized function throws `ReferenceError` on first call.

### Sidecars, so the recording model is preserved exactly

`frame` and `target` are native DevTools fields and are used as such. Everything else
— frame element selectors, monotonic stamps, scroll state, dialogs, uploads, secret
names, downloads, native-drag markers — lives in `meta[]`, indexed in lockstep with
`steps[]`. `exportSteps()` still emits byte-compatible DevTools JSON.

---

## 3. What each phase delivered

### Phase 0 — Identity

| Problem | Resolution |
|---|---|
| Frame identity discarded | Each frame negotiates its position with its parent over `postMessage` — the one channel that works cross-origin. Chains build top-down and terminate at the main frame. |
| Replay broadcast to all frames | The service worker keeps a frame registry and sends each step to one `frameId`. |
| Tabs unidentifiable across runs | Logical targets (`t0`, `t1`…) assigned by opener order, re-bound at replay to whatever windows open. |
| SPA routes invisible | `history.pushState`/`replaceState` patched in the **main world** (patching from the isolated world patches a different object), recorded as native `waitForExpression` steps. |
| Pacing on wall-clock | `performance.timeOrigin + performance.now()`. Wall-clock goes backwards when the system clock is corrected mid-recording. |

Each frame link carries **two** identities, because they fail differently: the native
index path (breaks on frame reordering) and the iframe element's own selectors
(survives it, and is what `frameLocator()` needs).

SPA routes assert on `location.pathname + location.hash` — query strings carry session
tokens and cache-busters that differ every run.

### Phase 1 — Environment

Captured once, before the first step: viewport, layout width, **scrollbar width**,
DPR, screen, UA, locale, timezone, `timeOrigin`, colour scheme, reduced motion,
forced colours, touch, WebGL renderer, granted permissions, and a **font
fingerprint**.

Two of those are worth calling out:

- **Scrollbar width** is the most-missed cause of whole-page drift. Classic versus
  overlay scrollbars shift every centered element by 7–8px.
- **Fonts are fingerprinted by measured width**, not by `document.fonts`, which only
  knows about webfonts. It cannot tell you that Inter silently fell back to Arial on
  a machine that never had it. A canvas `measureText` probe can.

### Phase 2 — The Playwright runner

Context construction from `env`, then **verification**: the same capture function
runs again inside the live page, and the delta is the report's environment section.
Headed Chrome silently clamps a viewport larger than the screen work area — without
the read-back that looks like a rendering bug for a week.

Input is a hybrid: consensus locator → `boundingBox()` → recorded offset →
`page.mouse`. Not coordinates alone (brittle), not `locator.click()` alone (re-centers
and loses the recorded offset, changing hover and ripple origin).

`networkidle` was removed. Playwright discourages it, and it says nothing about
whether fonts and images have landed.

### Phase 4 — Sealed mode

`runFlow(flow, { har: { path, mode: "record" | "replay" } })`. Record the network
once; replay serves everything from the archive with `notFound: "abort"`. Falling
through to the live network would quietly mix recorded and live content, and the run
would no longer be a function of the archive. Requests the recording never saw are
reported, never silently fetched.

Combined with a pinned clock (`clock.setFixedTime` per step, following the
recording's own timeline) and a seeded PRNG, a sealed run is reproducible.

**Deliberately not included: frozen timers.** An app whose debounces and transitions
never fire behaves differently from the one recorded — that trades one divergence for
a worse one. `setFixedTime` makes `Date` deterministic while leaving `setTimeout`
alone.

### Phase 5 — Executor convergence

The single structural divergence between the two engines: a content script can only
`dispatchEvent()`, which produces `isTrusted: false`, no real hover, no
`:focus-visible`, no native scrolling. Playwright had none of those limits. The same
flow genuinely meant two different things.

The extension now drives Chrome's Input domain via `chrome.debugger` — the same
channel Playwright uses. Verified directly: the demo page records `event.isTrusted`,
and the in-browser replayer's click now reports `true`.

Two decisions inside that:

- **Replay only.** Attaching during recording would add Chrome's debugging infobar to
  the very viewport being measured — a fidelity bug in the mechanism meant to prevent
  them.
- **The fallback is loud.** When attach fails (DevTools open, another debugger), replay
  falls back to synthetic events and labels every affected step in amber in the UI. A
  silent downgrade means the run proves less than it appears to.

The hard part was coordinates: CDP aims in top-frame pixels, but an element inside an
iframe only knows its position in its own document. Frames negotiate their offset with
their parent, recomputed per action because scrolling moves them, and accounting for
the iframe's border and padding — the child's viewport starts inside those, not at the
element's edge.

### Phase 6 — The long tail

| Capability | How it is carried |
|---|---|
| **Dialogs** | `alert`/`confirm`/`prompt` patched in the main world. Recording calls the real one and reports the answer; replay answers from the recording without opening anything. An unanswered `confirm()` blocks forever; a different answer takes the other branch. |
| **Uploads** | Bytes travel with the flow (capped at 256 kB; over that the step is marked degraded rather than silently unrunnable). |
| **Secrets** | Passwords recorded as a **name**, never a value. Supplied via `RunOptions.secrets` or `TESTFLOW_SECRET_*`; missing ones fail by name instead of typing `""` and passing. |
| **Native drag-and-drop** | Detected via `dragstart`, ended via `dragend` (pointer events stop once the drag machinery takes over), pathed from `drag` events. |
| **Downloads** | Filename taken from the page's own `<a download>` where possible — exact, and independent of how the browser later names the file on disk. The `chrome.downloads` listener covers the JS-initiated case. |
| **Scroll anchors** | Each scrolled container records the row at its top and how far past it. A position in *content*, which is the only description that survives a virtualized list. |
| **Permissions** | Granted up front from the environment record; replay cannot click a native permission bubble. |
| **Media** | Autoplaying media held at frame zero — on by default in sealed mode only, since a flow whose subject *is* the video needs it playing. |

---

## 4. Failure vocabulary

Every way a run can diverge has a code, and the report names one per finding. "The
screenshot differs" is not a usable result.

| Code | Meaning |
|---|---|
| `E_VIEWPORT_CLAMPED` | headed Chrome shrank the requested viewport to fit the screen |
| `E_DPR_MISMATCH` | device scale differs; it is per browser process |
| `E_SCROLLBAR` | classic vs overlay scrollbars — every centered element shifts |
| `E_FONT_SUBSTITUTION` | a typeface resolved to a different face on this machine |
| `E_TIMEZONE` / `E_LOCALE` / `E_COLOR_SCHEME` | environment not applied |
| `E_BROWSER_VERSION` | different engine build |
| `E_TARGET_MISSING` / `E_FRAME_MISSING` | the tab or frame the step needs never appeared |
| `E_NO_MATCH` | no selector group resolved |
| `E_VIRTUAL_ANCHOR` | the row a scroll was anchored to is gone |
| `E_SECRET_MISSING` | the flow needs a secret that was not supplied |
| `E_DOWNLOAD_MISSING` | the recording downloaded a file here; this run did not |
| `E_CONTENT_DRIFT` | sealed mode: a request the archive cannot serve |
| `E_DEGRADED` | the recorder already knew this step could not replay faithfully |

Environment deltas are split by whether Playwright can *emulate* them. Timezone,
locale and colour scheme are applied, so a correct runner makes them match by
construction — the test is that they were applied. Fonts, viewport clamping, DPR and
scrollbar width cannot be forced, so those are the ones that must be detected.

---

## 5. Verification

| Suite | Checks | Covers |
|---|---|---|
| `npm test` | 39 | pure functions, no browser: export purity, sidecar pairing, frame identity, codegen + step-type conformance |
| `npm run e2e` | 50 | recording: selectors, scroll classification, consumed wheel, drags, key holds, frame identity, SPA routes, dialogs, uploads, native DnD, anchors, downloads, export purity |
| `npm run e2e:replay` | 35 | in-browser replay through the real extension: consensus resolution, **trusted input**, frame offset arithmetic, popups via `_blank` and `window.open` |
| `npm run e2e:runner` | 37 | Playwright replay: frames, popups, link navigation (plain / 302 / JS / `_blank`), occlusion, env verification, dialogs, secrets, uploads, native DnD, anchors, downloads, sealed mode |
| `npm run e2e:cli` | 12 | the round trip a user takes: record → export bundle → `npm run flow` |

All three drive a real Chromium with the real extension loaded. Notable proofs:

- A step recorded in frame 1 runs in frame 1 and **not** in the identical frame 0 —
  the assertion that the untouched frame stayed untouched is what makes it meaningful.
- The frame offset the protocol reports matches Playwright's own `boundingBox()`
  measurement to within a pixel (649,228.89 vs 649,229).
- A native HTML5 drag actually drops, `dataTransfer` and all — which only works
  because the input is real.
- A dismissed dialog replays as dismissed: the answer is not cosmetic.
- A download that did not happen is reported, not passed over.

### Later fixes (after the first review)

**Occluded clicks passed silently — the worst bug in the system.** Raw `page.mouse`
input goes to whatever pixel it is given; `locator.click()` checks for occlusion and
raw input does not. A link under a sticky bar was clicked, the overlay absorbed it,
and the step reported **pass** having done nothing. Both engines now hit-test with
`elementFromPoint` in the element's own frame before sending input, retry once after
scrolling (which resolves the common sticky-header case), and fail with `E_OCCLUDED`
naming the blocker.

**The determinism controls never ran.** `addInitScript` serializes a function the same
way `evaluate` does, and `installDeterminism` has nested declarations that the
compiler wraps in a `__name` helper the page has never heard of — so it threw on every
page load, silently, because init scripts are not awaited. The exact trap documented
in `pageExpr`, walked into anyway. Now passed as source. A test asserts `Math.random`
was actually replaced.

**Every SPA route assertion failed on any site with a real CSP.** `new Function(...)`
inside the page is refused outright when the policy omits `unsafe-eval` — which is
most sites — so the `waitForExpression` step that every recorded route change
produces could not run at all. Two answers, because they cover different cases: the
recorder's own assertions are matched **structurally** (`src/shared/expressions.ts`,
no evaluator involved, works with no debugger attached), and anything hand-written
goes over the debugger protocol, which is not page script and not subject to the
page's CSP. The Playwright runner was never affected — CDP bypasses CSP already.
A fixture served with a strict policy now covers both engines, including a check
that a genuinely false assertion still fails.

### Review pass

Four defects found by testing paths nothing covered, plus a new suite
(`npm run e2e:long`) that records 200 steps, exports the bundle a user downloads,
and replays it — the shape where per-step cost and sidecar drift actually show up.

**In-browser replay typed empty passwords and reported success.** The runner refuses
a step whose value was never captured and names the missing secret; the extension's
`change` handler ignored `secretRef` entirely, filled `""`, and returned ok. The
precise failure the secret reference exists to prevent, in the one engine nobody had
tested it in. It now fails, names the secret, and points at `--secret`.

**Popups were bound to whichever target asked first, not the order they opened.** A
flow opening two windows and then acting on the second one first attached that step
to the first window. Binding now happens as pages open, from the recorded order —
the same rule the extension already used. (The function that computed that order was
present but its result discarded, which is what drew attention to it.)

**A failed step write vanished silently.** If storage rejected a write — full, most
likely — the queue's error handler swallowed it and recording continued, so the user
would save a flow that looked complete and was missing steps in the middle. The
session now carries the failure and the dashboard shows it.

**The cursor's position lookup cost a full second on a missing element.** Purely
cosmetic work used the step's real budget, so a step whose element was slow to appear
waited 1s for the pointer and then again for the step itself. Cut to 350ms.

**Recording got slower the longer you recorded.** Measured, split three ways:

| steps | recorder | service worker | React | total |
|---|---|---|---|---|
| 1–50 | 24ms | 23ms | 4ms | **29ms** |
| 151–200 | 18ms | 28ms | 9ms | **38ms** |
| 251–300 | 20ms | 36ms | 13ms | **54ms** |

The recorder itself was flat; the two layers behind it were not. The service worker
kept every step inside one storage value and rewrote **the whole recording on every
step** — linear per step, quadratic per session. Steps now live one key each
(`tf-s-<id>`), so a write costs the same at step 900 as at step 9; the full set is
gathered only for snapshots and saves. The dashboard re-rendered every row on every
step, so the live list is capped at the most recent 150 (nothing is dropped from the
flow), and its auto-scroll no longer uses `behavior: "smooth"`, whose animations
queued up faster than they could finish. After: **flat at ~28ms across 400 steps.**

The recorder's own hot path was tightened in the same pass, though it was not the
cause: `querySelectorAll(sel).length === 1` per candidate became
`querySelector(sel) === el` (short-circuits, and is the same question replay asks),
the CSS path and XPath now share one ancestor walk instead of scanning siblings
twice, `textContent` is no longer serialised on containers only to be discarded by
the 60-character limit, and repeatedly-described scroll containers are cached behind
a one-query validation. A step slower than 120ms now says so in the recorded page's
console, with the breakdown.

**New tabs got synthetic input, so popups silently never opened.** The debugger was
attached to the session's first tab only. Every other tab fell back to
`dispatchEvent`, which carries no user activation — and Chrome's popup blocker
refuses `target="_blank"` and `window.open()` without one. The result was an exact
asymmetry: the same click navigated fine in the same tab and did nothing at all when
it should have opened a new one. Every tab joining a replay now gets a debugger
session, and is detached when it closes.

**Session writes raced each other.** `tabs.onCreated`, `tabs.onRemoved` and
`downloads.onCreated` each did read-modify-write on one storage key outside the queue
that message handling used. A popup joining the session at the same moment its first
page announced itself meant one of the two writes vanished. All session mutations now
share one queue — except `runStep`, which waits for a tab that a queued task binds and
would deadlock on itself. It waits up to 5s for a target instead of failing instantly,
because the step that opens a popup finishes before the browser has created it.

**Sidecars are keyed by step id.** Index lockstep was a convention maintained across
six hops; one filter or sort anywhere silently attached every step to the wrong
context. Steps carry an `id` (stripped on export), meta carries `stepId`, and
`alignmentProblems()` reports a mismatch as a run warning rather than letting it pass
as truth.

**A unit test suite exists** (`npm test`, 39 tests, ~1.5s, no browser). It covers the
pure functions every layer trusts: export purity, sidecar pairing, frame identity, and
codegen — including a conformance test that fails when the runner learns a step type
the export never hears about.

### Bugs the tests found

1. **`frameLocator()` given an `aria/` selector.** The recorder ranks selectors by
   durability, which often puts `aria/Name` first — and `frameLocator` has no aria
   engine, so generated code threw on any iframe flow. The interpreter was never
   affected; it uses the shared resolver.
2. **Anchored scroll off by the border width.** `getBoundingClientRect()` returns the
   *border* box, so every anchored restore on a bordered container was off by a
   constant. Found by a probe that produced 601 where 600 was expected.
3. **Native drags recorded nothing.** Chrome stops firing `pointermove` once the drag
   machinery takes over, so the gesture never registered as "moved", and
   `pointercancel` was destroying the state that `dragend` needed.
4. **`dataTransfer.types` always empty.** Read in the capture phase, before the page's
   own `dragstart` handler had called `setData`.
5. **Env-less flows lost their viewport.** Moving viewport into `test.use()` meant an
   imported DevTools JSON with no environment record never set one at all.

---

## 6. Judgement calls

**One security gate was loosened.** Programmatic file selection produces no trusted
`change` event, so uploads could never be recorded under any automation. File inputs
are now the one place `isTrusted` is not required — justified because a page cannot
open a file picker unprompted, so the risk the gate exists to stop does not apply.
Commented at the call site. If you would rather keep the gate absolute, uploads become
manual-recording-only.

**The `debugger` permission is a real cost.** It shows Chrome's "started debugging this
browser" infobar and reads as invasive on an extension listing. It buys trusted input
in the browser, and would also buy unthrottled screenshots and HAR capture if phase 3
is ever revisited. Attached during replay only.

**Sealed mode currently records its HAR from a runner pass**, not from the extension.
That needs no new permissions and works today. Capturing the HAR during the original
browser recording would need `chrome.debugger`'s Network domain *during recording*,
with the infobar cost that implies — worth making opt-in if you want it.

---

## 7. What is not done

- **Phase 3, screenshot parity.** Skipped at your direction. The environment record,
  scroll restoration, settle logic and cause classification it would need are all in
  place; what remains is capture transport and image diffing.
- **Closed shadow roots.** Unrecordable and unreplayable by construction. Currently
  neither detected nor marked.
- **Beyond-viewport and cross-origin popup chains** (OAuth through a third-party
  consent screen) are handled structurally but untested against a real provider.
- **`E_CONTENT_DRIFT` is reported at the request level**, not correlated to the step
  that suffered it.

---

## 8. Where the code lives

| Path | Role |
|---|---|
| `src/types/flow.ts` | the flow document: DevTools steps, sidecars, message protocol |
| `src/shared/resolve.ts` | consensus element resolution — shipped into the page by both engines |
| `src/shared/env.ts` | environment capture — run at record time *and* replay time |
| `src/runner/run.ts` | the interpreter |
| `src/runner/env.ts` | environment application and verification |
| `src/runner/locate.ts` | frame walking, element resolution, anchored scroll restore |
| `src/runner/types.ts` | the failure vocabulary |
| `src/codegen/fromFlow.ts` | the readable export |
| `extension/src/content/frames.ts` | frame identity and viewport-offset negotiation |
| `extension/src/content/recorder.ts` | capture, and in-browser replay |
| `extension/src/sw/cdp.ts` | real input via `chrome.debugger` |
| `extension/src/sw/index.ts` | sessions, targets, frame routing, downloads |
