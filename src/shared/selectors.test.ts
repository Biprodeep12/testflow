import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasDurableRoot,
  isPositionalOnly,
  isStableClass,
  isStableId,
} from "./selectors";

test("isStableId accepts hand-written ids", () => {
  for (const id of ["checkout", "cart-list", "main_nav", "step2"]) {
    assert.equal(isStableId(id), true, id);
  }
});

test("isStableId rejects framework-minted ids", () => {
  for (const id of [
    ":r3:", // React useId
    ":R2m:",
    "mui-1234",
    "radix-:r0:",
    "headlessui-menu-1",
    "chakra-modal-2",
    "deadbeefcafe", // hash
    "3f2b1a9c-1122-4d3e-9f77-aabbccddeeff", // uuid
    "42", // leading digit
    "",
  ]) {
    assert.equal(isStableId(id), false, id);
  }
});

test("isStableClass rejects generated names, keeps utility ones", () => {
  for (const name of ["css-1x2y3z", "sc-bdVaJa", "emotion-9kl2", "Button_root__a1b2c", "a1b2c3d4"]) {
    assert.equal(isStableClass(name), false, name);
  }
  // Utility classes are stable strings; uniqueness is `resolvesTo`'s problem.
  for (const name of ["btn", "card", "flex", "px-4", "items-center"]) {
    assert.equal(isStableClass(name), true, name);
  }
});

test("hasDurableRoot credits the root, not the tail", () => {
  assert.equal(hasDurableRoot('[data-testid="cart"] > div:nth-of-type(2)'), true);
  assert.equal(hasDurableRoot('[aria-label="Cart"] div'), true);
  assert.equal(hasDurableRoot("#checkout > div > span"), true);
  assert.equal(hasDurableRoot('input[name="email"]'), true);

  // A positional path that merely ENDS somewhere nice is still positional: the
  // prefix is what breaks, and it is unchanged by the tail.
  assert.equal(hasDurableRoot('div:nth-of-type(2) > [data-testid="x"]'), false);
  assert.equal(hasDurableRoot("div:nth-of-type(2) > ul > li"), false);
  assert.equal(hasDurableRoot("button.btn.btn-lg"), false);
});

test("hasDurableRoot rejects a generated-id root", () => {
  assert.equal(hasDurableRoot("#\\:r3\\: > div"), false);
  assert.equal(hasDurableRoot("#mui-1234 > div"), false);
});

test("hasDurableRoot reads :has() as a whole", () => {
  assert.equal(hasDurableRoot('div:has(> [data-testid="icon-cart"])'), true);
  assert.equal(hasDurableRoot('div:has([aria-label="Remove"])'), true);
  assert.equal(hasDurableRoot("div:has(> span.icon)"), false);
});

test("hasDurableRoot: engine prefixes", () => {
  assert.equal(hasDurableRoot("aria/Check out"), true);
  assert.equal(hasDurableRoot("text/Continue"), true);
  assert.equal(hasDurableRoot("xpath//html/body/div[2]/button"), false);
  assert.equal(hasDurableRoot("pierce/div > button"), false);
});

test("isPositionalOnly needs one durable group, not all of them", () => {
  // The shape that earns the fragile chip.
  assert.equal(
    isPositionalOnly([
      ["div:nth-of-type(2) > ul > li:nth-of-type(7) > button"],
      ["xpath//html/body/div[2]/ul/li[7]/button"],
      ["pierce/div:nth-of-type(2) > ul > li:nth-of-type(7) > button"],
    ]),
    true,
  );

  // One anchored group is enough — consensus outvotes the stale positional ones.
  assert.equal(
    isPositionalOnly([
      ["div:nth-of-type(2) > ul > li:nth-of-type(7) > button"],
      ["xpath//html/body/div[2]/ul/li[7]/button"],
      ['[data-testid="cart-list"] > li:nth-of-type(7) > button'],
    ]),
    false,
  );

  assert.equal(isPositionalOnly([]), true);
});

test("isPositionalOnly: a stable id no longer counts as positional", () => {
  // Regression: `#checkout` was reported fragile because the check pattern-matched
  // for `[data-`/`aria/` and nothing else.
  assert.equal(isPositionalOnly([["#checkout"]]), false);
  assert.equal(isPositionalOnly([["#\\:r3\\:"]]), true);
});
