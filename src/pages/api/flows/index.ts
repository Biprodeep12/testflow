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
import { saveFlowSchema } from "@/lib/validate";
import type { FlowDoc } from "@/types/flow";

/** A recording only reaches Firestore here — on an explicit save. ~1MB doc cap. */
const MAX_BYTES = 900_000;

export default route(async (req: NextApiRequest, res: ApiRes) => {
  if (!allowMethods(req, res, ["GET", "POST"])) return;

  if (req.method === "GET") {
    const limit = Math.min(Math.max(queryNumber(req, "limit", 50), 1), 200);
    const snap = await flowsRef().orderBy("updatedAt", "desc").limit(limit).get();
    // List view: metadata only — steps stay serialized and unparsed here.
    const flows = snap.docs.map((doc) => {
      const data = doc.data() as Omit<FlowDoc, "steps">;
      return {
        id: doc.id,
        title: data.title,
        sourceUrl: data.sourceUrl,
        stepCount: data.stepCount,
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
      };
    });
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
