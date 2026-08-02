/**
 * DevTools-Recorder flow -> Playwright TypeScript.
 *
 * This is the READABLE EXPORT, not the authoritative replay path — `src/runner`
 * is. Generated code necessarily re-expresses replay semantics in a second form:
 * selector mapping is heuristic (`aria/Name` carries the accessible name but not the
 * role, so it becomes getByText(...).or(getByLabel(...)); `.first()` defuses
 * strict-mode when the union matches both), and the consensus vote the runner uses
 * has no readable Playwright equivalent. Where the two disagree, the runner is right.
 *
 * What the export does carry faithfully: the recording's environment (viewport, DPR,
 * UA, locale, timezone, colour scheme), the frame each step ran in, and the tab each
 * step ran in.
 */

// Relative import so this module also loads outside Next.js (the E2E suite
// imports it directly to verify generated code).
import {
  DEFAULT_TIMEOUT_MS,
  metaResolver,
  ROOT_TARGET,
  type EnvRecord,
  type FlowJson,
  type FlowStep,
  type SelectorGroup,
  type StepMeta,
} from "../types/flow";

function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

/**
 * A selector frameLocator() can actually parse.
 *
 * The recorder ranks an iframe's groups by durability, which often puts `aria/Name`
 * first — and frameLocator() has no aria engine, so handing it the top-ranked group
 * emits code that throws. CSS is what it wants; the shadow-piercing variant is the
 * same selector, and DevTools engine prefixes are dropped rather than guessed at.
 */
function frameSelector(selectors: SelectorGroup[] | undefined): string | null {
  const flat = (selectors ?? []).map((group) => group[0]).filter(Boolean);
  const css = flat.find(
    (s) => !s.startsWith("xpath/") && !s.startsWith("pierce/") && !s.includes("/"),
  );
  if (css) return css;
  const pierce = flat.find((s) => s.startsWith("pierce/"));
  return pierce ? pierce.slice("pierce/".length) : null;
}

/**
 * The scope a step's locators hang off: the page, or a frameLocator chain built
 * from the iframe elements the recorder captured.
 */
function scopeFor(meta: StepMeta | undefined, pageVar: string): string {
  let scope = pageVar;
  for (const link of meta?.frameChain ?? []) {
    const selector = frameSelector(link.selectors);
    // No usable selector for the iframe element: fall back to the recorded index,
    // which is what the native DevTools frame path carries.
    scope += selector
      ? `.frameLocator(${q(selector)})`
      : `.frameLocator(${q(`iframe >> nth=${link.index}`)})`;
  }
  return scope;
}

function locatorFor(selectors: SelectorGroup[] | undefined, scope: string): string {
  const flat = (selectors ?? []).map((group) => group[0]).filter(Boolean);
  const pick = (prefix: string): string | undefined => {
    const hit = flat.find((s) => s.startsWith(prefix));
    return hit?.slice(prefix.length);
  };

  // Explicit test hooks beat everything — that's what they're for.
  const testid = flat
    .map((s) => /^\[data-testid="((?:[^"\\]|\\.)*)"\]$/.exec(s)?.[1])
    .find(Boolean);
  if (testid) return `${scope}.getByTestId(${q(testid.replace(/\\(.)/g, "$1"))})`;

  const aria = pick("aria/");
  if (aria) {
    return `${scope}.getByText(${q(aria)}, { exact: true }).or(${scope}.getByLabel(${q(aria)})).first()`;
  }
  const text = pick("text/");
  if (text) return `${scope}.getByText(${q(text)}).first()`;

  const css = flat.find(
    (s) => !s.startsWith("xpath/") && !s.startsWith("pierce/") && !s.includes("/"),
  );
  if (css) return `${scope}.locator(${q(css)})`;

  const pierce = pick("pierce/");
  if (pierce) return `${scope}.locator(${q(pierce)})`; // Playwright pierces shadow DOM natively

  const xpath = pick("xpath/");
  if (xpath) return `${scope}.locator(${q("xpath=" + xpath)})`;

  return `${scope}.locator('body')`;
}

