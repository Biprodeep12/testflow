/**
 * E2E for the replay half: the dashboard page asks the EXTENSION to open a replay
 * tab (openForReplay), then drives it step by step over the bridge — the same
 * protocol the flow page's player uses — and asserts the demo page actually
 * changed (handlers ran, values committed).
 *
 * Run:  npm run e2e:replay   (dev server must be up on :3000)
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const hub = context.pages()[0] ?? (await context.newPage());
  await hub.goto(BASE, { waitUntil: "domcontentloaded" });
  // Wait for the bridge (Start button enables when it announces).
  await hub.getByRole("button", { name: "Start Session" }).isEnabled();

  // Arm a ready-listener, then ask the extension to open the replay tab.
  // (String sources dodge tsx's __name helper injection into serialized closures.)
  const readyArmed = hub.evaluate(`new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    window.addEventListener("message", function h(e) {
      const d = e.data;
      if (d && d.source === "tf-agent" && d.kind === "ready") {
        clearTimeout(timer); window.removeEventListener("message", h); resolve(true);
      }
    });
  })`) as Promise<boolean>;

  const [demo] = await Promise.all([
    context.waitForEvent("page"),
    hub.evaluate(
      `window.postMessage({ source: "tf-hub", kind: "openForReplay", url: ${JSON.stringify(
        `${BASE}/demo.html`,
      )} }, location.origin)`,
    ),
  ]);
  ok("extension opened the replay tab and reported ready", await readyArmed);
  await demo.waitForSelector("#__tf_badge");

  const run = (step: unknown): Promise<{ ok: boolean; error?: string }> => {
    const id = Math.floor(Math.random() * 1e9);
    return hub.evaluate(`new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 12000);
      window.addEventListener("message", function h(e) {
        const d = e.data;
        if (d && d.source === "tf-agent" && d.kind === "stepResult" && d.id === ${id}) {
          clearTimeout(timer); window.removeEventListener("message", h);
          resolve({ ok: d.ok, error: d.error });
        }
      });
      window.postMessage({ source: "tf-hub", kind: "runStep", id: ${id}, step: ${JSON.stringify(
        step,
      )} }, location.origin);
    })`) as Promise<{ ok: boolean; error?: string }>;
  };

  // 1. Click via aria/ with a broken first candidate — proves group fallback.
  let result = await run({
    type: "click",
    target: "main",
    selectors: [["#does-not-exist"], ["aria/Add to cart"]],
  });
  ok(`click resolves via fallback group (${result.error ?? "ok"})`, result.ok);
  ok(
    "click actually ran the page's handler",
    await demo.locator("#msg").innerText().then((t) => t.includes("Added to cart")),
  );

  // 2. aria-label'd icon button.
  result = await run({
    type: "click",
    target: "main",
    selectors: [["aria/Increase guests"]],
  });
  ok("aria-label button click", result.ok);
  ok("icon button handler ran", (await demo.locator("#guests").innerText()) === "1");

  // 3. change via pierce/ with the React-safe value setter.
  result = await run({
    type: "change",
    target: "main",
    value: "replay@example.com",
    selectors: [["pierce/#email"]],
  });
  ok("change step executes", result.ok);
  ok(
    "value committed to the field",
    (await demo.locator("#email").inputValue()) === "replay@example.com",
  );

  // 4. xpath/ resolution.
  result = await run({
    type: "click",
    target: "main",
    selectors: [['xpath///*[@id="cta"]']],
  });
  ok("xpath/ selector resolves", result.ok);

  // 5. CONSENSUS: the FIRST candidate resolves fine — but to the WRONG element
  // (the Increase-guests button). First-match-wins would click it and bump the
  // counter. aria+text agree on the real Add-to-cart button and outvote it.
  result = await run({
    type: "click",
    target: "main",
    selectors: [
      ['button[aria-label="Increase guests"]'], // stale-path stand-in: valid, wrong
      ["aria/Add to cart"],
      ["text/Add to cart"],
    ],
  });
  ok("consensus click executes", result.ok);
  ok(
    "majority outvotes the wrong-but-resolving first selector",
    (await demo.locator("#guests").innerText()) === "1", // NOT bumped to 2
  );

  // 6. Scroll replay is container-targeted — the recorded target IS the "where the
  // cursor was" information, so no cursor simulation is needed.
  result = await run({
    type: "scroll",
    target: "main",
    selectors: [['[data-testid="feed"]']],
    x: 0,
    y: 80,
  });
  ok("container scroll step executes", result.ok);
  ok(
    "the FEED scrolled, not the page",
    (await demo.evaluate(
      "document.getElementById('feed').scrollTop + ':' + Math.round(window.scrollY)",
    )) === "80:0",
  );

  result = await run({ type: "scroll", target: "main", x: 0, y: 300 });
  ok("document scroll step executes", result.ok);
  ok(
    "the PAGE scrolled this time",
    (await demo.evaluate("Math.round(window.scrollY)")) === 300,
  );

  // 7. Consumed-wheel replay: the map's wheel handler must actually run. 240 total
  // delta -> two ±120 chunks -> zoom increments twice.
  result = await run({
    type: "wheel",
    target: "main",
    selectors: [['[data-testid="map"]']],
    deltaX: 0,
    deltaY: 240,
    offsetX: 40,
    offsetY: 40,
  });
  ok("wheel step executes", result.ok);
  ok(
    "the map zoomed (its wheel handler ran twice)",
    (await demo.locator("#zoom").innerText()) === "2",
  );

  // 8. Drag replay: retrace the path on the map — its pan handler must see the
  // full displacement.
  result = await run({
    type: "drag",
    target: "main",
    selectors: [['[data-testid="map"]']],
    offsetX: 20,
    offsetY: 20,
    path: [
      { x: 30, y: 10 },
      { x: 60, y: 20 },
    ],
    duration: 200,
  });
  ok("drag step executes", result.ok);
  ok(
    "the map panned by the recorded displacement",
    (await demo.locator("#pan").innerText()) === "60,20",
  );

  // Direction coverage: an up-left drag (negative signed path) must pan back.
  result = await run({
    type: "drag",
    target: "main",
    selectors: [['[data-testid="map"]']],
    offsetX: 70,
    offsetY: 60,
    path: [
      { x: -20, y: -5 },
      { x: -40, y: -15 },
    ],
    duration: 200,
  });
  ok("negative-direction drag executes", result.ok);
  ok(
    "the map panned up-left by exactly the negative displacement",
    (await demo.locator("#pan").innerText()) === "20,5", // 60-40, 20-15
  );

  // 9. Keyboard hold replay: the app shortcut requires Ctrl to be HELD when b
  // goes down — proves the replayer's held-key state, not just key dispatch.
  for (const step of [
    { type: "keyDown", key: "Control" },
    { type: "keyDown", key: "b" },
    { type: "keyUp", key: "b" },
    { type: "keyUp", key: "Control" },
  ]) {
    result = await run({ target: "main", ...step });
    if (!result.ok) break;
  }
  ok("keyboard hold sequence executes", result.ok);
  ok(
    "the Ctrl+B shortcut handler actually fired",
    (await demo.locator("#shortcut").innerText()) === "1",
  );

  // 10. No match must fail cleanly, not hang.
  result = await run({
    type: "click",
    target: "main",
    selectors: [["#nope"], ["aria/No Such Button"]],
  });
  ok("unresolvable selector fails with an error", !result.ok && Boolean(result.error));

  console.log(`\nall ${checks} checks passed`);
} finally {
  await context.close();
}
