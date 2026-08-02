/**
 * End-to-end proof of the extension recording loop — no Firebase needed.
 *
 * Loads the built extension into Chromium, drives the DASHBOARD like a user:
 * Start Session (the EXTENSION opens the tab), real trusted interactions in that
 * tab, live steps on the dashboard, Stop, Download — then asserts the JSON is
 * exactly DevTools Recorder shape.
 *
 * Run:  npm run e2e   (dev server must be up on :3000; builds the extension first)
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flowToPlaywright } from "../src/codegen/fromFlow";
import type { FlowStep, StepMeta } from "../src/types/flow";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "extension",
  "dist",
);

let checks = 0;
function ok(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    console.error(` FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  checks++;
  console.log(`  ok   ${label}`);
}

// Extensions need a persistent context; channel "chromium" supports them headless.
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await page.getByPlaceholder("https://example.com").fill(`${BASE}/demo.html`);
  // click() auto-waits for enabled — i.e. for the bridge to announce itself.
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Start Session" }).click(),
  ]);
  await tab.waitForLoadState("domcontentloaded");
  await tab.waitForSelector("#__tf_badge"); // recorder armed by the SW

  // Real, trusted interactions inside the recorded tab.
  await tab.getByRole("button", { name: "Add to cart" }).click();
  await tab.getByLabel("Increase guests").click();
  await tab.getByLabel("Email").fill("test@example.com");
  await tab.getByRole("heading", { name: "Demo shop" }).click(); // blur -> change commits
  await tab.locator("#plan").focus();
  await tab.locator("#plan").press("ArrowDown"); // trusted change on the select

  // USER scroll #1 — cursor over the FEED container: the wheel must scroll (and
  // record) the feed, not the page. Cursor position decides the target.
  const feedBox = await tab.locator("#feed").boundingBox();
  await tab.mouse.move(
    feedBox!.x + feedBox!.width / 2,
    feedBox!.y + feedBox!.height / 2,
  );
  await tab.mouse.wheel(0, 200);
  await tab.waitForTimeout(900); // debounce (350ms) + margin

  // USER wheel over the MAP (while it's still in the viewport): the page consumes
  // it (preventDefault -> zoom, no scroll event). Must become a `wheel` step,
  // NOT lost, NOT a scroll.
  const mapBox = await tab.locator("#map").boundingBox();
  await tab.mouse.move(
    mapBox!.x + mapBox!.width / 2,
    mapBox!.y + mapBox!.height / 2,
  );
  await tab.mouse.wheel(0, 240);
  await tab.waitForTimeout(1000); // wheel-burst debounce (400ms) + margin

  // USER drag on the MAP: pan gesture — must become a `drag` step with the path,
  // and must NOT also record a click.
  await tab.mouse.move(mapBox!.x + 30, mapBox!.y + 30);
  await tab.mouse.down();
  await tab.mouse.move(mapBox!.x + 90, mapBox!.y + 50, { steps: 6 });
  await tab.mouse.up();
  await tab.waitForTimeout(400);

  // Second drag the OPPOSITE way (up-left, both deltas negative) — direction
  // coverage: signed paths must survive record -> JSON intact.
  await tab.mouse.move(mapBox!.x + 90, mapBox!.y + 60);
  await tab.mouse.down();
  await tab.mouse.move(mapBox!.x + 30, mapBox!.y + 30, { steps: 6 });
  await tab.mouse.up();
  await tab.waitForTimeout(400);

  // KEYBOARD combo with a HOLD: Ctrl held while b goes down. Must record the
  // full sequence keyDown Control -> keyDown b -> keyUp b -> keyUp Control.
  await tab.keyboard.down("Control");
  await tab.keyboard.press("b");
  await tab.keyboard.up("Control");
  await tab.waitForTimeout(300);

  // USER scroll #2 — cursor over the page body: scrolls the document.
  await tab.mouse.move(20, 20);
  await tab.mouse.wheel(0, 600);
  await tab.waitForTimeout(900);

  // SITE scrolls: programmatic, no user input -> must be IGNORED (both kinds).
  await tab.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById("feed")!.scrollTo(0, 0);
  });
  await tab.waitForTimeout(900);

  // ... + 2 scrolls + 1 wheel + 2 drags + 4 key steps (Ctrl+B sequence).
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tf-step"]').length >= 15,
    undefined,
    { timeout: 8000 },
  );

  const all = (await page.locator('[data-testid="tf-step"]').allInnerTexts()).join("\n");
  ok("recording seeded with setViewport", all.includes("setViewport"));
  ok("recording seeded with navigate", all.includes("navigate"));
  ok("button click recorded with accessible name", all.includes("Add to cart"));
  ok("aria-label'd icon button recorded", all.includes("Increase guests"));
  ok("change step recorded with committed value", all.includes("test@example.com"));
  ok("select change recorded", all.includes("pro"));

  await page.getByRole("button", { name: "Stop recording" }).click();
  // SW broadcasts "stopped" -> save panel appears; badge leaves the recorded tab.
  await page.getByRole("button", { name: "Download JSON" }).waitFor({ timeout: 5000 });
  await tab.waitForFunction(
    () => !document.getElementById("__tf_badge"),
    undefined,
    { timeout: 5000 },
  );
  ok("stop reaches SW, dashboard, and the recorded tab", true);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  const file = await download.path();
  const { readFile } = await import("node:fs/promises");
  const flow = JSON.parse(await readFile(file, "utf8"));

  ok(
    "JSON has title + steps",
    typeof flow.title === "string" && Array.isArray(flow.steps),
  );
  ok("JSON carries the native flow-level timeout (5000)", flow.timeout === 5000);
  const click = flow.steps.find(
    (s: { type: string; selectors?: string[][] }) =>
      s.type === "click" &&
      JSON.stringify(s.selectors).includes("aria/Add to cart"),
  );
  ok("click step carries aria/ selector group", Boolean(click));
  ok(
    "click step carries the data-testid group, ranked first",
    click.selectors[0][0] === '[data-testid="add-to-cart"]',
  );
  ok(
    "click step carries xpath/ + pierce/ groups",
    JSON.stringify(click.selectors).includes("xpath/") &&
      JSON.stringify(click.selectors).includes("pierce/"),
  );
  ok(
    "click step carries offsetX/offsetY",
    typeof click.offsetX === "number" && typeof click.offsetY === "number",
  );
  const nav = flow.steps.find((s: { type: string }) => s.type === "navigate");
  ok(
    "navigate step carries assertedEvents with title",
    nav.assertedEvents?.[0]?.type === "navigation" &&
      typeof nav.assertedEvents[0].title === "string",
  );

  const scrolls = flow.steps.filter(
    (s: { type: string; selectors?: string[][]; y?: number }) =>
      s.type === "scroll",
  );
  ok(
    "exactly TWO scroll steps — the user's, not the programmatic ones",
    scrolls.length === 2,
  );
  const feedScroll = scrolls.find((s: { selectors?: string[][] }) =>
    JSON.stringify(s.selectors ?? []).includes('[data-testid=\\"feed\\"]') ||
    JSON.stringify(s.selectors ?? []).includes('[data-testid="feed"]'),
  );
  const pageScroll = scrolls.find(
    (s: { selectors?: string[][] }) => !s.selectors?.length,
  );
  ok(
    "wheel over the feed recorded THAT container (cursor-routed)",
    Boolean(feedScroll) && feedScroll.y > 0,
  );
  ok(
    "wheel over the body recorded a document scroll",
    Boolean(pageScroll) && pageScroll.y > 0,
  );

  const wheels = flow.steps.filter((s: { type: string }) => s.type === "wheel");
  ok(
    "consumed wheel over the map became ONE wheel step (not a scroll, not lost)",
    wheels.length === 1 &&
      JSON.stringify(wheels[0].selectors).includes("map") &&
      wheels[0].deltaY === 240,
  );

  const drags = flow.steps.filter(
    (s: { type: string; path?: { x: number; y: number }[] }) => s.type === "drag",
  );
  const end = (i: number) => drags[i]?.path?.[drags[i].path.length - 1];
  ok(
    "map pan became a drag step ending at the real displacement",
    drags.length === 2 &&
      JSON.stringify(drags[0].selectors).includes("map") &&
      end(0)?.x === 60 &&
      end(0)?.y === 20,
  );
  ok(
    "up-left drag recorded with NEGATIVE signed path (all directions)",
    end(1)?.x === -60 && end(1)?.y === -30,
  );
  ok(
    "the drag did not ALSO record a click on the map",
    !flow.steps.some(
      (s: { type: string; selectors?: string[][] }) =>
        s.type === "click" && JSON.stringify(s.selectors ?? []).includes('"map"'),
    ),
  );

  const keySeq = flow.steps
    .filter((s: { type: string }) => s.type === "keyDown" || s.type === "keyUp")
    .map((s: { type: string; key?: string }) => `${s.type}:${s.key}`)
    .join(" ");
  ok(
    "Ctrl+B hold recorded as the full down/up sequence, in order",
    keySeq.includes("keyDown:Control keyDown:b keyUp:b keyUp:Control"),
  );

  // ---- Export purity: TestFlow-internal fields must never leak into downloads.
  ok(
    "downloaded JSON carries no TestFlow-internal fields (timestamp/tagName/id)",
    !flow.steps.some(
      (s: Record<string, unknown>) =>
        "timestamp" in s || "tagName" in s || "id" in s,
    ),
  );

  // ---- Parity: everything the live replayer can do must appear in the
  // generated Playwright code for THIS actual recording.
  const code = flowToPlaywright({ title: flow.title, timeout: flow.timeout, steps: flow.steps });
  const has = (needle: string) => code.includes(needle);
  ok(
    "Playwright code covers the full recording (viewport, goto, testid click, fill, wheel, drag, key holds, scrolls, settle waits)",
    has("setViewportSize") &&
      has(".goto(") &&
      has("getByTestId('add-to-cart')") &&
      has(".fill('test@example.com')") &&
      has("mouse.wheel(0, 240)") &&
      has("mouse.down()") &&
      has("mouse.up()") &&
      has("keyboard.down('Control')") &&
      has("keyboard.up('Control')") &&
      has("window.scrollTo") &&
      has("scrollTo(0,") && // container scroll via locator.evaluate
      // 'load', not 'networkidle': Playwright discourages networkidle, and it says
      // nothing about whether fonts and images have actually landed.
      has("waitForLoadState('load'") &&
      has("actionTimeout: 5000"),
  );

  // Saved flows (unlike pure downloads) keep tagName — that's what routes a
  // select's change to selectOption() instead of fill(), which throws on selects.
  const selectCode = flowToPlaywright({
    title: "t",
    steps: [
      {
        type: "change",
        target: "main",
        value: "pro",
        tagName: "select",
        selectors: [["#plan"]],
      } as FlowStep,
    ],
  });
  ok(
    "change on a <select> generates selectOption(), not fill()",
    selectCode.includes(".selectOption('pro')") && !selectCode.includes(".fill("),
  );

  /* ---------------------------------------------------------------- *
   * Phase 2 — the identity a step cannot be replayed without.
   *
   * A recorder that drops WHICH FRAME a click happened in produces a flow that can
   * only be replayed by guessing, so this is recorded end to end: the frame
   * negotiates its position with its parent over postMessage, the service worker
   * turns that into the native DevTools `frame` path, and it survives export.
   *
   * Same for SPA routes: a pushState transition fires no load event, and without
   * the main-world history patch the whole navigation is invisible to the flow.
   * ---------------------------------------------------------------- */

  await page.reload({ waitUntil: "domcontentloaded" });
  // The sidecars never reach a download — that is the point of keeping the DevTools
  // JSON pure — so they are read from the live message stream instead, which is the
  // same data the dashboard saves.
  await page.evaluate(`
    window.__tfMeta = [];
    window.addEventListener("message", function (e) {
      const d = e.data;
      if (!d || d.source !== "tf-agent") return;
      if (d.kind === "snapshot") window.__tfMeta = d.meta || [];
      if (d.kind === "step") window.__tfMeta.push(d.meta);
    });
  `);
  await page.getByPlaceholder("https://example.com").fill(`${BASE}/demo-frames.html`);
  const [framesTab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Start Session" }).click(),
  ]);
  await framesTab.waitForLoadState("load");
  await framesTab.waitForSelector("#__tf_badge");

  // Click inside the SECOND iframe. Both frames hold the same document, so a
  // recorder that does not track frame identity cannot tell these apart later.
  await framesTab
    .frameLocator("#shop-b")
    .getByRole("button", { name: "Add to cart" })
    .click();
  await framesTab.waitForTimeout(300);

  // pushState only — no navigation, no load event.
  await framesTab.getByRole("button", { name: "Go to checkout" }).click();
  await framesTab.waitForTimeout(500);

  // A native confirm(), ACCEPTED. The step alone cannot express which branch the
  // app took — the answer has to be recorded or replay is a coin flip.
  framesTab.once("dialog", (dialog) => void dialog.accept());
  await framesTab.getByRole("button", { name: "Delete" }).click();
  await framesTab.waitForTimeout(400);

  // A file the user chose. Bytes travel with the flow, or the upload cannot replay.
  await framesTab
    .locator("#upload")
    .setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello world"),
    });
  await framesTab.waitForTimeout(400);

  // A native HTML5 drag. Pointer events alone cannot tell this apart from a pan
  // gesture, and the two replay completely differently — so the recorder has to.
  // mouse.move() takes viewport coordinates and does NOT auto-scroll the way
  // click() does, so the element has to be on screen before the box is read.
  await framesTab.locator("#dnd-source").scrollIntoViewIfNeeded();
  await framesTab.waitForTimeout(200);
  const dndSource = (await framesTab.locator("#dnd-source").boundingBox())!;
  const dndTarget = (await framesTab.locator("#dnd-target").boundingBox())!;
  await framesTab.mouse.move(dndSource.x + 20, dndSource.y + 10);
  await framesTab.mouse.down();
  // Several moves, not one: Chrome starts the drag only after the threshold is
  // crossed, and the drop target needs dragover events before the release.
  await framesTab.mouse.move(dndSource.x + 45, dndSource.y + 12, { steps: 5 });
  await framesTab.waitForTimeout(60);
  await framesTab.mouse.move(dndTarget.x + 10, dndTarget.y + 15, { steps: 8 });
  await framesTab.waitForTimeout(60);
  await framesTab.mouse.move(dndTarget.x + 30, dndTarget.y + 15, { steps: 8 });
  await framesTab.waitForTimeout(60);
  await framesTab.mouse.up();
  await framesTab.waitForTimeout(500);

  // Scroll the virtualized list with a real wheel, over the list itself.
  await framesTab.locator("#virt").scrollIntoViewIfNeeded();
  await framesTab.waitForTimeout(200);
  const virt = (await framesTab.locator("#virt").boundingBox())!;
  await framesTab.mouse.move(virt.x + virt.width / 2, virt.y + virt.height / 2);
  await framesTab.mouse.wheel(0, 600);
  await framesTab.waitForTimeout(900); // scroll debounce + margin

  // A download: nothing in the DOM changes, so only the sidecar records that it
  // happened at all.
  const [downloaded] = await Promise.all([
    framesTab.waitForEvent("download"),
    framesTab.getByRole("link", { name: "Download report.csv" }).click(),
  ]);
  await downloaded.path().catch(() => null);
  await framesTab.waitForTimeout(600);

  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tf-step"]').length >= 5,
    undefined,
    { timeout: 8000 },
  );
  await page.getByRole("button", { name: "Stop recording" }).click();
  await page.getByRole("button", { name: "Download JSON" }).waitFor({ timeout: 5000 });

  const [framesDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  const framesFlow = JSON.parse(
    await readFile((await framesDownload.path())!, "utf8"),
  ) as { steps: FlowStep[] };

  const framedClick = framesFlow.steps.find(
    (step) =>
      step.type === "click" &&
      JSON.stringify(step.selectors ?? []).includes("Add to cart"),
  );
  ok("a click inside an iframe was recorded", Boolean(framedClick));
  ok(
    "the iframe click carries the native DevTools frame path [1] — the SECOND frame",
    JSON.stringify(framedClick?.frame) === "[1]",
  );
  ok(
    "top-frame steps carry no frame path (main frame is the absence of one)",
    framesFlow.steps
      .filter((step) => step.type === "navigate" || step.type === "setViewport")
      .every((step) => step.frame === undefined),
  );

  const routeStep = framesFlow.steps.find(
    (step) => step.type === "waitForExpression",
  );
  ok("the SPA route change was recorded at all", Boolean(routeStep));
  ok(
    "the route is recorded as a location assertion on pathname + hash",
    routeStep?.expression ===
      `location.pathname + location.hash === "/demo-frames.html#/checkout"`,
  );
  ok(
    "the route's query string is deliberately excluded (session tokens differ per run)",
    !routeStep?.expression?.includes("location.search"),
  );
  ok(
    "the click that caused the route carries it as an assertedEvent",
    framesFlow.steps.some(
      (step) =>
        step.type === "click" &&
        step.assertedEvents?.some((event) => event.url?.includes("#/checkout")),
    ),
  );

  // ---- The sidecars. Not in the download by design; this is the data the
  // dashboard saves and the runner replays from.
  const metas = JSON.parse(
    (await page.evaluate("JSON.stringify(window.__tfMeta || [])")) as string,
  ) as StepMeta[];

  ok("the sidecar has one entry per step", metas.length === framesFlow.steps.length);
  const framedMeta = metas.find((meta) => meta.frameChain?.length > 0);
  ok(
    "the iframe click's sidecar names the frame by its ELEMENT, not just an index",
    Boolean(
      framedMeta?.frameChain[0].selectors?.some((group) => group[0] === "#shop-b"),
    ),
    JSON.stringify(framedMeta?.frameChain?.[0]?.selectors),
  );
  ok(
    "the frame link also keeps the native index and the frame's name",
    framedMeta?.frameChain[0].index === 1 &&
      framedMeta.frameChain[0].name === "shop-b",
  );
  ok(
    "every step records which logical tab it happened in",
    metas.every((meta) => meta.targetId === "t0"),
  );
  ok(
    "steps carry a monotonic stamp, and it only moves forward",
    metas.every((meta, i) => i === 0 || meta.tMono >= metas[i - 1].tMono),
  );

  const dialogMeta = metas.find((meta) => meta.dialog);
  ok("the confirm() dialog was recorded at all", Boolean(dialogMeta));
  ok(
    "the dialog records the MESSAGE and the answer the user gave",
    dialogMeta?.dialog?.kind === "confirm" &&
      dialogMeta.dialog.message === "Delete everything?" &&
      dialogMeta.dialog.accept === true,
    );
  ok(
    "the dialog is attached to the step that opened it",
    Boolean(
      framesFlow.steps[metas.indexOf(dialogMeta!)]?.selectors?.some((group) =>
        group[0]?.includes("confirm-delete"),
      ),
    ),
  );

  const uploadMeta = metas.find((meta) => meta.upload);
  ok("the chosen file was recorded", Boolean(uploadMeta));
  ok(
    "the file's BYTES travel with the flow, not just its name",
    uploadMeta?.upload?.files[0]?.name === "notes.txt" &&
      Buffer.from(uploadMeta.upload.files[0].base64, "base64").toString() ===
        "hello world",
  );

  // ---- Native drag-and-drop: recorded at all (pointerup never fires — the drag
  // captures the pointer, so `dragend` is the only end-of-gesture signal), and
  // marked as native so replay knows synthetic events cannot perform it.
  ok(
    "the HTML5 drag was dropped on the target",
    (await framesTab.locator("#dnd-result").innerText()) === "parcel",
  );
  const dragStepIndex = framesFlow.steps.findIndex((step) => step.type === "drag");
  ok("the native drag produced a drag step", dragStepIndex >= 0);
  ok(
    "the drag is marked NATIVE, with the data types it carried",
    metas[dragStepIndex]?.nativeDrag?.types.includes("text/plain"),
    JSON.stringify(metas[dragStepIndex]?.nativeDrag),
  );

  // ---- Virtualized scrolling: a pixel offset AND the row it corresponds to.
  const withAnchor = metas
    .flatMap((meta) => meta.scrollState ?? [])
    .find((entry) => entry.selectors?.[0]?.[0] === "#virt");
  ok("the virtual list's scroll offset was captured", Boolean(withAnchor));
  ok(
    "…and anchored to the ROW at the top, not just a pixel count",
    Boolean(
      withAnchor?.anchor?.selectors?.some((group) => group[0]?.startsWith("#row-")),
    ),
    JSON.stringify(withAnchor?.anchor),
  );
  ok(
    "the anchor and the pixel offset agree (row 20 × 30px = 600)",
    withAnchor?.y === 600 &&
      withAnchor.anchor?.offsetY === 0 &&
      withAnchor.anchor.selectors.some((group) => group[0] === "#row-20"),
    JSON.stringify(withAnchor?.anchor),
  );

  // ---- Downloads.
  const downloadMeta = metas.find((meta) => meta.download);
  ok("the download was recorded", Boolean(downloadMeta));
  ok(
    "the download records the filename replay must see again",
    downloadMeta?.download?.filename === "report.csv",
    JSON.stringify(downloadMeta?.download),
  );

  console.log(`\nall ${checks} checks passed`);
} finally {
  await context.close();
}
