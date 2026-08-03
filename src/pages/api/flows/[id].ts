import type { NextApiRequest } from "next";
import {
  allowMethods,
  parseBody,
  route,
  routeParam,
  sendErr,
  sendOk,
  type ApiRes,
} from "@/lib/api";
import { flowsRef, fromSnapshot } from "@/lib/flows";
import { canAccess, requireUser } from "@/lib/auth-server";
import { patchFlowSchema } from "@/lib/validate";

export default route(async (req: NextApiRequest, res: ApiRes) => {
  if (!allowMethods(req, res, ["GET", "PATCH", "DELETE"])) return;

  const caller = await requireUser(req, res);
  if (!caller) return; // 401 already sent

  const id = routeParam(req, "id");
  if (!id) return sendErr(res, 400, "Missing flow id");

  const ref = flowsRef().doc(id);
  const doc = await ref.get();
  if (!doc.exists) return sendErr(res, 404, "Flow not found");

  // 404, not 403: someone else's flow id should not be confirmable as existing.
  const owner = (doc.data() as { uid?: string } | undefined)?.uid;
  if (!canAccess(owner, caller)) return sendErr(res, 404, "Flow not found");

  if (req.method === "GET") {
    // fromSnapshot rehydrates the JSON-string steps back into DevTools shape.
    return sendOk(res, { flow: fromSnapshot(doc) });
  }

  if (req.method === "DELETE") {
    await ref.delete();
    return sendOk(res, { deleted: true });
  }

  const body = parseBody(req, res, patchFlowSchema);
  if (!body) return;
  await ref.update({ title: body.title, updatedAt: Date.now() });
  sendOk(res, { updated: true });
});
