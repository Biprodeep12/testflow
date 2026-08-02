/**
 * The whole pipeline, at length.
 *
 * Every other suite records a handful of steps. This one records a long session —
 * the shape that broke before, because cost that grows per step is invisible at ten
 * of them — then saves it, exports it, and replays it. It exists to catch what only
 * shows up at scale: storage layout, sidecar alignment over hundreds of entries, and
 * whether the export a user actually downloads still replays.
 *
 * Run:  npm run e2e:long   (dev server must be up on :3000)
 */

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowJson } from "../src/types/flow.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..", "extension", "dist");
const BUNDLE = path.join(os.tmpdir(), `testflow-long-${process.pid}.tfflow.json`);
/** Above the dashboard's 150-row draw cap, so truncation is genuinely exercised. */
const CLICKS = Number(process.env.CLICKS ?? 200);

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
  acceptDownloads: true,
});

try {
  const hub = context.pages()[0] ?? (await context.newPage());
  await hub.goto(BASE, { waitUntil: "domcontentloaded" });
  await hub.getByPlaceholder("https://example.com").fill(`${BASE}/demo.html`);

  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    hub.getByRole("button", { name: "Start Session" }).click(),
  ]);
  await tab.waitForLoadState("load");
  await tab.waitForSelector("#__tf_badge");

  const began = Date.now();
  for (let i = 0; i < CLICKS; i++) {
    await tab.locator(i % 2 === 0 ? "#cta" : "[aria-label='Increase guests']").click();
  }
  // The badge counts steps page-side; wait for the last one to be recorded.
  await tab.waitForFunction(
    `Number(((document.getElementById("__tf_badge")||{}).textContent||"").replace(/\\D+/g,"")||0) >= ${CLICKS}`,
    undefined,
    { timeout: 60000 },
  );
  const elapsed = Date.now() - began;
  console.log(`  (${CLICKS} interactions recorded in ${elapsed}ms, ${Math.round(elapsed / CLICKS)}ms each)`);
  ok(
    `recording ${CLICKS} steps stays responsive (${Math.round(elapsed / CLICKS)}ms per step)`,
    elapsed / CLICKS < 250,
    `${Math.round(elapsed / CLICKS)}ms per step`,
  );

  ok(
    "the page's own state proves every click landed",
    Number(await tab.locator("#guests").innerText()) === CLICKS / 2,
    `guests=${await tab.locator("#guests").innerText()}`,
  );

  await hub.getByRole("button", { name: "Stop recording" }).click();
  await hub.getByRole("button", { name: "Download bundle" }).waitFor({ timeout: 10000 });

  const [download] = await Promise.all([
    hub.waitForEvent("download"),
    hub.getByRole("button", { name: "Download bundle" }).click(),
  ]);
  await download.saveAs(BUNDLE);
  const bundle = JSON.parse(readFileSync(BUNDLE, "utf8")) as FlowJson;

  // setViewport + navigate are seeded, so the flow is CLICKS + 2.
  ok(
    `the bundle carries all ${CLICKS + 2} steps, none dropped`,
    bundle.steps.length === CLICKS + 2,
    `${bundle.steps.length} steps`,
  );
  ok(
    "the sidecar has an entry for every step",
    bundle.meta?.length === bundle.steps.length,
    `${bundle.meta?.length} meta vs ${bundle.steps.length} steps`,
  );
  ok(
    "every step is paired to its sidecar by id, across the whole flow",
    bundle.steps.every((step, i) => bundle.meta![i].stepId === step.id),
  );
  ok(
    "step ids are unique and strictly increasing — storage order survived",
    bundle.steps.every((step, i) => i === 0 || step.id! > bundle.steps[i - 1].id!),
  );
  ok(
    "monotonic stamps never go backwards over a long session",
    bundle.meta!.every((m, i) => i === 0 || m.tMono >= bundle.meta![i - 1].tMono),
  );

  // The dashboard caps how many rows it DRAWS; that must not cap what it keeps.
  const drawn = await hub.evaluate(
    `document.querySelectorAll('[data-testid="tf-step"]').length`,
  );
  ok(
    `the live list draws a bounded number of rows (${drawn}) while keeping all ${bundle.steps.length}`,
    (drawn as number) < bundle.steps.length,
    `drew ${drawn}`,
  );
} finally {
  await context.close();
}

/* Replay the long flow through the CLI, the way a user would. */

console.log("\n— replaying the long flow —");
let output = "";
let failed = false;
try {
  output = execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(HERE, "run-flow.mts"), BUNDLE],
    { encoding: "utf8", cwd: path.join(HERE, ".."), stdio: "pipe", timeout: 300000 },
  );
} catch (err) {
  failed = true;
  const e = err as { stdout?: string; stderr?: string; message?: string };
  output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
}

const failedSteps = (output.match(/^\s+✗/gm) ?? []).length;
if (failed || failedSteps > 0) {
  console.log(output.split("\n").filter((l) => l.includes("✗") || l.includes("FAIL")).slice(0, 10).join("\n"));
}
ok("the long flow replays end to end", !failed, `${failedSteps} failed steps`);
ok("no step failed", failedSteps === 0);
ok("no sidecar misalignment was reported", !output.includes("sidecar entries"));

rmSync(BUNDLE, { force: true });
console.log(`\nall ${checks} checks passed`);
