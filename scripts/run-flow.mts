/**
 * Replay a recorded flow in Playwright, from the command line.
 *
 *   npm run flow -- my-recording.tfflow.json
 *   npm run flow -- my-recording.tfflow.json --headed --speed recorded
 *   npm run flow -- my-recording.tfflow.json --har-record run.har
 *   npm run flow -- my-recording.tfflow.json --har-replay run.har
 *   npm run flow -- my-recording.tfflow.json --secret LOGIN_PASSWORD=hunter2
 *
 * The input is a "bundle" (Download bundle in the dashboard) — the DevTools steps
 * plus the sidecars. A plain DevTools export works too; it just replays without the
 * environment and targeting information, which is the difference between repeating
 * the actions and reproducing the session.
 *
 * Exit code is 0 only if every step passed.
 */

import { readFileSync } from "node:fs";
import { runFlow } from "../src/runner/run.ts";
import type { FlowJson } from "../src/types/flow.ts";
import type { RunOptions, RunReport } from "../src/runner/types.ts";

function parseArgs(argv: string[]): { file: string; options: RunOptions } {
  const [file, ...rest] = argv;
  if (!file || file.startsWith("--")) {
    console.error(
      "usage: npm run flow -- <flow.tfflow.json> [--headed] [--speed fast|recorded]\n" +
        "                      [--har-record <file>] [--har-replay <file>]\n" +
        "                      [--secret NAME=value] [--timeout ms] [--continue]",
    );
    process.exit(2);
  }

  const options: RunOptions = { headless: true };
  const secrets: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case "--headed":
        // Headed is the honest default for fidelity work: background and headless
        // rendering differ from what was recorded.
        options.headless = false;
        break;
      case "--speed":
        options.speed = value === "recorded" ? "recorded" : "fast";
        i++;
        break;
      case "--timeout":
        options.timeout = Number(value);
        i++;
        break;
      case "--continue":
        options.continueOnError = true;
        break;
      case "--channel":
        options.channel = value;
        i++;
        break;
      case "--har-record":
        options.har = { path: value, mode: "record" };
        i++;
        break;
      case "--har-replay":
        options.har = { path: value, mode: "replay" };
        i++;
        break;
      case "--secret": {
        const split = value.indexOf("=");
        if (split > 0) secrets[value.slice(0, split)] = value.slice(split + 1);
        i++;
        break;
      }
      default:
        console.error(`unknown option: ${flag}`);
        process.exit(2);
    }
  }
  if (Object.keys(secrets).length > 0) options.secrets = secrets;
  return { file, options };
}

function print(report: RunReport): void {
  const mark = { pass: "·", fail: "✗", skipped: "-" };
  console.log(`\n${report.title}  [${report.mode}]`);

  for (const warning of report.warnings ?? []) {
    console.log(`\n!  ${warning}`);
  }

  if (report.env.deltas.length > 0) {
    console.log("\nEnvironment differences from the recording:");
    for (const delta of report.env.deltas) {
      console.log(
        `  ${delta.blocksParity ? "!" : "·"} ${delta.code}  ${delta.field}: recorded ${delta.recorded}, live ${delta.live}`,
      );
      console.log(`      ${delta.hint}`);
    }
  } else if (report.env.recorded) {
    console.log("\nEnvironment matches the recording.");
  } else {
    console.log(
      "\nNo environment record in this flow — replaying without viewport, fonts,\n" +
        "locale or timezone from the original session. Use a bundle export for those.",
    );
  }

  console.log("\nSteps:");
  for (const step of report.steps) {
    const frame = step.frameHow && step.frameHow !== "main" ? ` frame:${step.frameHow}` : "";
    console.log(
      `  ${mark[step.status]} ${String(step.index).padStart(3)}  ${step.type.padEnd(18)} ${step.targetId}${frame}` +
        `${step.error ? `\n        ${step.code}: ${step.error}` : ""}`,
    );
    for (const note of step.notes ?? []) console.log(`        ⚠ ${note}`);
  }

  if (report.unmatchedRequests?.length) {
    console.log(
      `\n${report.unmatchedRequests.length} request(s) the recording never saw (sealed mode aborted them):`,
    );
    for (const url of report.unmatchedRequests.slice(0, 10)) console.log(`  ${url}`);
  }

  const passed = report.steps.filter((s) => s.status === "pass").length;
  const failed = report.steps.filter((s) => s.status === "fail").length;
  console.log(
    `\n${report.ok ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed, ` +
      `${report.durationMs}ms`,
  );
  if (report.blockedBy) {
    console.log(
      `\nThis run could not match the recording's appearance: ${report.blockedBy.code} (${report.blockedBy.field}).\n` +
        `${report.blockedBy.hint}`,
    );
  }
}

const { file, options } = parseArgs(process.argv.slice(2));
const flow = JSON.parse(readFileSync(file, "utf8")) as FlowJson;
if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
  console.error(`${file} has no steps — is it a flow export?`);
  process.exit(2);
}

const report = await runFlow(flow, options);
print(report);
process.exit(report.ok ? 0 : 1);
