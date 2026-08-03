/**
 * Selector durability — the string-only half of the recorder's selector engine.
 *
 * These decide whether a selector is worth building on, and they are what the
 * "fragile" chip is computed from. They live here rather than in the content
 * script for the same reason `expressions.ts` does: they are pure functions over
 * strings, and a browser is a poor place to test a pure function over strings.
 *
 * The DOM-dependent half — walking for an anchor, evaluating candidates — stays in
 * extension/src/content/recorder.ts, where it can see a document.
 */

/**
 * An id a human wrote, as opposed to one a framework minted this render.
 *
 * React's useId produces ":r3:"/":R2m:", component libraries produce prefixed
 * counters, and build tools produce hashes — all of which differ on the next
 * render or the next build. `#\:r3\:` resolves perfectly today and is worth
 * nothing tomorrow, so a path anchored to one is positional dressed up as durable.
 */
export function isStableId(id: string): boolean {
  if (!id || id.length > 60) return false;
  if (id.includes(":")) return false; // React useId
  if (/^\d/.test(id)) return false; // not a hand-written identifier
  if (/^(mui|radix|headlessui|ember|react-aria|rc|chakra)[-_]/i.test(id)) return false;
  if (/^[0-9a-f]{8,}$/i.test(id)) return false; // hash
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(id)) return false; // uuid
  return true;
}

/**
 * A class name worth putting in a selector.
 *
 * Only the obviously-generated ones are rejected: CSS-in-JS (`css-1x2y3z`),
 * hashes, and CSS-modules suffixes. Utility classes (`flex`, `px-4`) are left
 * alone deliberately — they are stable STRINGS, they are just shared by half the
 * page, and the recorder's `resolvesTo` gate already rejects a selector they
 * cannot pin down. Filtering them by name would mean guessing which of `card` and
 * `flex` is semantic, which is not a decision a regex can make.
 */
export function isStableClass(name: string): boolean {
  if (!name || name.length > 50) return false;
  if (/^(css|sc|emotion|jsx|styled)-/.test(name)) return false;
  if (/^[0-9a-f]{6,}$/i.test(name)) return false;
  if (/__[a-z0-9]{4,}$/i.test(name)) return false; // Button_root__a1b2c
  return true;
}

/** Does this single token carry a handle a person put there on purpose? */
export function isDurableToken(token: string): boolean {
  if (/\[(data-|aria-label|name=|placeholder=)/.test(token)) return true;
  const id = /^#((?:[^\s>~+\\]|\\.)+)/.exec(token)?.[1];
  return id ? isStableId(id.replace(/\\(.)/g, "$1")) : false;
}

/**
 * Is this selector rooted in something durable?
 *
 * The question is about the ROOT, not the whole string. Testing the whole string
 * would credit `div:nth-of-type(2) > [data-x]` — a positional path that happens to
 * end somewhere nice, and which breaks the moment its prefix shifts. An anchored
 * path is durable precisely because the durable part comes first and everything
 * after it is local to that anchor.
 */
export function hasDurableRoot(selector: string): boolean {
  if (selector.startsWith("aria/") || selector.startsWith("text/")) return true;
  if (selector.startsWith("xpath/") || selector.startsWith("pierce/")) return false;
  // `tag:has(> handle)` inverts the shape: the element is named by what it
  // contains, so the handle IS the claim even though it is not the leading token.
  if (selector.includes(":has(")) return isDurableToken(selector);
  return isDurableToken(selector.split(/\s*[>~+]\s*|\s+/, 1)[0] ?? "");
}

/**
 * True when the element offered nothing but its position in the tree — no test id,
 * no accessible name, no stable attribute, and no durable ancestor or child to hang
 * a relative path off. Such a step replays correctly today and breaks on the next
 * markup change, so the recording says so rather than letting replay discover it.
 *
 * `some`, not a per-selector `every`: ONE durable description anywhere in the list
 * is enough, because consensus resolution can outvote the stale positional ones.
 */
export function isPositionalOnly(selectors: string[][]): boolean {
  return !selectors.some((group) => hasDurableRoot(group[0] ?? ""));
}
