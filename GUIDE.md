# TestFlow — plain-English guide

What this is, how it works, and what you need to do.

---

## 1. What it does, in one paragraph

You click around a website. TestFlow watches and writes down everything — not just
*what* you clicked, but which tab and which iframe you were in, how big your screen
was, which fonts your machine had, what you answered when a popup asked, which file
you uploaded. Later, it does the whole thing again — in your browser, or in
Playwright — and tells you exactly what was different, by name.

The goal is not "the test passed". It is **"the replay was the same session, and here
is the list of things that could not be identical, and why."**

---

## 2. The one idea behind the design

A recording that only stores *actions* can repeat them. It cannot reproduce the
session.

If you clicked a button inside an iframe and the recording forgot which iframe, no
amount of cleverness later can work it out. If your machine had the font Inter and
the replay machine does not, every line of text is a slightly different width and
nothing will explain why.

So: **capture everything that decides the outcome, and name everything that cannot be
reproduced.** That's it. Every decision below follows from that.

---

## 3. What was built

### The recording keeps three things, not one

| | What it holds | Why |
|---|---|---|
| **Steps** | click, type, scroll, drag… | The actions. Standard Chrome DevTools Recorder format — you can open it in Chrome. |
| **Meta** | one entry per step: which tab, which iframe, the time, the scroll position, dialog answers, uploaded bytes, secret names | The context. Without it a replay repeats actions in the wrong place. |
| **Env** | screen size, zoom, scrollbar width, fonts, language, timezone, browser version | The conditions. Without it the page *lays out* differently. |

The **Steps** part stays exactly what Chrome would have written, so it stays
compatible. Meta and Env ride alongside it, never inside it.

### Both replay engines behave the same

There are two ways to replay: in your browser (the extension) and in Playwright.
They used to disagree in an important way — the browser one faked its clicks, so
websites could tell. Now both send **real** clicks through the same low-level Chrome
channel. A site that checks "was this a real human?" gets the same answer either way.

### Everything that goes wrong has a name

Not "the test failed". Instead:

- `E_FONT_SUBSTITUTION` — this machine doesn't have Inter, so text is a different width
- `E_VIEWPORT_CLAMPED` — your screen is smaller than the recording's window
- `E_SCROLLBAR` — this machine draws scrollbars differently, shifting everything 8px
- `E_SECRET_MISSING` — this flow needs a password you haven't given it
- `E_FRAME_MISSING` — the iframe this step lived in never loaded
- `E_DOWNLOAD_MISSING` — the recording downloaded a file here; this run didn't

Each one comes with the fix.

### Two modes, and only one may judge appearance

- **Live** — runs against your real website. Content changes between runs, so
  differences are *information*, never a pass/fail.
- **Sealed** — records all network traffic once, then serves every future run from
  that recording, with the clock frozen and randomness seeded. Same input, same
  output, every time. This is the only mode where "it came out different" is a real
  result.

---

## 4. The architecture

```
   YOU CLICK AROUND
          │
┌─────────▼──────────────────────────────────────────────┐
│  CHROME EXTENSION                                      │
│                                                        │
│  content script   in every frame, from the first ms    │
│                   → what you clicked, and where        │
│  main world       → page navigations, popups, dialogs  │
│  service worker   → the session, tabs, frames          │
└─────────┬──────────────────────────────────────────────┘
          │  live stream
┌─────────▼──────────────────────────────────────────────┐
│  DASHBOARD (Next.js)                                   │
│  watch steps appear · save · export                    │
└─────────┬──────────────────────────────────────────────┘
          │
     ┌────┴─────┐
     ▼          ▼
  Bundle     DevTools JSON
  (.tfflow)  (opens in Chrome)
     │
┌────▼───────────────────────────────────────────────────┐
│  REPLAY — two engines, one shared brain                │
│                                                        │
│   In your browser              In Playwright           │
│   (the extension)              (npm run flow)          │
│          │                            │                │
│          └──── same element finder ───┘                │
│          └──── same real clicks ──────┘                │
│                       │                                │
│                       ▼                                │
│                  THE REPORT                            │
│         every step: passed / failed + why              │
│         every difference: named + how to fix           │
└────────────────────────────────────────────────────────┘
```

**Why "one shared brain" matters:** finding the right element on the page is the
hardest part, and it is written **once** and used by both engines. Two copies would
slowly drift apart and the same recording would mean two different things.

### How it finds elements (the interesting bit)

When recording, it describes each element five or six different ways at once: its
test id, its label, its position, its text. On replay it tries **all of them** and
picks the element that **most of them agree on**.

So if a developer changes the page layout and the "position" description now points
at the wrong button, the label and text descriptions outvote it. This is why replays
survive real code changes, and why nothing has to guess.

---

## 5. What you have to do

### First time — 3 commands

```bash
npm install
npm run build:ext     # builds the Chrome extension
npm run dev           # dashboard at http://localhost:3000
```

Then load the extension into Chrome:
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → pick the `extension/dist` folder

