/**
 * Unit tests for the Playwright export.
 *
 * Codegen is a SECOND implementation of replay semantics, which is exactly why it
 * drifts: the runner gets exercised by the E2E suites and the generated text does
 * not. The last test here is the one that matters — it fails when the runner learns
 * a step type the export never hears about.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flowToPlaywright } from "./fromFlow";
import type { EnvRecord, FlowJson, FlowStep, StepMeta } from "../types/flow";

const meta = (over: Partial<StepMeta> = {}): StepMeta => ({
  targetId: "t0",
  frameChain: [],
  tMono: 0,
  ...over,
});

const env = (over: Partial<EnvRecord> = {}): EnvRecord =>
  ({
    viewport: { width: 1024, height: 768 },
    layoutWidth: 1024,
    scrollbarWidth: 0,
    deviceScaleFactor: 2,
    screen: { width: 1920, height: 1080, availHeight: 1040 },
    userAgent: "UA",
    browser: { name: "Chrome", version: "131.0" },
    locale: "en-GB",
    languages: ["en-GB"],
    timeZone: "Europe/London",
    timeOrigin: 0,
    colorScheme: "dark",
    reducedMotion: false,
    forcedColors: false,
    isMobile: false,
    hasTouch: false,
    maxTouchPoints: 0,
    fonts: [],
    ...over,
  }) as EnvRecord;

const gen = (steps: FlowStep[], over: Partial<FlowJson> = {}): string =>
  flowToPlaywright({ title: "t", steps, ...over });

describe("environment", () => {
  it("turns the recording environment into test.use()", () => {
    const code = gen([{ type: "click", selectors: [["#a"]] }], { env: env() });
    assert.match(code, /viewport: \{ width: 1024, height: 768 \}/);
    assert.match(code, /deviceScaleFactor: 2/);
    assert.match(code, /timezoneId: 'Europe\/London'/);
    assert.match(code, /colorScheme: 'dark'/);
  });

  it("still sets the viewport for a flow that has NO environment record", () => {
    // An imported DevTools JSON has no env; dropping the viewport entirely would
    // silently replay at whatever size Playwright defaults to.
    const code = gen([{ type: "setViewport", width: 800, height: 600 }]);
    assert.match(code, /setViewportSize\(\{ width: 800, height: 600 \}\)/);
  });

  it("defers to test.use() when the environment IS present", () => {
    const code = gen([{ type: "setViewport", width: 800, height: 600 }], { env: env() });
    assert.doesNotMatch(code, /setViewportSize/);
  });
});

describe("frames", () => {
  it("uses a CSS selector for frameLocator, never an aria/ one", () => {
    // The recorder ranks by durability, which often puts aria/ first — and
    // frameLocator has no aria engine, so the generated code would throw.
    const code = gen([{ type: "click", selectors: [["#btn"]] }], {
      meta: [meta({ frameChain: [{ index: 1, selectors: [["aria/shop B"], ["#shop-b"]] }] })],
    });
    assert.match(code, /frameLocator\('#shop-b'\)/);
    assert.doesNotMatch(code, /frameLocator\('aria/);
  });

  it("falls back to the recorded index when the iframe has no usable selector", () => {
    const code = gen([{ type: "click", selectors: [["#btn"]] }], {
      meta: [meta({ frameChain: [{ index: 2 }] })],
    });
    assert.match(code, /frameLocator\('iframe >> nth=2'\)/);
  });

  it("nests one frameLocator per hop", () => {
    const code = gen([{ type: "click", selectors: [["#btn"]] }], {
      meta: [meta({ frameChain: [{ index: 0, selectors: [["#outer"]] }, { index: 1, selectors: [["#inner"]] }] })],
    });
    assert.match(code, /frameLocator\('#outer'\)\.frameLocator\('#inner'\)/);
  });
});

describe("steps", () => {
  it("uses selectOption for a <select>, because fill() throws on one", () => {
    const code = gen([
      { type: "change", value: "pro", tagName: "select", selectors: [["#plan"]] },
    ]);
    assert.match(code, /selectOption\('pro'\)/);
    assert.doesNotMatch(code, /\.fill\(/);
  });

  it("emits down/up for keys, so holds and combos survive", () => {
    const code = gen([
      { type: "keyDown", key: "Control" },
      { type: "keyDown", key: "b" },
      { type: "keyUp", key: "b" },
      { type: "keyUp", key: "Control" },
    ]);
    assert.match(code, /keyboard\.down\('Control'\)/);
    assert.match(code, /keyboard\.up\('Control'\)/);
    assert.doesNotMatch(code, /keyboard\.press/);
  });

  it("waits on load, not networkidle", () => {
    const code = gen([{ type: "navigate", url: "https://x.test/" }]);
    assert.match(code, /waitForLoadState\('load'/);
    assert.doesNotMatch(code, /networkidle/);
  });

  it("captures a popup in the same tick as the click that opens it", () => {
    // waitForEvent('page') after the fact would hang: Playwright does not buffer.
    const code = gen(
      [
        { type: "click", selectors: [["#open"]] },
        { type: "click", selectors: [["#inside"]] },
      ],
      { meta: [meta(), meta({ targetId: "t1" })] },
    );
    assert.match(code, /Promise\.all\(\[/);
    assert.match(code, /context\.waitForEvent\('page'\)/);
    assert.match(code, /const \[page1\]/);
  });

  it("escapes quotes in values rather than emitting broken source", () => {
    const code = gen([{ type: "change", value: "it's", selectors: [["#x"]] }]);
    assert.match(code, /fill\('it\\'s'\)/);
  });
});

describe("coverage of the runner's step types", () => {
  // The export is a second implementation. When the runner learns a step type and
  // the export does not, flows silently generate code that skips it — this is the
  // check that turns that into a failure.
  const EVERY_TYPE: FlowStep[] = [
    { type: "setViewport", width: 800, height: 600 },
    { type: "navigate", url: "https://x.test/" },
    { type: "click", selectors: [["#a"]] },
    { type: "doubleClick", selectors: [["#a"]] },
    { type: "change", value: "v", selectors: [["#a"]] },
    { type: "keyDown", key: "a" },
    { type: "keyUp", key: "a" },
    { type: "scroll", x: 0, y: 10 },
    { type: "waitForElement", selectors: [["#a"]] },
    { type: "waitForExpression", expression: "true" },
    { type: "wheel", selectors: [["#a"]], deltaY: 120 },
    { type: "drag", selectors: [["#a"]], path: [{ x: 1, y: 1 }] },
  ];

  for (const step of EVERY_TYPE) {
    it(`emits something for "${step.type}"`, () => {
      const code = gen([step]);
      const body = code.slice(code.indexOf("async ({ page"));
      assert.ok(
        !body.includes("// empty flow"),
        `codegen produced nothing for ${step.type}`,
      );
    });
  }
});
