/**
 * The round trip, end to end: RECORD in a real browser with the real extension,
 * export a bundle exactly as the dashboard's "Download bundle" button does, then
 * replay that file through the command line runner.
 *
 * This is the only test that exercises the path a user actually takes. Everything
 * else builds flows by hand.
 *
 * Run:  npm run e2e:cli   (dev server must be up on :3000)
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
const BUNDLE = path.join(os.tmpdir(), `testflow-cli-${process.pid}.tfflow.json`);

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
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await page.getByPlaceholder("https://example.com").fill(`${BASE}/demo-frames.html`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Start Session" }).click(),
  ]);
  await tab.waitForLoadState("load");
  await tab.waitForSelector("#__tf_badge");

  // A flow that needs every piece of the sidecar to replay: an iframe, an SPA
  // route, and a dialog.
  await tab.frameLocator("#shop-b").getByRole("button", { name: "Add to cart" }).click();
  await tab.waitForTimeout(300);
  await tab.getByRole("button", { name: "Go to checkout" }).click();
  await tab.waitForTimeout(400);
  tab.once("dialog", (dialog) => void dialog.accept());
  await tab.getByRole("button", { name: "Delete" }).click();
  await tab.waitForTimeout(400);

  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tf-step"]').length >= 5,
    undefined,
    { timeout: 8000 },
  );
  await page.getByRole("button", { name: "Stop recording" }).click();
  await page.getByRole("button", { name: "Download bundle" }).waitFor({ timeout: 5000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download bundle" }).click(),
  ]);
  await download.saveAs(BUNDLE);
  ok("the dashboard exported a bundle", true);

  const bundle = JSON.parse(readFileSync(BUNDLE, "utf8")) as FlowJson;
  ok("the bundle carries the steps", (bundle.steps?.length ?? 0) >= 5);
  ok(
    "the bundle carries a sidecar entry per step — the plain export does not",
    bundle.meta?.length === bundle.steps.length,
    `${bundle.meta?.length} meta vs ${bundle.steps.length} steps`,
  );
  ok(
    "the bundle carries the recording environment",
    Boolean(bundle.env?.viewport?.width && bundle.env.fonts.length > 0),
  );
  ok(
    "the environment includes the fields that decide layout",
    typeof bundle.env?.scrollbarWidth === "number" &&
      typeof bundle.env.deviceScaleFactor === "number" &&
      typeof bundle.env.timeZone === "string",
  );
  ok(
    "a dialog answer survived the export",
    bundle.meta!.some((meta) => meta.dialog?.accept === true),
  );
  ok(
    "a frame chain survived the export",
    bundle.meta!.some((meta) => meta.frameChain.length > 0),
  );
  ok(
    "every step is paired to its sidecar by ID, not just by position",
    bundle.steps.every(
      (step, index) =>
        typeof step.id === "number" && bundle.meta![index].stepId === step.id,
    ),
  );
} finally {
  await context.close();
}

/* Now replay that file the way a user would: from the command line. */

console.log("\n— npm run flow —");
let output = "";
let failed = false;
try {
  // node + the tsx loader directly: npx resolution differs across platforms and
  // shells, and this test is about the runner, not about npx.
  output = execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(HERE, "run-flow.mts"), BUNDLE],
    { encoding: "utf8", cwd: path.join(HERE, ".."), stdio: "pipe" },
  );
} catch (err) {
  failed = true;
  const e = err as { stdout?: string; stderr?: string; message?: string };
  output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
}
console.log(
  output
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
);

ok("the CLI replayed the recorded bundle and exited 0", !failed, output.slice(-400));
ok("the CLI reported PASS", output.includes("PASS"));
ok(
  "the CLI reported the environment comparison",
  output.includes("Environment matches the recording") ||
    output.includes("Environment differences"),
);
ok("the CLI listed the steps it ran", output.includes("Steps:"));

rmSync(BUNDLE, { force: true });
console.log(`\nall ${checks} checks passed`);
