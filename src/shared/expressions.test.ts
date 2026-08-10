/**
 * These matter because of where they run: on a page whose CSP forbids eval, this is
 * the ONLY thing that can answer a recorded route assertion. Getting it wrong there
 * means every SPA recording fails on most real sites.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateKnownExpression, isRouteExpression } from "./expressions";

const at = (pathname: string, hash = "", href = "https://x.test/") =>
  (kind: "pathname" | "hash" | "href") =>
    kind === "pathname" ? pathname : kind === "hash" ? hash : href;

describe("evaluateKnownExpression", () => {
  it("answers the recorder's route assertion without an evaluator", () => {
    const expression = `location.pathname + location.hash === "/checkout#/step-2"`;
    assert.equal(evaluateKnownExpression(expression, at("/checkout", "#/step-2")), true);
    assert.equal(evaluateKnownExpression(expression, at("/checkout", "#/step-1")), false);
  });

  it("handles a route with no hash — the ordinary case", () => {
    const expression = `location.pathname + location.hash === "/villas"`;
    assert.equal(evaluateKnownExpression(expression, at("/villas", "")), true);
    assert.equal(evaluateKnownExpression(expression, at("/villas/other", "")), false);
  });

  it("matches pathname-only and href-only forms", () => {
    assert.equal(
      evaluateKnownExpression(`location.pathname === "/a"`, at("/a")),
      true,
    );
    assert.equal(
      evaluateKnownExpression(`location.href === "https://x.test/"`, at("/", "", "https://x.test/")),
      true,
    );
  });

  it("handles escaped characters in the literal", () => {
    const expression = `location.pathname + location.hash === "/a\\"b"`;
    assert.equal(evaluateKnownExpression(expression, at('/a"b', "")), true);
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(
      evaluateKnownExpression(`  location.pathname === "/a"  `, at("/a")),
      true,
    );
  });

  it("returns undefined for anything hand-written, so a real evaluator is used", () => {
    for (const expression of [
      `document.getElementById('x').textContent === 'y'`,
      `window.dataLayer.length > 0`,
      `location.pathname !== "/a"`,
      // Close to ours but not ours — must NOT be answered structurally.
      `location.pathname + location.search === "/a"`,
      `location.pathname === somethingElse`,
    ]) {
      assert.equal(
        evaluateKnownExpression(expression, at("/a")),
        undefined,
        `should not have matched: ${expression}`,
      );
    }
  });

  it("never throws on a malformed literal", () => {
    assert.equal(
      evaluateKnownExpression(`location.pathname === "unterminated`, at("/a")),
      undefined,
    );
  });
});

describe("isRouteExpression", () => {
  it("recognises exactly the forms the recorder writes", () => {
    assert.equal(isRouteExpression(`location.pathname + location.hash === "/a"`), true);
    assert.equal(isRouteExpression(`location.pathname === "/a"`), true);
    assert.equal(isRouteExpression(`location.href === "https://x.test/a"`), true);
    assert.equal(isRouteExpression(`  location.pathname === "/a"  `), true);
    assert.equal(isRouteExpression(`alert(1)`), false);
  });

  /**
   * The "Route waits" option skips on this predicate, so a false positive silently
   * drops the assertion an imported flow exists to make.
   */
  it("does not claim a hand-written expression as a route assertion", () => {
    for (const expression of [
      `document.getElementById('x').textContent === 'y'`,
      `window.dataLayer.length > 0`,
      `location.pathname !== "/a"`,
      `location.pathname + location.search === "/a"`,
    ]) {
      assert.equal(isRouteExpression(expression), false, `matched: ${expression}`);
    }
  });

  it("is false for a step carrying no expression at all", () => {
    assert.equal(isRouteExpression(undefined), false);
    assert.equal(isRouteExpression(""), false);
  });
});
