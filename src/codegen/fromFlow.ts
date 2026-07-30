/**
 * DevTools-Recorder flow -> Playwright TypeScript.
 *
 * Selector mapping is heuristic by necessity: `aria/Name` carries the accessible name
 * but not the role, so it becomes getByText(...).or(getByLabel(...)) — text covers
 * visible-label elements, getByLabel covers aria-label'd icon buttons. `.first()`
 * defuses strict-mode when the .or() union matches both.
 */

// Relative import so this module also loads outside Next.js (the E2E suite
// imports it directly to verify generated code).
import {
  DEFAULT_TIMEOUT_MS,
  type FlowJson,
  type FlowStep,
  type SelectorGroup,
} from "../types/flow";

function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function locatorFor(selectors: SelectorGroup[] | undefined): string {
  const flat = (selectors ?? []).map((group) => group[0]).filter(Boolean);
  const pick = (prefix: string): string | undefined => {
    const hit = flat.find((s) => s.startsWith(prefix));
    return hit?.slice(prefix.length);
  };

  // Explicit test hooks beat everything — that's what they're for.
  const testid = flat
    .map((s) => /^\[data-testid="((?:[^"\\]|\\.)*)"\]$/.exec(s)?.[1])
    .find(Boolean);
  if (testid) return `page.getByTestId(${q(testid.replace(/\\(.)/g, "$1"))})`;

  const aria = pick("aria/");
  if (aria) {
    return `page.getByText(${q(aria)}, { exact: true }).or(page.getByLabel(${q(aria)})).first()`;
  }
  const text = pick("text/");
  if (text) return `page.getByText(${q(text)}).first()`;

  const css = flat.find(
    (s) => !s.startsWith("xpath/") && !s.startsWith("pierce/") && !s.includes("/"),
  );
  if (css) return `page.locator(${q(css)})`;

  const pierce = pick("pierce/");
  if (pierce) return `page.locator(${q(pierce)})`; // Playwright pierces shadow DOM natively

  const xpath = pick("xpath/");
  if (xpath) return `page.locator(${q("xpath=" + xpath)})`;

  return `page.locator('body')`;
}

function stepLines(step: FlowStep, timeout: number): string[] {
  const lines: string[] = [];
  // State-tied settle after any navigation/redirect: wait for network quiet up to
  // the budget, then proceed either way — never a blind sleep.
  const settle = `await page.waitForLoadState('networkidle', { timeout: ${timeout} }).catch(() => {});`;

  switch (step.type) {
    case "setViewport":
      lines.push(
        `await page.setViewportSize({ width: ${step.width ?? 1280}, height: ${step.height ?? 720} });`,
      );
      break;
    case "navigate": {
      lines.push(`await page.goto(${q(step.url ?? "")});`);
      lines.push(settle);
      const nav = step.assertedEvents?.find((e) => e.type === "navigation");
      if (nav?.title) lines.push(`await expect(page).toHaveTitle(${q(nav.title)});`);
      break;
    }
    case "click":
    case "doubleClick": {
      const method = step.type === "doubleClick" ? "dblclick" : "click";
      const options = step.button === "secondary" ? "{ button: 'right' }" : "";
      lines.push(`await ${locatorFor(step.selectors)}.${method}(${options});`);
      const nav = step.assertedEvents?.find((e) => e.type === "navigation");
      if (nav?.url) {
        lines.push(`await expect(page).toHaveURL(${q(nav.url)});`);
        lines.push(settle); // the redirect this click caused
      }
      break;
    }
    case "change":
      // fill() throws on <select> — Playwright demands selectOption() there.
      if (step.tagName === "select") {
        lines.push(
          `await ${locatorFor(step.selectors)}.selectOption(${q(step.value ?? "")});`,
        );
      } else {
        lines.push(
          `await ${locatorFor(step.selectors)}.fill(${q(step.value ?? "")});`,
        );
      }
      break;
    // down/up (not press) so holds and combos survive: keyDown Control ->
    // keyDown b -> keyUp b -> keyUp Control replays as an actual Ctrl+B.
    case "keyDown":
      lines.push(`await page.keyboard.down(${q(step.key ?? "Enter")});`);
      break;
    case "keyUp":
      lines.push(`await page.keyboard.up(${q(step.key ?? "Enter")});`);
      break;
    case "scroll":
      if (step.selectors?.length) {
        lines.push(
          `await ${locatorFor(step.selectors)}.evaluate((el) => el.scrollTo(${step.x ?? 0}, ${step.y ?? 0}));`,
        );
      } else {
        lines.push(
          `await page.evaluate(() => window.scrollTo(${step.x ?? 0}, ${step.y ?? 0}));`,
        );
      }
      break;
    case "wheel":
      // Consumed wheel (map zoom etc.): position the mouse, then real wheel input.
      lines.push(
        `await ${locatorFor(step.selectors)}.hover(${
          typeof step.offsetX === "number"
            ? `{ position: { x: ${Math.round(step.offsetX)}, y: ${Math.round(step.offsetY ?? 0)} } }`
            : ""
        });`,
      );
      lines.push(`await page.mouse.wheel(${step.deltaX ?? 0}, ${step.deltaY ?? 0});`);
      break;
    case "drag": {
      // Retrace the recorded cursor path from the element's start point.
      const sx = Math.round(step.offsetX ?? 0);
      const sy = Math.round(step.offsetY ?? 0);
      // Subsample long paths — codegen readability beats 40 mouse.move lines.
      const path = step.path ?? [];
      const stride = Math.max(1, Math.ceil(path.length / 6));
      const points = path.filter(
        (_, i) => i % stride === 0 || i === path.length - 1,
      );
      lines.push(`{`);
      lines.push(
        `  const box = (await ${locatorFor(step.selectors)}.boundingBox())!;`,
      );
      lines.push(`  await page.mouse.move(box.x + ${sx}, box.y + ${sy});`);
      lines.push(`  await page.mouse.down();`);
      for (const point of points) {
        lines.push(
          `  await page.mouse.move(box.x + ${sx + point.x}, box.y + ${sy + point.y}, { steps: 3 });`,
        );
      }
      lines.push(`  await page.mouse.up();`);
      lines.push(`}`);
      break;
    }
    case "waitForElement":
      lines.push(`await expect(${locatorFor(step.selectors)}).toBeVisible();`);
      break;
    case "waitForExpression":
      lines.push(`await page.waitForFunction(${q(step.expression ?? "true")});`);
      break;
  }
  return lines;
}

export function flowToPlaywright(flow: FlowJson): string {
  const title = (flow.title || "recorded flow").replace(/'/g, "\\'").slice(0, 200);
  const timeout = flow.timeout ?? DEFAULT_TIMEOUT_MS;
  const body = flow.steps
    .flatMap((step) => stepLines(step, step.timeout ?? timeout))
    .map((line) => "  " + line);
  return [
    "import { test, expect } from '@playwright/test';",
    "",
    `// Waits are budgeted at ${timeout}ms per action/redirect (the flow's timeout).`,
    `test.use({ actionTimeout: ${timeout} });`,
    "",
    `test('${title}', async ({ page }) => {`,
    ...(body.length > 0 ? body : ["  // empty flow"]),
    "});",
    "",
  ].join("\n");
}