function stepLines(
  step: FlowStep,
  meta: StepMeta | undefined,
  timeout: number,
  pageVar: string,
  hasEnv: boolean,
): string[] {
  const lines: string[] = [];
  const scope = scopeFor(meta, pageVar);
  const target = locatorFor(step.selectors, scope);
  // State-tied settle after a navigation: wait for the load event, then proceed
  // either way. Never a blind sleep, and never `networkidle` — which Playwright
  // discourages and which says nothing about fonts or images being ready.
  const settle = `await ${pageVar}.waitForLoadState('load', { timeout: ${timeout} }).catch(() => {});`;

  switch (step.type) {
    case "setViewport":
      if (hasEnv) {
        // test.use() already carries it, and from a richer source: DPR, touch and
        // mobile emulation belong to the context, not to a mid-test resize.
        lines.push(
          `// viewport ${step.width}x${step.height} @${step.deviceScaleFactor ?? 1}x — applied via test.use()`,
        );
      } else {
        // A flow with no environment record (imported DevTools JSON, or recorded
        // before env capture existed) still has to get its viewport from somewhere.
        lines.push(
          `await ${pageVar}.setViewportSize({ width: ${step.width ?? 1280}, height: ${step.height ?? 720} });`,
        );
      }
      break;
    case "navigate": {
      lines.push(`await ${pageVar}.goto(${q(step.url ?? "")});`);
      lines.push(settle);
      const nav = step.assertedEvents?.find((e) => e.type === "navigation");
      if (nav?.title) lines.push(`await expect(${pageVar}).toHaveTitle(${q(nav.title)});`);
      break;
    }
    case "click":
    case "doubleClick": {
      const method = step.type === "doubleClick" ? "dblclick" : "click";
      const options = step.button === "secondary" ? "{ button: 'right' }" : "";
      lines.push(`await ${target}.${method}(${options});`);
      const nav = step.assertedEvents?.find((e) => e.type === "navigation");
      if (nav?.url) {
        lines.push(`await expect(${pageVar}).toHaveURL(${q(nav.url)});`);
        lines.push(settle); // the redirect this click caused
      }
      break;
    }
    case "change":
      // fill() throws on <select> — Playwright demands selectOption() there.
      if (step.tagName === "select") {
        lines.push(`await ${target}.selectOption(${q(step.value ?? "")});`);
      } else {
        lines.push(`await ${target}.fill(${q(step.value ?? "")});`);
      }
      break;
    // down/up (not press) so holds and combos survive: keyDown Control ->
    // keyDown b -> keyUp b -> keyUp Control replays as an actual Ctrl+B.
    case "keyDown":
      lines.push(`await ${pageVar}.keyboard.down(${q(step.key ?? "Enter")});`);
      break;
    case "keyUp":
      lines.push(`await ${pageVar}.keyboard.up(${q(step.key ?? "Enter")});`);
      break;
    case "scroll":
      if (step.selectors?.length) {
        lines.push(
          `await ${target}.evaluate((el) => el.scrollTo(${step.x ?? 0}, ${step.y ?? 0}));`,
        );
      } else {
        lines.push(
          `await ${pageVar}.evaluate(() => window.scrollTo(${step.x ?? 0}, ${step.y ?? 0}));`,
        );
      }
      break;
    case "wheel":
      // Consumed wheel (map zoom etc.): position the mouse, then real wheel input.
      lines.push(
        `await ${target}.hover(${
          typeof step.offsetX === "number"
            ? `{ position: { x: ${Math.round(step.offsetX)}, y: ${Math.round(step.offsetY ?? 0)} } }`
            : ""
        });`,
      );
      lines.push(`await ${pageVar}.mouse.wheel(${step.deltaX ?? 0}, ${step.deltaY ?? 0});`);
      break;
    case "drag": {
      // Retrace the recorded cursor path from the element's start point.
      const sx = Math.round(step.offsetX ?? 0);
      const sy = Math.round(step.offsetY ?? 0);
      // Subsample long paths — codegen readability beats 40 mouse.move lines.
      const path = step.path ?? [];
      const stride = Math.max(1, Math.ceil(path.length / 6));
      const points = path.filter((_, i) => i % stride === 0 || i === path.length - 1);
      lines.push(`{`);
      lines.push(`  const box = (await ${target}.boundingBox())!;`);
      lines.push(`  await ${pageVar}.mouse.move(box.x + ${sx}, box.y + ${sy});`);
      lines.push(`  await ${pageVar}.mouse.down();`);
      for (const point of points) {
        lines.push(
          `  await ${pageVar}.mouse.move(box.x + ${sx + point.x}, box.y + ${sy + point.y}, { steps: 3 });`,
        );
      }
      lines.push(`  await ${pageVar}.mouse.up();`);
      lines.push(`}`);
      break;
    }
    case "waitForElement":
      lines.push(`await expect(${target}).toBeVisible();`);
      break;
    case "waitForExpression":
      // SPA route changes land here: a state-tied wait on location, not a sleep.
      lines.push(`await ${pageVar}.waitForFunction(${q(step.expression ?? "true")});`);
      break;
  }
  return lines;
}

