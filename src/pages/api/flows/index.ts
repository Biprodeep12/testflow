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

/**
 * Take the body-size verdict away from Next's parser and give it to the check
 * below.
 *
 * The parser defaults to 1mb and rejects anything larger from inside Next's own
 * pipeline — plain text, no envelope, before this handler runs. So the friendly
 * "use Download JSON instead" message was unreachable in exactly the case it
 * was written for: a recording too big to store. Anything under this ceiling
 * now reaches the MAX_BYTES check and gets a real JSON 413 explaining itself.
 */
export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

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
    // A PROJECTION, not a full read. Without `select` this pulled whole
    // documents — including `stepsJson`, which is the entire recording and is
    // allowed to be 900 kB each. Rendering a list of titles was therefore
    // transferring up to 200 complete recordings and throwing all of them away
    // two lines below; measured against real data it moved 99.2% more bytes
    // than the response needs. At a few dozen heavy flows that is how a list
    // endpoint starts timing out on a serverless host.
    const snap = await flowsRef()
      .select("uid", "title", "sourceUrl", "stepCount", "updatedAt", "createdAt")
      .orderBy("updatedAt", "desc")
      .limit(200)
      .get();
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
