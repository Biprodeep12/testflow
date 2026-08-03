/**
 * Server-side auth: turns the Authorization header into a verified uid.
 *
 * Gated by the SAME env signal as the client (firebase-client.ts), so the two
 * can never disagree about whether a request should have carried a token. With
 * auth off, every request runs as the anonymous local user and the dashboard
 * behaves exactly as it did before auth existed.
 *
 * NEXT_PUBLIC_* vars are readable on the server too, which is what lets one
 * flag drive both sides.
 */

import type { NextApiRequest } from "next";
import { adminApp, FirebaseNotConfiguredError } from "./firebase-admin";
import { sendErr, type ApiRes } from "./api";

export const authEnabled = Boolean(
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
);

/**
 * Owner recorded on flows created while auth is switched off. It is a real
 * stored value rather than an absent field so that turning auth ON later does
 * not make every existing flow look like it belongs to nobody.
 */
export const LOCAL_UID = "local";

export type Caller = { uid: string; email?: string };

/**
 * The verified caller, or null when the request should be rejected (the
 * response has already been sent in that case).
 */
export async function requireUser(
  req: NextApiRequest,
  res: ApiRes,
): Promise<Caller | null> {
  if (!authEnabled) return { uid: LOCAL_UID };

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    sendErr(res, 401, "Sign in to continue.");
    return null;
  }

  /*
   * Imported HERE, not at module scope, and deliberately outside the try below.
   *
   * `firebase-admin/auth` eagerly pulls in jwks-rsa -> jose, and jose is ESM —
   * so on a Node without require(esm) this import throws. As a top-level
   * import that threw while the ROUTE MODULE was being evaluated, which no
   * handler can catch: Next answered with an HTML error page and the client
   * could only report "the server returned an error page". Loading it here
   * means the route module always evaluates, so a broken runtime arrives as a
   * JSON 500 naming the real error instead of an opaque page.
   *
   * Outside the try because a module that will not load is not an expired
   * session; it must reach route(), not become a 401.
   */
  const { getAuth } = await import("firebase-admin/auth");

  try {
    // Verifies signature, issuer, audience AND expiry against Google's public
    // keys — a client-decoded uid would be trivially forgeable.
    const decoded = await getAuth(adminApp()).verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email };
  } catch (err) {
    // A server with no service account is not an expired session. Swallowing
    // that into a 401 told everyone to sign in again on a deployment that
    // could never have accepted the token — let it reach route(), which
    // answers 503 naming the missing variables.
    if (err instanceof FirebaseNotConfiguredError) throw err;
    sendErr(res, 401, "Your session expired. Sign in again.");
    return null;
  }
}

/**
 * May this caller touch this flow?
 *
 * Flows saved before auth was switched on carry `uid: "local"` or no uid at
 * all. They are readable by any signed-in user ON PURPOSE — the alternative is
 * that enabling auth makes your existing recordings vanish, which looks
 * exactly like data loss. New flows are always owned.
 */
export function canAccess(flowUid: string | undefined, caller: Caller): boolean {
  if (!flowUid || flowUid === LOCAL_UID) return true;
  return flowUid === caller.uid;
}
