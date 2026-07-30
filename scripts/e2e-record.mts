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
import type { FlowStep } from "../src/types/flow";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "extension",
  "dist",
);

let checks = 0;
function ok(label: string, condition: boolean): void {
  if (!condition) {
    console.error(` FAIL  ${label}`);
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
    "downloaded JSON carries no TestFlow-internal fields (timestamp/tagName)",
    !flow.steps.some(
      (s: Record<string, unknown>) => "timestamp" in s || "tagName" in s,
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
      has("waitForLoadState('networkidle'") &&
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

  console.log(`\nall ${checks} checks passed`);
} finally {
  await context.close();
}
