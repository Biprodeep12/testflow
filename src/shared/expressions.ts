/**
 * The assertions the recorder writes, evaluated WITHOUT eval.
 *
 * Most real sites ship a Content-Security-Policy without `unsafe-eval`, and a page
 * under one refuses to evaluate any string as code — so `new Function(...)` inside
 * the page simply does not run there. That would make every recorded SPA route
 * assertion fail on the sites people actually record.
 *
 * The assertions the recorder generates are not arbitrary code, though: they are a
 * few known shapes about `location`, and comparing those needs no evaluator at all.
 * This handles those; anything hand-written still needs a real one (the debugger
 * protocol, which is not page script and not subject to the page's CSP).
 */

/** How the recorder writes a route assertion. Keep in step with the service worker. */
const FORMS: { pattern: RegExp; actual: () => string }[] = [
  {
    pattern: /^location\.pathname \+ location\.hash === ("(?:[^"\\]|\\.)*")$/,
    actual: () => location.pathname + location.hash,
  },
  {
    pattern: /^location\.pathname === ("(?:[^"\\]|\\.)*")$/,
    actual: () => location.pathname,
  },
  {
    pattern: /^location\.href === ("(?:[^"\\]|\\.)*")$/,
    actual: () => location.href,
  },
];

/**
 * True/false when this is one of the recorder's own assertions, undefined when it is
 * something else and a real evaluator is required.
 *
 * `read` exists so this is testable without a browser: it defaults to the live
 * `location`, and tests pass a stub.
 */
export function evaluateKnownExpression(
  expression: string,
  read?: (kind: "pathname" | "hash" | "href") => string,
): boolean | undefined {
  const value = (index: number): string => {
    if (!read) return FORMS[index].actual();
    if (index === 0) return read("pathname") + read("hash");
    if (index === 1) return read("pathname");
    return read("href");
  };

  for (let i = 0; i < FORMS.length; i++) {
    const match = FORMS[i].pattern.exec(expression.trim());
    if (!match) continue;
    try {
      return value(i) === (JSON.parse(match[1]) as string);
    } catch {
      return undefined; // malformed literal — let the real evaluator decide
    }
  }
  return undefined;
}

/**
 * Is this one of the recorder's own route assertions?
 *
 * Two callers, same question. Under a CSP it means "answerable without an
 * evaluator"; for the "Route waits" run option it means "this step exists only
 * because an SPA changed `location`, so turning route waits off may skip it".
 * Deliberately narrower than `type === "waitForExpression"` — a flow imported from
 * DevTools can carry a hand-written expression that is the point of the test, and
 * that one is never dropped.
 */
export function isRouteExpression(expression: string | undefined): boolean {
  if (!expression) return false;
  const trimmed = expression.trim();
  return FORMS.some((form) => form.pattern.test(trimmed));
}
