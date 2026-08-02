/**
 * The element resolver — ONE implementation, two consumers.
 *
 * The extension's content script imports `resolveInPage` and calls it directly.
 * The Playwright runner ships the SAME function into the page as source text via
 * `pageExpr()`. That is the point: replay in the browser and replay in Playwright
 * must agree on which element a step refers to, and two implementations would
 * eventually disagree.
 *
 * CONSTRAINT: `resolveInPage` must stay self-contained — no imports, no module-scope
 * references, everything nested. It is serialized with `toString()`.
 */

export type ResolvePayload = {
  /** DevTools selector groups, most-durable first */
  selectors: string[][];
};

/**
 * Consensus resolution: every group is resolved, and the element MOST groups agree
 * on wins — a stale positional path that now points at the wrong element is outvoted
 * by aria/testid/text still agreeing on the right one. First-match-wins can't do that.
 *
 * Nested hits (one group finds the <button>, another its inner <span>) count as
 * agreement — the click bubbles either way — and the bucket keeps the deeper element,
 * matching what was actually recorded. Ties break toward the earlier (more durable)
 * group.
 */
export function resolveInPage(payload: ResolvePayload): Element | null {
  const norm = (t: string | null | undefined): string =>
    (t ?? "").replace(/\s+/g, " ").trim();

  // Deliberate copy of the recorder's accessible-name approximation: this function
  // is serialized into the page, so it cannot import one. Keep the two in step.
  const accName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (norm(aria)) return norm(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (norm(text)) return norm(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = norm(labels[0].textContent);
      if (text) return text;
    }
    for (const attr of ["alt", "title", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (norm(value)) return norm(value);
    }
    const text = norm(el.textContent);
    return text && text.length <= 60 ? text : "";
  };

  const deepQuery = (selector: string, root: ParentNode): Element | null => {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch {
      return null;
    }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      if (node.shadowRoot) {
        const found = deepQuery(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };

  const byAria = (name: string): Element | null => {
    const nodes = document.querySelectorAll(
      "button,a,input,select,textarea,summary,label,[role],[aria-label],[tabindex],h1,h2,h3,h4,svg,img",
    );
    for (const node of nodes) if (accName(node) === name) return node;
    return null;
  };

  const byText = (prefix: string): Element | null => {
    let best: Element | null = null;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (const node of all) {
      const text = norm(node.textContent);
      if (text && text.startsWith(prefix)) {
        if (!best || (node.textContent ?? "").length < (best.textContent ?? "").length) {
          best = node; // innermost match
        }
      }
    }
    return best;
  };

  const resolveOne = (selector: string): Element | null => {
    try {
      if (selector.startsWith("aria/")) return byAria(selector.slice(5));
      if (selector.startsWith("xpath/"))
        return document.evaluate(
          selector.slice(6),
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue as Element | null;
      if (selector.startsWith("pierce/")) return deepQuery(selector.slice(7), document);
      if (selector.startsWith("text/")) return byText(selector.slice(5));
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const buckets: { el: Element; votes: number; firstIndex: number }[] = [];
  (payload.selectors || []).forEach((group, index) => {
    const el = group && group[0] ? resolveOne(group[0]) : null;
    if (!el) return;
    const related = buckets.find(
      (bucket) => bucket.el === el || bucket.el.contains(el) || el.contains(bucket.el),
    );
    if (related) {
      related.votes++;
      if (related.el.contains(el) && related.el !== el) related.el = el; // keep deeper
    } else {
      buckets.push({ el, votes: 1, firstIndex: index });
    }
  });

  if (buckets.length === 0) return null;
  buckets.sort((a, b) => b.votes - a.votes || a.firstIndex - b.firstIndex);
  return buckets[0].el;
}

/**
 * Builds an evaluatable source string for a self-contained function.
 *
 * The `__name` shim is not decoration: esbuild/tsx compile with `keepNames`, which
 * wraps nested function declarations in `__name(fn, "fn")`. That helper exists in the
 * bundle's scope but NOT in the page, so a naively serialized function throws
 * ReferenceError the moment it runs. Defining it as identity restores the original
 * semantics exactly.
 */
export function pageExpr<A, R>(fn: (arg: A) => R, arg: A): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg)}); })()`;
}