Chrome will warn that it can "read and change data on all sites" and use the
**debugger**. Both are needed: the first to record on any site, the second to send
*real* clicks during replay. It only attaches while replaying, never while recording.

### To record

1. Go to `http://localhost:3000`
2. Type the site's URL → **Start Session**
3. A new tab opens. Use the site normally.
4. Come back to the dashboard → **Stop recording**
5. **Download bundle** (this is the one the runner uses)
   — or **Save flow** if you set up Firebase, so it lives in the dashboard

> **Download bundle** vs **Download JSON**: the bundle is the full recording.
> The JSON is the Chrome-compatible version, which drops the extra context.
> Use the bundle for replay; use the JSON for opening in Chrome DevTools.

### To replay

**In the browser** — open the saved flow in the dashboard, click **Run in tab**.
You watch it happen. Steps light up green or red as they go, and a pointer glides to
each target before it clicks, so you can see where the run is. Untick **Cursor** to
turn that off — it costs a moment per step.

**Route waits.** A flow that moved between SPA routes carries a `waitForExpression`
step per route change, asserting `location.pathname + location.hash`. Untick **Route
waits** if the route legitimately differs every run — a session id in the path, an
A/B redirect. Those steps then report **skipped**, never passed: the run no longer
proves the flow reached the recorded route, and it says so rather than going quiet.
The toggle only appears on flows that have one, and it only touches the recorder's
own location assertions — a hand-written expression in an imported DevTools flow
still runs.

**In Playwright** — from the terminal:

```bash
npm run flow -- my-recording.tfflow.json
```

Useful flags:

```bash
--headed                      # watch it in a visible browser
--speed recorded              # replay with your original pauses
--secret LOGIN_PASSWORD=xyz   # supply a password the recorder didn't store
--har-record traffic.har      # save all network traffic
--har-replay traffic.har      # replay against saved traffic (sealed mode)
--continue                    # don't stop at the first failure
--no-route-waits              # skip the SPA route assertions (reported skipped)
```

Exits `0` if everything passed, `1` if not — so it drops into CI as-is.

### If a flow needs a password

Passwords are never stored. The recording notes only the *name*. Supply it as either:

```bash
npm run flow -- login.tfflow.json --secret LOGIN_PASSWORD=hunter2
# or
export TESTFLOW_SECRET_LOGIN_PASSWORD=hunter2
```

If you forget, it fails saying exactly which one is missing — it will never type an
empty password and call that a pass.

### To check nothing is broken

```bash
npm test              # unit tests — fast, no browser
npm run typecheck
npm run lint
npm run e2e           # recording, in a real browser
npm run e2e:replay    # replay in the browser
npm run e2e:runner    # replay in Playwright
npm run e2e:cli       # the full round trip: record → export → replay
```

`npm test` runs in a second and needs nothing. The E2E suites drive a real browser
and need `npm run dev` running.

---

## 6. Things to know before you rely on it

**Different machine = different pixels.** Fonts, scrollbars and screen scaling vary
by computer. The report tells you exactly which ones differ, but it cannot make them
identical. For consistent results across machines, run in Docker with a fixed font
set.

**Live mode cannot judge appearance.** Your real site shows different data every day.
Use sealed mode (`--har-replay`) when you need "it came out exactly the same" to
actually mean something.

**Closed shadow DOM cannot be recorded.** Some components deliberately seal
themselves off. Nothing can see inside — not this tool, not any tool. If a step fails
with "no selector matched", the report checks for this and tells you.

**Uploads are capped at 256 KB.** Bigger files record their name only, and the step
is marked as degraded so you know before you run it.

**Sites with a strict security policy (CSP) are handled, with one limit.** Most sites
forbid running text as code, which is how the replayer used to check "did the page
navigate to /checkout?". Route checks now work without it. Custom assertions you write
yourself still need the debugger attached — which it is, during a normal replay.

**Links and buttons that open a new tab need the debugger permission.** Chrome's
popup blocker refuses `target="_blank"` and `window.open()` unless the click was real
input. If the extension cannot attach its debugger, same-tab navigation still works
but new tabs silently never open — and every affected step is labelled in the run.

**A click that lands on an overlay is now a failure, not a pass.** If a cookie bar or
sticky header covers the thing you clicked, the replay stops and names what was in
the way (`E_OCCLUDED: div#cover is on top of the target`). Previously it clicked the
overlay and reported success — the worst possible outcome.

**Screenshot comparison is not built.** You asked to skip it. Everything it would
need is already in place (the environment record, scroll restoration, the settle
logic, the naming system) — what's missing is capturing images and comparing them.

---

## 7. Where things live

| Folder | What's in it |
|---|---|
| `extension/` | the Chrome extension — recording and in-browser replay |
| `src/shared/` | the shared brain: element finder, environment capture |
| `src/runner/` | the Playwright replayer and the report |
| `src/pages/` | the dashboard |
| `scripts/` | the CLI (`run-flow.mts`) and the test suites |
| `REPORT.md` | the detailed engineering write-up |
| `README.md` | the technical overview |
