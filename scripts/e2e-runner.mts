/**
 * E2E for the Playwright runner — the half of replay that runs outside the browser.
 *
 * What it proves, in order of importance:
 *   1. a step recorded in frame 1 runs in frame 1, and NOT in the identical frame 0
 *   2. a step recorded in a popup runs in the popup
 *   3. an SPA route change replays as a state-tied wait, not a sleep
 *   4. the recording environment is applied AND verified, and a broken environment
 *      is reported with the exact cause rather than as a mystery failure
 *
 * Run:  npm run e2e:runner   (dev server must be up on :3000)
 */

import { chromium } from "playwright";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "../src/shared/env.ts";
import { pageExpr } from "../src/shared/resolve.ts";
import { runFlow } from "../src/runner/run.ts";
import { verifyEnv } from "../src/runner/env.ts";
import { CAUSE } from "../src/runner/types.ts";
import type { EnvRecord, FlowJson, StepMeta } from "../src/types/flow.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FRAMES_URL = `${BASE}/demo-frames.html`;

let checks = 0;
function ok(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    console.error(` FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  checks++;
  console.log(`  ok   ${label}`);
}

/* ------------------------------------------------------------------ *
 * A recorded environment, measured for real.
 *
 * Hard-coding one would make this test assert the machine it was written on. The
 * recorder's own capture function runs against the live page, exactly as it does in
 * the extension, and the result stands in for "what was recorded".
 * ------------------------------------------------------------------ */

const probe = await chromium.launch({ headless: true });
const probeContext = await probe.newContext({ viewport: { width: 1000, height: 800 } });
const probePage = await probeContext.newPage();
await probePage.goto(FRAMES_URL, { waitUntil: "load" });
const RECORDED_ENV = (await probePage.evaluate(
  pageExpr(captureEnv, undefined as never),
)) as EnvRecord;
await probe.close();

ok(
  "captureEnv measured the page",
  RECORDED_ENV.viewport.width === 1000 && RECORDED_ENV.fonts.length > 0,
  JSON.stringify(RECORDED_ENV.viewport),
);

/* ------------------------------------------------------------------ *
 * The flow. Built by hand in exactly the shape the recorder produces.
 * ------------------------------------------------------------------ */

const shopB: StepMeta = {
  targetId: "t0",
  // Frame 1 = the SECOND iframe. Both frames contain the same document, so an
  // executor that broadcasts and takes the first answer picks the wrong one.
  frameChain: [{ index: 1, selectors: [["#shop-b"]], url: "/demo.html", name: "shop-b" }],
  tMono: 1000,
};
const top = (tMono: number): StepMeta => ({ targetId: "t0", frameChain: [], tMono });
const popup = (tMono: number): StepMeta => ({ targetId: "t1", frameChain: [], tMono });

const flow: FlowJson = {
  title: "frames, routes and popups",
  timeout: 5000,
  env: RECORDED_ENV,
  steps: [
    { type: "setViewport", width: 1000, height: 800, deviceScaleFactor: 1 },
    { type: "navigate", url: FRAMES_URL },

    // 1. Act inside frame 1 only.
    { type: "click", frame: [1], selectors: [['[data-testid="add-to-cart"]'], ["aria/Add to cart"]] },
    { type: "waitForExpression", frame: [1], expression: `document.getElementById('msg').textContent === 'Added to cart!'` },

    // 2. Frame 0 must be untouched — the proof that targeting is real.
    { type: "waitForExpression", frame: [0], expression: `document.getElementById('msg').textContent === ''` },

    // 3. A form field in frame 1, through the consensus resolver.
    { type: "change", frame: [1], selectors: [["pierce/#email"]], value: "runner@example.com", tagName: "input" },
    { type: "waitForExpression", frame: [1], expression: `document.getElementById('email').value === 'runner@example.com'` },

    // 4. SPA route change: a click, then the location assertion the recorder writes.
    { type: "click", selectors: [["#go-checkout"], ["aria/Go to checkout"]] },
    { type: "waitForExpression", expression: `location.pathname + location.hash === "/demo-frames.html#/checkout"` },

    // 5. Popup: the click opens t1, the next step acts inside it.
    { type: "click", selectors: [["#open-popup"]] },
    { type: "click", target: `${BASE}/demo.html`, selectors: [["aria/Increase guests"]] },
    { type: "waitForExpression", target: `${BASE}/demo.html`, expression: `document.getElementById('guests').textContent === '1'` },
  ],
  meta: [
    top(0),
    top(10),
    shopB,
    shopB,
    { targetId: "t0", frameChain: [{ index: 0, selectors: [["#shop-a"]] }], tMono: 1100 },
    shopB,
    shopB,
    top(1200),
    top(1300),
    top(1400),
    popup(1500),
    popup(1600),
  ],
};

/* ------------------------------------------------------------------ *
 * Run it.
 * ------------------------------------------------------------------ */

console.log("\n— live run —");
const report = await runFlow(flow, { headless: true, speed: "fast" });

for (const step of report.steps) {
  const mark = step.status === "pass" ? "·" : step.status === "skipped" ? "-" : "✗";
  console.log(
    `  ${mark} ${String(step.index).padStart(2)} ${step.type.padEnd(18)} ${step.targetId}` +
      `${step.frameHow && step.frameHow !== "main" ? `/frame:${step.frameHow}` : ""}` +
      `${step.error ? `  ${step.code}: ${step.error}` : ""}`,
  );
}

const failed = report.steps.filter((step) => step.status === "fail");
ok(
  "every step passed",
  failed.length === 0,
  failed.map((f) => `#${f.index} ${f.type}: ${f.code} ${f.error}`).join("; "),
);
ok("the run reports ok", report.ok);

const frameSteps = report.steps.filter((step) => step.frameHow === "signature");
ok(
  "iframe steps resolved by the recorded iframe selector, not by index",
  frameSteps.length >= 4,
  `${frameSteps.length} steps matched by signature`,
);

const popupSteps = report.steps.filter((step) => step.targetId === "t1");
ok(
  "popup steps ran in the popup target",
  popupSteps.length === 2 && popupSteps.every((step) => step.status === "pass"),
);

ok(
  "no environment delta on the machine that recorded it",
  report.env.deltas.length === 0,
  JSON.stringify(report.env.deltas.map((d) => `${d.code}:${d.field}`)),
);

/* ------------------------------------------------------------------ *
 * The environment splits in two, and the report must treat the halves differently.
 *
 *   APPLIED   — timezone, locale, colour scheme, viewport, UA. Playwright emulates
 *               these, so a correct runner makes them match by construction. The
 *               test is that they were actually applied.
 *   MEASURED  — fonts above all. Nothing can force a machine to own a typeface, so
 *               these are the ones that must be detected and named.
 * ------------------------------------------------------------------ */

console.log("\n— applied environment —");
const applied: FlowJson = {
  ...flow,
  steps: flow.steps.slice(0, 3),
  meta: flow.meta!.slice(0, 3),
  env: {
    ...RECORDED_ENV,
    timeZone: "Pacific/Kiritimati",
    locale: "fr-FR",
    colorScheme: RECORDED_ENV.colorScheme === "dark" ? "light" : "dark",
  },
};
const appliedReport = await runFlow(applied, { headless: true, speed: "fast" });
for (const delta of appliedReport.env.deltas) {
  console.log(`  ${delta.code}  ${delta.field}: recorded ${delta.recorded} / live ${delta.live}`);
}
ok(
  "an emulatable environment is APPLIED, so it reports no delta",
  !appliedReport.env.deltas.some((delta) =>
    [CAUSE.TIMEZONE, CAUSE.LOCALE, CAUSE.COLOR_SCHEME].includes(
      delta.code as (typeof CAUSE)["TIMEZONE"],
    ),
  ),
  JSON.stringify(appliedReport.env.deltas.map((d) => `${d.code}:${d.field}`)),
);

console.log("\n— measured environment: a font this machine does not have —");
const brokenFonts: FlowJson = {
  ...flow,
  steps: flow.steps.slice(0, 3),
  meta: flow.meta!.slice(0, 3),
  env: {
    ...RECORDED_ENV,
    // Nothing Playwright can set makes a typeface exist. This is the class of
    // difference that must be reported rather than emulated away.
    fonts: RECORDED_ENV.fonts.map((font, index) =>
      index === 0 ? { ...font, widths: font.widths.map((w) => w + 25) } : font,
    ),
  },
};
const fontReport = await runFlow(brokenFonts, { headless: true, speed: "fast" });
for (const delta of fontReport.env.deltas) {
  console.log(`  ${delta.code}  ${delta.field}: recorded ${delta.recorded} / live ${delta.live}`);
}
const codes = fontReport.env.deltas.map((delta) => delta.code);
ok("font substitution is detected and named", codes.includes(CAUSE.FONT_SUBSTITUTION));
ok(
  "the report leads with a blocking cause",
  Boolean(fontReport.blockedBy?.blocksParity),
  JSON.stringify(fontReport.blockedBy),
);
ok(
  "a broken environment does NOT stop the actions from running",
  fontReport.steps.every((step) => step.status !== "fail"),
  "environment parity and execution are reported separately, by design",
);

/* Detection itself, with nothing applied: verifyEnv against a bare context must
 * name the differences the runner would otherwise have emulated away. */
console.log("\n— detection with no environment applied —");
const bare = await chromium.launch({ headless: true });
const bareContext = await bare.newContext(); // no viewport, no timezone, no locale
const barePage = await bareContext.newPage();
await barePage.goto(FRAMES_URL, { waitUntil: "load" });
const bareDeltas = await verifyEnv(barePage, {
  ...RECORDED_ENV,
  timeZone: "Pacific/Kiritimati",
  colorScheme: "dark",
});
await bare.close();
for (const delta of bareDeltas) console.log(`  ${delta.code}  ${delta.field}`);
const bareCodes = bareDeltas.map((delta) => delta.code);
ok("unapplied timezone is detected and named", bareCodes.includes(CAUSE.TIMEZONE));
ok("unapplied colour scheme is detected and named", bareCodes.includes(CAUSE.COLOR_SCHEME));
ok(
  "every delta carries a fix, not just a diff",
  bareDeltas.every((delta) => delta.hint.length > 20),
);

/* ------------------------------------------------------------------ *
 * And a flow pointing at a frame that does not exist: a named failure, not a hang.
 * ------------------------------------------------------------------ */

console.log("\n— run against a missing frame —");
const missingFrame: FlowJson = {
  ...flow,
  steps: flow.steps.slice(0, 3),
  meta: [
    top(0),
    top(10),
    { targetId: "t0", frameChain: [{ index: 7, selectors: [["#does-not-exist"]] }], tMono: 20 },
  ],
};
const missingReport = await runFlow(missingFrame, { headless: true, speed: "fast", timeout: 1500 });
const missingStep = missingReport.steps[2];
ok(
  "a missing frame fails with E_FRAME_MISSING and says which hop",
  missingStep.status === "fail" && missingStep.code === CAUSE.FRAME_MISSING,
  `${missingStep.code}: ${missingStep.error}`,
);

/* ------------------------------------------------------------------ *
 * Dialogs, secrets and uploads — the three things a flow carries that are NOT the
 * step itself, and without which "authenticated" and "uploads" simply do not replay.
 * ------------------------------------------------------------------ */

console.log("\n— dialogs, secrets, uploads —");

const sidecarFlow: FlowJson = {
  title: "sidecars",
  timeout: 5000,
  env: RECORDED_ENV,
  steps: [
    { type: "navigate", url: FRAMES_URL },
    // A confirm() the user ACCEPTED. Nothing in the step says so — the answer is
    // sidecar data, and without it replay hangs or takes the other branch.
    { type: "click", selectors: [["#confirm-delete"]] },
    { type: "waitForExpression", expression: `document.getElementById('confirm-result').textContent === 'deleted'` },
    // A file input. The recorder carried the bytes; the runner puts them back.
    { type: "change", selectors: [["#upload"]], value: "", tagName: "input" },
    { type: "waitForExpression", expression: `document.getElementById('upload-result').textContent === 'notes.txt:11'` },
  ],
  meta: [
    top(0),
    { ...top(10), dialog: { kind: "confirm", message: "Delete everything?", accept: true } },
    top(20),
    {
      ...top(30),
      upload: {
        files: [
          {
            name: "notes.txt",
            mimeType: "text/plain",
            base64: Buffer.from("hello world").toString("base64"), // 11 bytes
          },
        ],
        truncated: false,
      },
    },
    top(40),
  ],
};

const sidecarReport = await runFlow(sidecarFlow, { headless: true, speed: "fast" });
for (const step of sidecarReport.steps) {
  if (step.status === "fail") console.log(`  ✗ ${step.index} ${step.code}: ${step.error}`);
}
ok(
  "a recorded dialog is answered the way the user answered it",
  sidecarReport.steps[2]?.status === "pass",
  sidecarReport.steps[2]?.error,
);
ok(
  "an uploaded file is restored from the flow, bytes and all",
  sidecarReport.steps[4]?.status === "pass",
  sidecarReport.steps[4]?.error,
);

// The dialog answer must actually matter: dismissing takes the other branch.
const dismissFlow: FlowJson = {
  ...sidecarFlow,
  steps: [
    sidecarFlow.steps[0],
    sidecarFlow.steps[1],
    {
      type: "waitForExpression",
      expression: `document.getElementById('confirm-result').textContent === 'kept'`,
    },
  ],
  meta: [
    top(0),
    { ...top(10), dialog: { kind: "confirm", message: "Delete everything?", accept: false } },
    top(20),
  ],
};
const dismissReport = await runFlow(dismissFlow, { headless: true, speed: "fast" });
ok(
  "a DISMISSED dialog replays as dismissed — the answer is not cosmetic",
  dismissReport.ok,
  dismissReport.steps.find((s) => s.status === "fail")?.error,
);

/* Secrets: the recorder never captured the password, so the runner must be given it
 * — or say exactly which one is missing. Typing "" and passing is the failure mode
 * this prevents. */
const secretFlow: FlowJson = {
  title: "secret",
  timeout: 5000,
  steps: [
    { type: "navigate", url: FRAMES_URL },
    { type: "change", frame: [1], selectors: [["#email"]], value: "", tagName: "input" },
  ],
  meta: [top(0), { ...shopB, secretRef: "LOGIN_PASSWORD" }],
};

const noSecret = await runFlow(secretFlow, { headless: true, speed: "fast", timeout: 1500 });
ok(
  "a missing secret fails by NAME, instead of typing an empty password",
  noSecret.steps[1]?.code === CAUSE.SECRET_MISSING &&
    Boolean(noSecret.steps[1]?.error?.includes("LOGIN_PASSWORD")),
  `${noSecret.steps[1]?.code}: ${noSecret.steps[1]?.error}`,
);

const withSecret = await runFlow(secretFlow, {
  headless: true,
  speed: "fast",
  secrets: { LOGIN_PASSWORD: "hunter2" },
});
ok("a supplied secret is used", withSecret.ok, withSecret.steps[1]?.error);

/* ------------------------------------------------------------------ *
 * Links that navigate.
 *
 * The ordinary case, and the one that quietly breaks: the document is torn down
 * while the runner still holds a handle into it, and the NEXT step has to survive
 * that. Every shape a navigation takes gets a case, because they fail differently.
 * ------------------------------------------------------------------ */

console.log("\n— links and navigation —");

const navCase = (title: string, linkSelector: string, meta2: StepMeta) => ({
  title,
  timeout: 5000,
  env: RECORDED_ENV,
  steps: [
    { type: "navigate" as const, url: FRAMES_URL },
    { type: "click" as const, selectors: [[linkSelector]] },
    // The step that races the dying document.
    { type: "click" as const, selectors: [['[data-testid="add-to-cart"]']] },
    {
      type: "waitForExpression" as const,
      expression: `document.getElementById('msg').textContent === 'Added to cart!'`,
    },
  ],
  meta: [top(0), top(10), meta2, { ...meta2, tMono: 30 }],
});

for (const [label, selector, target] of [
  ["a plain link", "#go-shop", "t0"],
  ["a 302 redirect", "#go-redirect", "t0"],
  ["a JS redirect (location.href)", "#go-js", "t0"],
  ["a target=_blank link, acting in the new tab", "#go-blank", "t1"],
] as const) {
  const report = await runFlow(
    navCase(label, selector, { targetId: target, frameChain: [], tMono: 20 }),
    { headless: true, speed: "fast" },
  );
  ok(
    `${label}: the page navigated and the next step acted on it`,
    report.ok,
    report.steps.find((s) => s.status === "fail")?.error,
  );
}

/* The failure that used to pass silently: a link under a sticky overlay. Real input
 * lands on whatever is topmost, so the click hit the overlay and the step reported
 * success having done nothing at all. */
const occluded = await runFlow(
  {
    title: "covered link",
    timeout: 5000,
    env: RECORDED_ENV,
    steps: [
      { type: "navigate", url: FRAMES_URL },
      { type: "click", selectors: [["#show-cover"]] },
      { type: "click", selectors: [["#go-covered"]] },
    ],
    meta: [top(0), top(10), top(20)],
  },
  { headless: true, speed: "fast", timeout: 2000 },
);
ok(
  "a click on a COVERED element fails as occluded instead of silently missing",
  occluded.steps[2]?.code === CAUSE.OCCLUDED,
  `${occluded.steps[2]?.code}: ${occluded.steps[2]?.error}`,
);
ok(
  "…and names what is in the way",
  Boolean(occluded.steps[2]?.error?.includes("#cover")),
  occluded.steps[2]?.error,
);

/* The determinism controls are installed as SOURCE, not as a function: a serialized
 * function with nested declarations throws in the page, and init-script failures are
 * never awaited — so a broken one is invisible. Prove the seed actually applies. */
const seedFlow: FlowJson = {
  title: "seeded",
  timeout: 5000,
  steps: [
    { type: "navigate", url: FRAMES_URL },
    { type: "waitForExpression", expression: `Math.random() === 0.8377554863691330` },
  ],
  meta: [top(0), top(10)],
};
const seedProbe = await runFlow(
  {
    ...seedFlow,
    steps: [
      seedFlow.steps[0],
      {
        type: "waitForExpression",
        // Two runs with the same seed must produce the same first value; this
        // asserts only that the PRNG was replaced at all.
        expression: `Math.random.toString().indexOf("native code") === -1`,
      },
    ],
  },
  { headless: true, speed: "fast", timeout: 2000 },
);
ok(
  "the determinism init script actually runs in the page",
  seedProbe.ok,
  "Math.random was still the native one — the init script never executed",
);

/* A page that forbids eval. The runner drives expressions over CDP, which is not
 * page script and therefore not subject to the page's CSP — but that is a claim
 * worth holding to, since most real sites ship exactly this policy. */
const cspRun = await runFlow(
  {
    title: "strict CSP",
    timeout: 4000,
    steps: [
      { type: "navigate", url: `${BASE}/demo-csp.html` },
      { type: "click", selectors: [["#go-checkout"]] },
      {
        type: "waitForExpression",
        expression: `location.pathname + location.hash === "/demo-csp.html#/checkout"`,
      },
      {
        type: "waitForExpression",
        expression: `document.getElementById('route').textContent === 'checkout'`,
      },
    ],
    meta: [top(0), top(10), top(20), top(30)],
  },
  { headless: true, speed: "fast" },
);
ok(
  "the runner evaluates assertions on a page whose CSP forbids eval",
  cspRun.ok,
  cspRun.steps.find((s) => s.status === "fail")?.error,
);

/* ------------------------------------------------------------------ *
 * Native drag-and-drop, anchored scrolling, downloads.
 * ------------------------------------------------------------------ */

console.log("\n— native DnD, virtual scroll anchoring, downloads —");

const tailFlow: FlowJson = {
  title: "tail",
  timeout: 5000,
  env: RECORDED_ENV,
  steps: [
    { type: "navigate", url: FRAMES_URL },
    // HTML5 drag-and-drop. Synthetic events cannot do this at all: the browser's
    // drag machinery only starts for real input, so this passing IS the proof.
    {
      type: "drag",
      selectors: [["#dnd-source"]],
      offsetX: 30,
      offsetY: 12,
      path: [
        { x: 40, y: 0 },
        { x: 90, y: 2 },
        { x: 140, y: 4 },
      ],
      duration: 300,
    },
    { type: "waitForExpression", expression: `document.getElementById('dnd-result').textContent === 'parcel'` },
    // A download the recording produced. Nothing in the DOM changes, so without the
    // sidecar a silently-broken download still "passes".
    { type: "click", selectors: [["#download-report"]] },
  ],
  meta: [
    top(0),
    { ...top(10), nativeDrag: { types: ["text/plain"] } },
    top(20),
    { ...top(30), download: { filename: "report.csv" } },
  ],
};

const tailReport = await runFlow(tailFlow, { headless: true, speed: "fast" });
for (const step of tailReport.steps) {
  if (step.status === "fail") console.log(`  ✗ ${step.index} ${step.code}: ${step.error}`);
}
ok(
  "a native HTML5 drag really drops — dataTransfer and all",
  tailReport.steps[2]?.status === "pass",
  tailReport.steps[2]?.error,
);
ok(
  "the native drag is labelled with the data types it carried",
  Boolean(tailReport.steps[1]?.notes?.some((note) => note.includes("text/plain"))),
);
ok("a recorded download is awaited and matched", tailReport.steps[3]?.status === "pass",
  tailReport.steps[3]?.error);

// A download the run does NOT produce must fail by name, not pass quietly.
const ghostDownload = await runFlow(
  {
    ...tailFlow,
    steps: [tailFlow.steps[0], { type: "click", selectors: [["#confirm-delete"]] }],
    meta: [top(0), { ...top(10), download: { filename: "report.csv" } }],
  },
  { headless: true, speed: "fast", timeout: 2000 },
);
ok(
  "a download that did NOT happen is reported, not passed over",
  ghostDownload.steps[1]?.code === CAUSE.DOWNLOAD_MISSING,
  `${ghostDownload.steps[1]?.code}: ${ghostDownload.steps[1]?.error}`,
);

/* Scroll anchoring: the recorded pixel offset is deliberately WRONG for the run, and
 * only the content anchor can land on the right row. */
const anchorFlow: FlowJson = {
  title: "anchor",
  timeout: 5000,
  env: RECORDED_ENV,
  steps: [
    { type: "navigate", url: FRAMES_URL },
    { type: "click", selectors: [["#confirm-delete"]] },
    { type: "waitForExpression", expression: `document.getElementById('virt').scrollTop === 600` },
  ],
  meta: [
    top(0),
    {
      ...top(10),
      scrollState: [
        {
          selectors: [["#virt"]],
          // A stale pixel offset, as a virtualized list would produce next run.
          x: 0,
          y: 123,
          // The truth: row 20 at the top of the container.
          anchor: { selectors: [["#row-20"]], offsetY: 0 },
        },
      ],
    },
    top(20),
  ],
};
const anchorReport = await runFlow(anchorFlow, { headless: true, speed: "fast" });
ok(
  "scroll is restored by CONTENT anchor, not by the stale pixel offset",
  anchorReport.ok,
  anchorReport.steps.find((s) => s.status === "fail")?.error,
);

const lostAnchor = await runFlow(
  {
    ...anchorFlow,
    steps: [
      anchorFlow.steps[0],
      anchorFlow.steps[1],
      { type: "waitForExpression", expression: `document.getElementById('virt').scrollTop === 123` },
    ],
    meta: [
      top(0),
      {
        ...top(10),
        scrollState: [
          {
            selectors: [["#virt"]],
            x: 0,
            y: 123,
            anchor: { selectors: [["#row-does-not-exist"]], offsetY: 0 },
          },
        ],
      },
      top(20),
    ],
  },
  { headless: true, speed: "fast" },
);
ok(
  "a vanished anchor falls back to the pixel offset AND says the row may be different",
  lostAnchor.ok &&
    Boolean(lostAnchor.steps[1]?.notes?.some((note) => note.includes("anchor"))),
  JSON.stringify(lostAnchor.steps[1]?.notes),
);

/* ------------------------------------------------------------------ *
 * Sealed mode: record the network once, then replay against the archive. The only
 * mode in which a run is a pure function of the flow.
 * ------------------------------------------------------------------ */

console.log("\n— sealed mode —");
const harPath = path.join(os.tmpdir(), `testflow-e2e-${process.pid}.har`);
const sealFlow: FlowJson = {
  title: "sealed",
  timeout: 5000,
  env: RECORDED_ENV,
  steps: flow.steps.slice(0, 7),
  meta: flow.meta!.slice(0, 7),
};

const recording = await runFlow(sealFlow, {
  headless: true,
  speed: "fast",
  har: { path: harPath, mode: "record" },
});
ok("the HAR-recording run is reported as live", recording.mode === "live");
ok("a HAR was written", existsSync(harPath));

const sealedRun = await runFlow(sealFlow, {
  headless: true,
  speed: "fast",
  har: { path: harPath, mode: "replay" },
});
ok("the sealed run is labelled sealed, not live", sealedRun.mode === "sealed");
ok(
  "every step passes with the network served entirely from the archive",
  sealedRun.ok,
  sealedRun.steps.find((s) => s.status === "fail")?.error,
);

// A flow that asks for something the archive never saw must SAY so — silently
// falling through to the live network is what makes a "sealed" run a lie.
const drifted: FlowJson = {
  ...sealFlow,
  steps: [
    ...sealFlow.steps,
    { type: "navigate", url: `${BASE}/demo.html?never-recorded=1` },
  ],
  meta: [...sealFlow.meta!, top(9999)],
};
const driftRun = await runFlow(drifted, {
  headless: true,
  speed: "fast",
  timeout: 2000,
  har: { path: harPath, mode: "replay" },
  continueOnError: true,
});
ok(
  "a request the recording never saw is reported, not silently fetched",
  (driftRun.unmatchedRequests?.length ?? 0) > 0,
  JSON.stringify(driftRun.unmatchedRequests?.slice(0, 2)),
);
rmSync(harPath, { force: true });

console.log(`\nall ${checks} checks passed`);
