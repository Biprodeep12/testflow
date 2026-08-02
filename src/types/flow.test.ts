/**
 * Unit tests for the flow document: exports, sidecar pairing, frame identity.
 *
 * These are the pure functions every other layer trusts. The E2E suites drive a real
 * browser and take minutes; these take milliseconds, which is the difference between
 * a check you run constantly and one you run at the end.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignmentProblems,
  exportSteps,
  frameKey,
  frameSignature,
  metaResolver,
  toBundle,
  type FlowJson,
  type FlowStep,
  type StepMeta,
} from "./flow";

const step = (over: Partial<FlowStep> = {}): FlowStep => ({ type: "click", ...over });
const meta = (over: Partial<StepMeta> = {}): StepMeta => ({
  targetId: "t0",
  frameChain: [],
  tMono: 0,
  ...over,
});

describe("exportSteps", () => {
  it("removes every TestFlow-only field, so the JSON stays DevTools-compatible", () => {
    const [out] = exportSteps([
      step({ id: 7, timestamp: 123, tagName: "select", value: "pro" }),
    ]);
    assert.equal(out.id, undefined);
    assert.equal(out.timestamp, undefined);
    assert.equal(out.tagName, undefined);
    // …while keeping everything DevTools defines.
    assert.equal(out.value, "pro");
    assert.equal(out.type, "click");
  });

  it("keeps the NATIVE frame and target fields — they are DevTools', not ours", () => {
    const [out] = exportSteps([step({ frame: [0, 2], target: "https://x.test/popup" })]);
    assert.deepEqual(out.frame, [0, 2]);
    assert.equal(out.target, "https://x.test/popup");
  });

  it("does not mutate the input", () => {
    const original = step({ id: 1, timestamp: 5 });
    exportSteps([original]);
    assert.equal(original.id, 1);
    assert.equal(original.timestamp, 5);
  });
});

describe("toBundle", () => {
  it("carries the sidecars that the DevTools export drops", () => {
    const flow: FlowJson = {
      title: "t",
      steps: [step({ id: 1 })],
      meta: [meta({ stepId: 1, targetId: "t1" })],
      env: { viewport: { width: 800, height: 600 } } as FlowJson["env"],
    };
    const parsed = JSON.parse(toBundle(flow)) as FlowJson;
    assert.equal(parsed.meta?.[0].targetId, "t1");
    assert.equal(parsed.env?.viewport.width, 800);
    // The id stays: this file is for the runner, not for Chrome.
    assert.equal(parsed.steps[0].id, 1);
  });

  it("always writes a timeout, so the runner never has to invent one", () => {
    const parsed = JSON.parse(toBundle({ title: "t", steps: [step()] })) as FlowJson;
    assert.equal(typeof parsed.timeout, "number");
  });
});

describe("metaResolver", () => {
  it("pairs by id, even when the arrays have drifted out of order", () => {
    const flow: FlowJson = {
      title: "t",
      steps: [step({ id: 1 }), step({ id: 2 })],
      // Reversed: index pairing would attach each step to the wrong context.
      meta: [meta({ stepId: 2, targetId: "t2" }), meta({ stepId: 1, targetId: "t1" })],
    };
    const at = metaResolver(flow);
    assert.equal(at(0)?.targetId, "t1");
    assert.equal(at(1)?.targetId, "t2");
  });

  it("falls back to position for flows with no ids (older and hand-written ones)", () => {
    const flow: FlowJson = {
      title: "t",
      steps: [step(), step()],
      meta: [meta({ targetId: "a" }), meta({ targetId: "b" })],
    };
    const at = metaResolver(flow);
    assert.equal(at(0)?.targetId, "a");
    assert.equal(at(1)?.targetId, "b");
  });

  it("returns undefined rather than a wrong answer when there is no sidecar", () => {
    const at = metaResolver({ title: "t", steps: [step()] });
    assert.equal(at(0), undefined);
  });
});

describe("alignmentProblems", () => {
  it("says nothing when the flow is consistent", () => {
    assert.deepEqual(
      alignmentProblems({
        title: "t",
        steps: [step({ id: 1 })],
        meta: [meta({ stepId: 1 })],
      }),
      [],
    );
  });

  it("catches a sidecar that lost an entry — the silent-corruption case", () => {
    const problems = alignmentProblems({
      title: "t",
      steps: [step({ id: 1 }), step({ id: 2 })],
      meta: [meta({ stepId: 1 })],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 steps but 1 sidecar/);
  });

  it("catches steps paired with another step's entry", () => {
    const problems = alignmentProblems({
      title: "t",
      steps: [step({ id: 1 }), step({ id: 2 })],
      meta: [meta({ stepId: 2 }), meta({ stepId: 1 })],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /belonging to a different step/);
  });

  it("is silent for flows with no sidecar at all", () => {
    assert.deepEqual(alignmentProblems({ title: "t", steps: [step()] }), []);
  });
});

describe("frame identity", () => {
  it("keys a chain by its index path", () => {
    assert.equal(frameKey([]), "");
    assert.equal(frameKey([{ index: 0 }, { index: 2 }]), "0/2");
  });

  it("signs a chain by the iframe elements, which survive reordering", () => {
    assert.equal(
      frameSignature([{ index: 1, selectors: [["#shop-b"], ["aria/shop B"]] }]),
      "#shop-b",
    );
  });

  it("falls back to the index when an iframe offers no selector", () => {
    assert.equal(frameSignature([{ index: 3 }]), "#3");
  });

  it("distinguishes two frames that differ only in depth", () => {
    assert.notEqual(frameKey([{ index: 1 }]), frameKey([{ index: 1 }, { index: 1 }]));
  });
});
