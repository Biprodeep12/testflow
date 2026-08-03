import { allowMethods, route, sendOk, type ApiRes } from "@/lib/api";
import { firebaseConfigStatus, getDb } from "@/lib/firebase-admin";
import type { NextApiRequest } from "next";

/** Setup check: is Firebase reachable? (Only needed for saving flows.) */
export default route(async (req: NextApiRequest, res: ApiRes) => {
  if (!allowMethods(req, res, ["GET"])) return;

  const firebase = firebaseConfigStatus();
  let firestore: "ok" | "error" | "not-configured" = "not-configured";
  let error: string | null = null;

  if (firebase.configured) {
    try {
      await getDb().collection("flows").limit(1).get();
      firestore = "ok";
    } catch (err) {
      firestore = "error";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  sendOk(res, { firebase, firestore, error, ...(await runtime()) });
});

/**
 * The two facts that decide whether signed-in requests can work at all, on the
 * one route that answers even when everything else is broken.
 *
 * `firebase-admin/auth` pulls in jwks-rsa -> jose, and jose is ESM-only. A host
 * running Node below 20.19/22.12 cannot require() it, so every authenticated
 * route dies on import while `/api/health` — which reaches the module only
 * from inside this try — keeps answering. Without this, that failure is
 * invisible until someone signs in, and the deployed Node version is
 * unknowable from outside the build logs.
 */
async function runtime(): Promise<{
  node: string;
  adminAuth: "ok" | "error";
  adminAuthError: string | null;
}> {
  try {
    await import("firebase-admin/auth");
    return { node: process.version, adminAuth: "ok", adminAuthError: null };
  } catch (err) {
    return {
      node: process.version,
      adminAuth: "error",
      adminAuthError: err instanceof Error ? err.message : String(err),
    };
  }
}
