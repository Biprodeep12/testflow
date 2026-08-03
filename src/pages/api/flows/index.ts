import type { NextApiRequest } from "next";
import {
  allowMethods,
  parseBody,
  queryNumber,
  route,
  sendErr,
  sendOk,
  type ApiRes,
} from "@/lib/api";
import { flowsRef, toStored } from "@/lib/flows";
import { canAccess, requireUser } from "@/lib/auth-server";
import { saveFlowSchema } from "@/lib/validate";
import type { FlowDoc } from "@/types/flow";

/** A recording only reaches Firestore here — on an explicit save. ~1MB doc cap. */
const MAX_BYTES = 900_000;

export default route(async (req: NextApiRequest, res: ApiRes) => {
  if (!allowMethods(req, res, ["GET", "POST"])) return;

  const caller = await requireUser(req, res);
  if (!caller) return; // 401 already sent

  if (req.method === "GET") {
    const limit = Math.min(Math.max(queryNumber(req, "limit", 50), 1), 200);
    // Ordered in memory, not by Firestore.
    //
    // `where(uid) + orderBy(updatedAt)` is a composite query, and Firestore
    // refuses those until a matching index exists — the dashboard would 500
    // on first load with a console link as the only clue. The result set here
    // is capped at 200 documents, so sorting locally costs nothing measurable
    // and the feature needs no manual console step to work.
    const snap = await flowsRef().orderBy("updatedAt", "desc").limit(200).get();
    const flows = snap.docs
      // List view: metadata only — steps stay serialized and unparsed here.
      .map((doc) => {
        const data = doc.data() as Omit<FlowDoc, "steps"> & { uid?: string };
        return {
          id: doc.id,
          uid: data.uid,
          title: data.title,
          sourceUrl: data.sourceUrl,
          stepCount: data.stepCount,
          updatedAt: data.updatedAt,
          createdAt: data.createdAt,
        };
      })
      .filter((flow) => canAccess(flow.uid, caller))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit)
      // uid is an ownership detail — it decided the filter above and has no
      // business in the response.
      .map((flow) => ({
        id: flow.id,
        title: flow.title,
        sourceUrl: flow.sourceUrl,
        stepCount: flow.stepCount,
        updatedAt: flow.updatedAt,
        createdAt: flow.createdAt,
      }));
    return sendOk(res, { flows });
  }

  const body = parseBody(req, res, saveFlowSchema);
  if (!body) return;

  const size = JSON.stringify([body.steps, body.meta ?? [], body.env ?? {}]).length;
  if (size > MAX_BYTES) {
    return sendErr(
      res,
      413,
      `This flow is ${(size / 1024).toFixed(0)} kB — over Firestore's document limit. ` +
        `Use "Download JSON" instead, or split the recording.`,
    );
  }

  const firstNav = body.steps.find(
    (step) => (step as { type: string; url?: string }).type === "navigate",
  ) as { url?: string } | undefined;

  const now = Date.now();
  const ref = flowsRef().doc();
  // toStored serializes steps to a JSON string — Firestore rejects the raw
  // string[][] selector groups as "invalid nested entity" (no array-in-array).
  await ref.set(
    toStored({
      uid: caller.uid,
      title: body.title,
      steps: body.steps as FlowDoc["steps"],
      // Sidecars: what makes the replay look like the recording rather than merely
      // perform the same actions.
      meta: body.meta as FlowDoc["meta"],
      env: body.env as FlowDoc["env"],
      sourceUrl: body.sourceUrl ?? firstNav?.url ?? "",
      stepCount: body.steps.length,
      timeout: body.timeout ?? 5000,
      createdAt: now,
      updatedAt: now,
    }),
  );
  sendOk(res, { flowId: ref.id }, 201);
});