/** `test.use({...})` from the recording environment — the replay inputs that decide layout. */
function testUseBlock(env: EnvRecord | undefined): string[] {
  if (!env) return [];
  const entries = [
    `viewport: { width: ${env.viewport.width}, height: ${env.viewport.height} }`,
    `deviceScaleFactor: ${env.deviceScaleFactor}`,
    `isMobile: ${env.isMobile}`,
    `hasTouch: ${env.hasTouch}`,
    `userAgent: ${q(env.userAgent)}`,
    `locale: ${q(env.locale)}`,
    `timezoneId: ${q(env.timeZone)}`,
    `colorScheme: ${q(env.colorScheme)}`,
    `reducedMotion: ${q(env.reducedMotion ? "reduce" : "no-preference")}`,
  ];
  return [
    "// Recording environment — these decide layout, so they are replay inputs.",
    `// Recorded on ${env.browser.name} ${env.browser.version}; scrollbar ${env.scrollbarWidth}px.`,
    `test.use({ ${entries.join(", ")} });`,
  ];
}

/** Variable name for a logical target: t0 is `page`, popups are `page1`, `page2`… */
function pageVarFor(targetId: string): string {
  return targetId === ROOT_TARGET ? "page" : `page${targetId.replace(/^t/, "")}`;
}

export function flowToPlaywright(flow: FlowJson): string {
  const title = (flow.title || "recorded flow").replace(/'/g, "\\'").slice(0, 200);
  const timeout = flow.timeout ?? DEFAULT_TIMEOUT_MS;

  // A popup has to be captured in the same tick as the click that opens it —
  // Playwright does not buffer the 'page' event. So find, for each new target, the
  // step immediately before its first use, and wrap that step in Promise.all.
  const opensTarget = new Map<number, string>();
  const seen = new Set<string>([ROOT_TARGET]);
  (flow.meta ?? []).forEach((meta, index) => {
    if (seen.has(meta.targetId)) return;
    seen.add(meta.targetId);
    if (index > 0) opensTarget.set(index - 1, meta.targetId);
  });

  const metaAt = metaResolver(flow);
  const body: string[] = [];
  flow.steps.forEach((step, index) => {
    const meta = metaAt(index);
    const pageVar = pageVarFor(meta?.targetId ?? ROOT_TARGET);
    const lines = stepLines(step, meta, step.timeout ?? timeout, pageVar, Boolean(flow.env));
    const popup = opensTarget.get(index);
    if (popup && lines.length > 0) {
      body.push(`const [${pageVarFor(popup)}] = await Promise.all([`);
      body.push(`  context.waitForEvent('page'),`);
      body.push(...lines.map((line) => `  (async () => { ${line} })(),`));
      body.push(`]);`);
      return;
    }
    body.push(...lines);
  });

  const needsContext = opensTarget.size > 0;
  return [
    "import { test, expect } from '@playwright/test';",
    "",
    ...testUseBlock(flow.env),
    "",
    `// Waits are budgeted at ${timeout}ms per action/redirect (the flow's timeout).`,
    `test.use({ actionTimeout: ${timeout} });`,
    "",
    `test('${title}', async ({ page${needsContext ? ", context" : ""} }) => {`,
    ...(body.length > 0 ? body.map((line) => "  " + line) : ["  // empty flow"]),
    "});",
    "",
  ].join("\n");
}
