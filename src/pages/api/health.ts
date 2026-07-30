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

  sendOk(res, { firebase, firestore, error });
});
