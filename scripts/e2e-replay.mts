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
function ok(label: string, condition: boolean, detail?: string): void {
  if (!condition) {
    console.error(` FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
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

  const run = (
    step: unknown,
    meta?: unknown,
  ): Promise<{ ok: boolean; error?: string; note?: string }> => {
    const id = Math.floor(Math.random() * 1e9);
    return hub.evaluate(`new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 12000);
      window.addEventListener("message", function h(e) {
        const d = e.data;
        if (d && d.source === "tf-agent" && d.kind === "stepResult" && d.id === ${id}) {
          clearTimeout(timer); window.removeEventListener("message", h);
          resolve({ ok: d.ok, error: d.error, note: d.note });
        }
      });
      window.postMessage({ source: "tf-hub", kind: "runStep", id: ${id}, step: ${JSON.stringify(
        step,
      )}, meta: ${JSON.stringify(meta ?? null)} || undefined }, location.origin);
    })`) as Promise<{ ok: boolean; error?: string }>;
  };

  // 1. Click via aria/ with a broken first candidate — proves group fallback.
  let result = await run({
    type: "click",
    target: "main",
    selectors: [["#does-not-exist"], ["aria/Add to cart"]],
  });
  ok(`click resolves via fallback group (${result.error ?? "ok"})`, result.ok);
  // THE point of driving Chrome's Input domain instead of dispatchEvent(): the page
  // receives a real event. dispatchEvent() can never set isTrusted, so an app that
  // gates on it — or on :focus-visible, or native scrolling — behaves differently
  // under a synthetic replay than it did for the user.
  ok(
    "the click was REAL input, not a synthetic event (isTrusted)",
    (await demo.locator("#trusted").innerText()) === "true",
  );
  ok(
    "real input was available, so no synthetic-fallback note was raised",
    result.note === undefined,
    result.note,
  );
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
  // A password the recorder deliberately did not capture. Typing "" here and
  // reporting success would log in as nobody and call it a pass — the exact failure
  // the secret reference exists to prevent. The browser has nowhere safe to keep
  // one, so the only honest answer is to refuse and say where it CAN run.
  const secretStep = await run(
    { type: "change", value: "", selectors: [["#email"]], tagName: "input" },
    { targetId: "t0", frameChain: [], tMono: 0, secretRef: "LOGIN_PASSWORD" },
  );
  ok("a step needing a secret FAILS in the browser rather than typing nothing", !secretStep.ok);
  ok(
    "…and says which secret, and where it can be supplied",
    Boolean(
      secretStep.error?.includes("LOGIN_PASSWORD") && secretStep.error?.includes("--secret"),
    ),
    secretStep.error,
  );
  ok(
    "…and the field was left untouched",
    (await demo.locator("#email").inputValue()) === "replay@example.com",
  );

  ok("unresolvable selector fails with an error", !result.ok && Boolean(result.error));

  /* ---------------------------------------------------------------- *
   * The arithmetic real input depends on.
   *
   * CDP delivers input in TOP-FRAME coordinates, but an element inside an iframe
   * only knows its position within its own document. Get that conversion wrong and
   * every click in a frame lands somewhere else — silently, because the click still
   * "succeeds", just on the wrong element.
   *
   * Chrome's debugger cannot attach here (Playwright already holds this tab), so
   * the dispatch itself is out of reach — but the conversion is exactly what can go
   * wrong, and Playwright's own boundingBox() is an independent measurement of the
   * right answer.
   * ---------------------------------------------------------------- */

  const [framesTab] = await Promise.all([
    context.waitForEvent("page"),
    hub.evaluate(
      `window.postMessage({ source: "tf-hub", kind: "openForReplay", url: ${JSON.stringify(
        `${BASE}/demo-frames.html`,
      )} }, location.origin)`,
    ),
  ]);
  await framesTab.waitForLoadState("load");
  await framesTab.waitForSelector("#__tf_badge");

  const shopB = framesTab.frame({ name: "shop-b" });
  ok("the framed replay page loaded both shops", Boolean(shopB));

  // What the frame's own protocol says its offset is.
  const reported = (await shopB!.evaluate(`new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    window.addEventListener("message", function h(e) {
      const d = e.data;
      if (d && d.__tf === "youareat" && d.id === 4242) {
        clearTimeout(timer); window.removeEventListener("message", h);
        resolve({ x: d.x, y: d.y });
      }
    });
    parent.postMessage({ __tf: "whereami", id: 4242 }, "*");
  })`)) as { x: number; y: number } | null;
  ok("the frame negotiated its viewport offset with its parent", Boolean(reported));

  // What it actually is: Playwright's boundingBox is top-frame relative, so the
  // difference from the in-frame rect IS the offset.
  const topBox = (await framesTab
    .frameLocator("#shop-b")
    .locator("#cta")
    .boundingBox())!;
  const inFrame = JSON.parse(
    (await shopB!.evaluate(
      `JSON.stringify(document.querySelector("#cta").getBoundingClientRect().toJSON())`,
    )) as string,
  ) as { x: number; y: number };

  const expected = { x: topBox.x - inFrame.x, y: topBox.y - inFrame.y };
  ok(
    `frame offset matches Playwright's own measurement ` +
      `(reported ${reported?.x},${reported?.y} vs ${Math.round(expected.x)},${Math.round(expected.y)})`,
    Math.abs((reported?.x ?? -999) - expected.x) <= 1 &&
      Math.abs((reported?.y ?? -999) - expected.y) <= 1,
  );

  /* ---------------------------------------------------------------- *
   * A click that opens a NEW TAB, and the step after it.
   *
   * Same-tab navigation works because nothing has to be re-bound: the tab is
   * already the session's. A popup is a new browser target that has to join the
   * session, be given a logical id, be reachable by the next step, AND be driven by
   * real input like every other tab — four things, none of which the same-tab path
   * exercises.
   * ---------------------------------------------------------------- */

  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    run({ type: "click", selectors: [["#go-blank"]] }),
  ]);
  await popup.waitForLoadState("load");
  ok("the click opened a new tab", popup.url().includes("/demo.html"));

  // The next step belongs to t1 — the tab the click just opened.
  const inPopup = await run(
    { type: "click", selectors: [['[data-testid="add-to-cart"]']] },
    { targetId: "t1", frameChain: [], tMono: 0 },
  );
  ok(
    `a step targeting the NEW tab reaches it (${inPopup.error ?? "ok"})`,
    inPopup.ok,
    inPopup.error,
  );
  ok(
    "…and the new tab's handler actually ran",
    (await popup.locator("#msg").innerText()).includes("Added to cart"),
  );
  ok(
    "…with REAL input, like every other tab",
    (await popup.locator("#trusted").innerText()) === "true",
    inPopup.note,
  );

  // A BUTTON calling window.open(), which the popup blocker refuses outright
  // without a user gesture — the case a synthetic click can never perform.
  const [second] = await Promise.all([
    context.waitForEvent("page"),
    run({ type: "click", selectors: [["#open-popup"]] }, {
      targetId: "t0",
      frameChain: [],
      tMono: 0,
    }),
  ]);
  await second.waitForLoadState("load");
  ok(
    "a button calling window.open() opens a tab (the popup blocker allowed it)",
    second.url().includes("/demo.html"),
  );

  const inSecond = await run(
    { type: "click", selectors: [["aria/Increase guests"]] },
    { targetId: "t2", frameChain: [], tMono: 0 },
  );
  ok(`a step reaches the SECOND popup (${inSecond.error ?? "ok"})`, inSecond.ok, inSecond.error);
  ok(
    "…and it ran there, not in the first popup",
    (await second.locator("#guests").innerText()) === "1" &&
      (await popup.locator("#guests").innerText()) === "0",
  );

  /* ---------------------------------------------------------------- *
   * A page that forbids eval.
   *
   * Almost every real site ships a Content-Security-Policy without `unsafe-eval`,
   * and under one the page cannot evaluate a string as code at all — which is
   * exactly what a recorded SPA route assertion needs. Two answers: the recorder's
   * own assertions are matched structurally (no evaluator), and anything custom
   * goes over the debugger protocol, which is not page script and not subject to
   * the page's CSP.
   * ---------------------------------------------------------------- */

  const [cspTab] = await Promise.all([
    context.waitForEvent("page"),
    hub.evaluate(
      `window.postMessage({ source: "tf-hub", kind: "openForReplay", url: ${JSON.stringify(
        `${BASE}/demo-csp.html`,
      )} }, location.origin)`,
    ),
  ]);
  await cspTab.waitForLoadState("load");
  await cspTab.waitForSelector("#__tf_badge");

  const cspHeader = await cspTab.evaluate(
    `fetch(location.href).then(r => r.headers.get("content-security-policy"))`,
  );
  ok(
    "the fixture really is served with a strict CSP",
    typeof cspHeader === "string" && !cspHeader.includes("unsafe-eval"),
    String(cspHeader),
  );

  ok("a click works under CSP", (await run({ type: "click", selectors: [["#go-checkout"]] })).ok);

  const routeAssert = await run({
    type: "waitForExpression",
    expression: `location.pathname + location.hash === "/demo-csp.html#/checkout"`,
    timeout: 4000,
  });
  ok(
    `a recorded ROUTE assertion resolves on a page that forbids eval (${routeAssert.error ?? "ok"})`,
    routeAssert.ok,
    routeAssert.error,
  );

  const customAssert = await run({
    type: "waitForExpression",
    expression: `document.getElementById('route').textContent === 'checkout'`,
    timeout: 4000,
  });
  ok(
    `a CUSTOM assertion resolves too, via the debugger (${customAssert.error ?? "ok"})`,
    customAssert.ok,
    customAssert.error,
  );

  const falseAssert = await run({
    type: "waitForExpression",
    expression: `document.getElementById('route').textContent === 'never'`,
    timeout: 1200,
  });
  ok(
    "an assertion that is genuinely false still fails — the fix did not make everything pass",
    !falseAssert.ok,
    falseAssert.error,
  );

  /* ---------------------------------------------------------------- *
   * The visible replay cursor.
   *
   * The interesting risk is not whether it appears — it is whether it gets in the
   * way. The replayer hit-tests with elementFromPoint before every click, and a
   * cursor parked on the target would be reported as the topmost element, failing
   * the run as occluded BY ITS OWN CURSOR. `pointer-events: none` is what stops
   * that, and this is the check that it is still there.
   * ---------------------------------------------------------------- */

  const [cursorTab] = await Promise.all([
    context.waitForEvent("page"),
    hub.evaluate(
      `window.postMessage({ source: "tf-hub", kind: "openForReplay", url: ${JSON.stringify(
        `${BASE}/demo.html`,
      )} }, location.origin)`,
    ),
  ]);
  await cursorTab.waitForLoadState("load");
  await cursorTab.waitForSelector("#__tf_badge");

  // Present BEFORE any step runs. It used to be created lazily by the first move,
  // so it was absent for the whole start of a run — "the cursor isn't loading".
  // state "attached", not the default "visible": the cursor container is a 0x0
  // anchor whose children are absolutely positioned, so Playwright would never call
  // it visible no matter what the CSS says.
  await cursorTab.waitForSelector("#__tf_cursor", { state: "attached", timeout: 5000 });
  const startPos = JSON.parse(
    (await cursorTab.evaluate(
      `JSON.stringify(document.getElementById("__tf_cursor").getBoundingClientRect().toJSON())`,
    )) as string,
  ) as { x: number; y: number };
  const startViewport = cursorTab.viewportSize();
  ok(
    `the cursor exists before the first step, on screen (${Math.round(startPos.x)},${Math.round(startPos.y)})`,
    startPos.x > 0 &&
      startPos.y > 0 &&
      (!startViewport || (startPos.x < startViewport.width && startPos.y < startViewport.height)),
    JSON.stringify(startViewport),
  );
  ok(
    "…and it is actually visible, not just in the DOM",
    (await cursorTab
      .locator("#__tf_cursor")
      .evaluate((el) => getComputedStyle(el).visibility)) === "visible",
  );

  const cursorClick = await run({
    type: "click",
    selectors: [['[data-testid="add-to-cart"]']],
  });
  ok(`a click with the cursor enabled still lands (${cursorClick.error ?? "ok"})`, cursorClick.ok);
  ok(
    "the cursor was drawn",
    (await cursorTab.locator("#__tf_cursor").count()) === 1,
  );
  ok(
    "the cursor cannot intercept a click — pointer-events is none",
    (await cursorTab
      .locator("#__tf_cursor")
      .evaluate((el) => getComputedStyle(el).pointerEvents)) === "none",
  );

  // Where it ended up should be the button it just clicked.
  const cursorBox = JSON.parse(
    (await cursorTab.evaluate(
      `JSON.stringify(document.getElementById("__tf_cursor").getBoundingClientRect().toJSON())`,
    )) as string,
  ) as { x: number; y: number };
  const buttonBox = (await cursorTab.locator('[data-testid="add-to-cart"]').boundingBox())!;
  ok(
    `the cursor came to rest on the target (cursor ${Math.round(cursorBox.x)},${Math.round(cursorBox.y)})`,
    cursorBox.x >= buttonBox.x - 2 &&
      cursorBox.x <= buttonBox.x + buttonBox.width + 2 &&
      cursorBox.y >= buttonBox.y - 2 &&
      cursorBox.y <= buttonBox.y + buttonBox.height + 2,
    JSON.stringify(buttonBox),
  );

  // And it must move on, not stay put.
  await run({ type: "click", selectors: [["aria/Increase guests"]] });
  const moved = JSON.parse(
    (await cursorTab.evaluate(
      `JSON.stringify(document.getElementById("__tf_cursor").getBoundingClientRect().toJSON())`,
    )) as string,
  ) as { x: number; y: number };
  ok(
    "the cursor moved to the next target",
    Math.hypot(moved.x - cursorBox.x, moved.y - cursorBox.y) > 5,
  );

  /* A navigation destroys the document and the cursor with it. It has to come back,
   * and come back WHERE IT WAS — reappearing in a corner on every page load is the
   * other half of "the cursor keeps disappearing". */
  const [navTab] = await Promise.all([
    context.waitForEvent("page"),
    hub.evaluate(
      `window.postMessage({ source: "tf-hub", kind: "openForReplay", url: ${JSON.stringify(
        `${BASE}/demo-frames.html`,
      )} }, location.origin)`,
    ),
  ]);
  await navTab.waitForLoadState("load");
  await navTab.waitForSelector("#__tf_cursor", { state: "attached" });

  // Bring the link into view FIRST, so its box is where the click will actually
  // land. Otherwise the step scrolls to it and the cursor legitimately ends up
  // somewhere else than the pre-scroll box — a wrong assertion, not a wrong cursor.
  await run({ type: "scroll", x: 0, y: 560 });
  await navTab.waitForTimeout(150);
  const linkBox = (await navTab.locator("#go-shop").boundingBox())!;
  const navClick = await run({ type: "click", selectors: [["#go-shop"]] });
  ok(`the link click ran (${navClick.error ?? "ok"})`, navClick.ok, navClick.error);
  await navTab.waitForURL(/demo\.html/, { timeout: 8000 });

  await navTab.waitForSelector("#__tf_cursor", { state: "attached", timeout: 5000 });
  ok("the cursor survives a navigation", true);

  const afterNav = JSON.parse(
    (await navTab.evaluate(
      `JSON.stringify(document.getElementById("__tf_cursor").getBoundingClientRect().toJSON())`,
    )) as string,
  ) as { x: number; y: number };
  ok(
    `…and returns where the run left it, not to a corner (${Math.round(afterNav.x)},${Math.round(afterNav.y)})`,
    Math.abs(afterNav.x - (linkBox.x + linkBox.width / 2)) < 60 &&
      Math.abs(afterNav.y - (linkBox.y + linkBox.height / 2)) < 60,
    `link was at ${Math.round(linkBox.x)},${Math.round(linkBox.y)}`,
  );

  // Turning it off must leave no trace in the page.
  const noCursorTab = navTab;
  await run({ type: "click", selectors: [['[data-testid="add-to-cart"]']] }, undefined);
  ok(
    "the cursor is removed when the session ends",
    await (async () => {
      await hub.evaluate(
        `window.postMessage({ source: "tf-hub", kind: "stop" }, location.origin)`,
      );
      await noCursorTab.waitForFunction(
        () => !document.getElementById("__tf_cursor"),
        undefined,
        { timeout: 5000 },
      );
      return true;
    })(),
  );

  console.log(`\nall ${checks} checks passed`);
} finally {
  await context.close();
}
