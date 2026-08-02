# Setup

Two pieces: the **dashboard** (Next.js, this repo) and the **extension**
(`extension/`, records in your own Chrome). No other processes.

## 1. Dashboard

```bash
npm install
npm run dev          # http://localhost:3000
```

## 2. Extension (one-time)

```bash
npm run build:ext
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select `extension/dist`. After changing extension code, run `npm run build:ext`
again and hit ↻ on the extension card.

The dashboard's Record page detects the extension automatically and shows these same
steps if it's missing.

### Why it asks for the "debugger" permission

Replay drives Chrome's Input domain so the page receives **real** events —
`isTrusted: true`, real hover, `:focus-visible`, native scrolling. A content script
can only `dispatchEvent()`, which no app that checks any of those will treat the same
way, so a synthetic replay quietly proves less than it looks like it does.

It is attached **during replay only**, and detached the moment the run ends.
Recording never attaches — Chrome's "started debugging this browser" infobar would
shrink the very viewport being measured. If attaching fails (DevTools open on that
tab, or another debugger already there), replay falls back to synthetic events and
labels every affected step in the run, rather than downgrading silently.

## 3. Firebase (only needed to SAVE flows)

Recording works with zero configuration — steps live in the extension + dashboard
until you save. To persist flows:

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Build → Firestore Database → Create database** (test mode is fine — nothing
   touches Firestore from the browser)
3. **⚙ Project settings → Service accounts → Generate new private key**
4. `cp .env.example .env.local` and fill from the downloaded JSON:

| `.env.local` | JSON key |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` |
| `FIREBASE_PRIVATE_KEY` | `private_key` — keep the quotes and the literal `\n` |

Free (Spark) plan is enough: one write per saved flow, a handful of reads to browse
them. No composite indexes needed.

---

## Using it

1. **Record** page → enter a URL → **Start Session**. The extension opens the site in
   a new tab and records every interaction — any site, across hard navigations,
   through CSP, in iframes. Steps stream into the dashboard live.
   - Or hit **⏺ Record** in the extension popup on any tab you're already on.
   - A dashboard reload mid-recording rejoins the session (state lives in the
     extension, not the page).
2. **Stop** → name it → **Save flow** (one Firestore doc) or **Download JSON**.
3. On the flow page: **Run in tab** replays it through the extension with step-by-step
   pass/fail; the **Playwright** tab shows generated code; **Download JSON** exports
   the exact Chrome DevTools Recorder format (importable into DevTools, runnable by
   `@puppeteer/replay`).

Password fields are recorded with an **empty value** — fill them into the flow (or an
env var in exported code) yourself.

### Try it with nothing set up

The Record page has a **demo page** button (`/demo.html`). Or run the whole loop
headlessly:

```bash
npm run e2e          # records on demo.html through the real extension — 12 assertions
npm run e2e:replay   # replays steps through the extension bridge — 9 assertions
```

### Dashboard on a different origin?

The bridge content script is matched on `http://localhost:3000` in
[extension/manifest.json](extension/manifest.json). Deploying the dashboard elsewhere
= add that origin to the bridge's `matches` and rebuild.

---

## Known limits

- **Replay uses synthetic events** (`isTrusted: false`). The rare handler that checks
  trust won't fire. The planned fixes are `chrome.debugger`-based trusted input (E7)
  or executing flows with `@puppeteer/replay`/Playwright in CI (E8) — see
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Replay drives one tab** — flows that open popups replay their steps in the same
  tab, which works for same-site popups but not true multi-window choreography.
- **Scheduled/headless execution isn't built yet** (E8, decision deferred). The saved
  JSON is already in the exact format those engines consume, so nothing recorded
  today is throwaway.
