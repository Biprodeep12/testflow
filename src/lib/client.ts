/** Browser-side fetch helper: unwraps the API envelope, throws a usable message. */

/**
 * Supplies the current Firebase ID token, or null when auth is not configured.
 *
 * Injected by AuthProvider rather than imported, so this module — which every
 * page uses — pulls in no Firebase code when auth is switched off, and the
 * request path stays honest about being optional.
 */
type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  // Asked for per request: tokens expire hourly, and a cached one is exactly
  // the bug that logs you out mid-recording.
  let auth: Record<string, string> = {};
  if (tokenProvider) {
    try {
      const token = await tokenProvider();
      if (token) auth = { authorization: `Bearer ${token}` };
    } catch {
      // Token refresh failed (offline, revoked). Send the request bare and let
      // the server's 401 produce a message, rather than failing silently here.
    }
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...auth,
      ...(init?.headers ?? {}),
    },
  });

  /*
   * Read as text and parse by hand, because the interesting failures are
   * exactly the ones that are NOT our envelope.
   *
   * Next rejects an oversized or malformed body inside its own request
   * pipeline, and a module that throws while being evaluated never reaches a
   * handler at all — in both cases the reply is plain text ("Body exceeded 1mb
   * limit", "Internal Server Error") with no `ok` field. Discarding that body
   * and reporting "non-JSON response (500)" threw away the one line that says
   * what actually went wrong.
   */
  const raw = await response.text();

  let payload: { ok: true; data: T } | { ok: false; error: string } | null = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!payload || typeof payload.ok !== "boolean") {
    // An HTML error page has nothing quotable in its first line, so name the
    // shape instead of pasting markup at the user.
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(raw);
    const detail = looksHtml
      ? "the server returned an error page"
      : raw.trim().split("\n")[0].slice(0, 200) ||
        response.statusText ||
        "no response body";
    throw new Error(`${path} failed (${response.status}): ${detail}`);
  }
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
