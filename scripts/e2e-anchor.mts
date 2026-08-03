/**
 * End-to-end proof of anchored selectors and the fragile chip.
 *
 * Records real clicks on public/demo-anchor.html — elements that describe
 * themselves badly, surrounded by varying amounts of durable context — and asserts
 * what the recorder captured for each: the anchored groups it built, and whether it
 * marked the step degraded.
 *
 * This is the DOM half of the selector engine. The string half is unit-tested in
 * src/shared/selectors.test.ts; neither covers the other.
 *
 * Run:  npm run e2e:anchor   (dev server must be up on :3000)
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Collect the live stream the bridge relays, the same way e2e-record does —
  // chrome.storage is not reachable from a page's own world.
  await page.evaluate(`
    window.__tfRows = [];
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.source !== "tf-agent") return;
      if (d.kind === "step") window.__tfRows.push({ step: d.step, meta: d.meta });
    });
  `);

  await page.getByPlaceholder("https://example.com").fill(`${BASE}/demo-anchor.html`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Start Session" }).click(),
  ]);
  await tab.waitForLoadState("domcontentloaded");
  await tab.waitForSelector("#__tf_badge");

  // One click per case, in fixture order. Each target is an anonymous div.
  const targets = [
    '[data-testid="case-a"] > .target',
    '[data-testid="case-b"] > .target',
    '[data-testid="case-c"] > .target',
    '[data-testid="case-d"] > .target',
    '[data-testid="case-e"] > .target:nth-of-type(1)',
    '[data-testid="case-e"] > .target:nth-of-type(2)',
    "section:nth-of-type(6) .target", // F — nothing durable
    "section:nth-of-type(7) .target", // G — named by its child
    "#checkout-panel", // H — stable id
    "section:nth-of-type(9) .target", // I — generated id
  ];
  for (const selector of targets) {
    // Click the padding, not the inner child, so the target itself is the event
    // target rather than its descendant.
    await tab.locator(selector).click({ position: { x: 4, y: 4 } });
  }

  await page.getByRole("button", { name: "Stop recording" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tf-step"]').length > 5,
  );

  const recorded = JSON.parse(
    (await page.evaluate("JSON.stringify(window.__tfRows || [])")) as string,
  ) as { step: FlowStep; meta: StepMeta }[];

  const clicks = recorded.filter((row) => row.step.type === "click");
  ok(`recorded ${targets.length} clicks`, clicks.length === targets.length, `got ${clicks.length}`);

  const flat = (row: { step: FlowStep }): string[] =>
    (row.step.selectors ?? []).map((group) => group[0]).filter(Boolean);

  const [A, B, C, D, E1, E2, F, G, H, I] = clicks;
  const report = (label: string, row: { step: FlowStep; meta: StepMeta }): void => {
    console.log(`\n  ${label}  degraded=${row.meta.degraded ?? "-"}`);
    for (const selector of flat(row)) console.log(`        ${selector}`);
  };
  for (const [label, row] of [
    ["A", A], ["B", B], ["C", C], ["D", D], ["E1", E1],
    ["E2", E2], ["F", F], ["G", G], ["H", H], ["I", I],
  ] as const) {
    report(label, row);
  }
  console.log("");

  /* ---- Anchoring above --------------------------------------------------- */

  for (const [label, row, anchor] of [
    ["A", A, "case-a"],
    ["B", B, "case-b"],
    ["C", C, "case-c"],
    ["D", D, "case-d"],
  ] as const) {
    ok(
      `${label}: anchored to [data-testid="${anchor}"]`,
      flat(row).some((s) => s.startsWith(`[data-testid="${anchor}"]`)),
      flat(row).join(" | "),
    );
    ok(`${label}: not fragile`, row.meta.degraded === undefined, row.meta.degraded);
  }

  ok(
    "C: the leading sibling shifts the index rather than breaking the anchor",
    flat(C).some((s) => /\[data-testid="case-c"\] > div:nth-of-type\(2\)/.test(s)),
    flat(C).join(" | "),
  );

  /* ---- Repeated rows: anchored, and distinct ----------------------------- */

  const e1 = flat(E1).filter((s) => s.startsWith('[data-testid="case-e"]'));
  const e2 = flat(E2).filter((s) => s.startsWith('[data-testid="case-e"]'));
  ok("E: both rows anchored", e1.length > 0 && e2.length > 0);
  ok(
    "E: the two rows got DIFFERENT anchored selectors",
    e1.every((s) => !e2.includes(s)),
    `${e1.join(" | ")}  vs  ${e2.join(" | ")}`,
  );
  ok(
    "E: no :has() group survived (its child selector is not unique)",
    !flat(E1).some((s) => s.includes(":has(")),
    flat(E1).join(" | "),
  );

  /* ---- Naming by a child ------------------------------------------------- */

  ok(
    "G: named by the descendant that has a test hook",
    flat(G).some((s) => s.includes(':has(> [data-testid="icon-trash"])')),
    flat(G).join(" | "),
  );
  ok("G: not fragile", G.meta.degraded === undefined, G.meta.degraded);

  /* ---- The cases that must STILL be fragile ------------------------------ */

  ok(
    "F: nothing durable nearby — still fragile",
    F.meta.degraded === "positional-only",
    `degraded=${F.meta.degraded}, selectors=${flat(F).join(" | ")}`,
  );
  ok(
    "F: built nothing on a css-in-js class name",
    !flat(F).some((s) => s.includes("css-1x2y3z")),
    flat(F).join(" | "),
  );
  ok(
    "I: a generated id does not clear the chip",
    I.meta.degraded === "positional-only",
    `degraded=${I.meta.degraded}, selectors=${flat(I).join(" | ")}`,
  );

  /* ---- The false positive that started this ------------------------------ */

  ok(
    "H: a hand-written id is captured",
    flat(H).some((s) => s === "#checkout-panel"),
    flat(H).join(" | "),
  );
  ok("H: and is no longer called fragile", H.meta.degraded === undefined, H.meta.degraded);

  /* ---- Every anchored selector must actually resolve back ---------------- */

  const wrong = await tab.evaluate((groups: string[][]) => {
    const bad: string[] = [];
    for (const [selector, expected] of groups) {
      try {
        const found = document.querySelector(selector);
        const want = document.querySelectorAll(".target")[Number(expected)];
        if (found !== want) bad.push(selector);
      } catch {
        bad.push(`${selector} (threw)`);
      }
    }
    return bad;
  }, clicks.slice(0, 8).flatMap((row, index) => flat(row).filter((s) => !s.includes("/")).map((s) => [s, String(index)])));
  ok(
    "every captured CSS selector resolves back to the clicked element",
    wrong.length === 0,
    wrong.join(" | "),
  );

  console.log(`\nPASS — ${checks} checks`);
} finally {
  await context.close();
}
