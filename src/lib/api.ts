/** Shared plumbing for every API route: envelope, method guard, body validation. */

import type { NextApiRequest, NextApiResponse } from "next";
import type { ZodType } from "zod";
import { FirebaseNotConfiguredError } from "./firebase-admin";

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** Every handler responds with the same envelope, so the payload type is open. */
export type ApiRes = NextApiResponse<ApiResponse<unknown>>;

export function sendOk<T>(res: ApiRes, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function sendErr(res: ApiRes, status: number, error: string): void {
  res.status(status).json({ ok: false, error });
}

/** Returns false (and responds 405) when the method isn't allowed. */
export function allowMethods(
  req: NextApiRequest,
  res: ApiRes,
  methods: string[],
): boolean {
  if (!methods.includes(req.method ?? "")) {
    res.setHeader("Allow", methods.join(", "));
    sendErr(res, 405, `Method ${req.method ?? "?"} not allowed`);
    return false;
  }
  return true;
}

/** Parses+validates the body. Responds 400 and returns null on failure. */
export function parseBody<T>(
  req: NextApiRequest,
  res: ApiRes,
  schema: ZodType<T>,
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    sendErr(res, 400, `Invalid request body — ${detail}`);
    return null;
  }
  return result.data;
}

/** Reads a `[id]`-style route param as a plain string. */
export function routeParam(
  req: NextApiRequest,
  name: string,
): string | undefined {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

export function queryNumber(
  req: NextApiRequest,
  name: string,
  fallback: number,
): number {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Wraps a handler so a thrown error becomes a clean JSON envelope instead of an
 * HTML error page — the runner and the dashboard both parse JSON unconditionally.
 */
export function route(
  handler: (req: NextApiRequest, res: ApiRes) => unknown | Promise<unknown>,
) {
  return async (req: NextApiRequest, res: ApiRes): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof FirebaseNotConfiguredError) {
        if (!res.headersSent) sendErr(res, 503, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendErr(res, 500, message);
    }
  };
}

export const DEFAULT_PROJECT_ID = "default";
