/** Browser-side fetch helper: unwraps the API envelope, throws a usable message. */

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: string }
    | null;

  if (!payload) {
    throw new Error(`${path} returned a non-JSON response (${response.status})`);
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
