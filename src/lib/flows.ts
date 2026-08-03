/**
 * Flow storage.
 *
 * Firestore rejects arrays nested directly inside arrays ("invalid nested entity"),
 * and DevTools selector groups are exactly that — `selectors: string[][]`. So steps
 * are stored as ONE JSON string field and rehydrated on read; every API response and
 * the UI still speak the exact DevTools shape.
 */

import { getDb } from "./firebase-admin";
import type { EnvRecord, FlowDoc, FlowStep, StepMeta } from "@/types/flow";

/**
 * What actually sits in Firestore. The step sidecar is serialized for the same
 * reason the steps are: StepMeta.frameChain[].selectors is string[][], another
 * array-in-array Firestore refuses.
 */
type StoredFlow = Omit<FlowDoc, "id" | "steps" | "meta"> & {
  stepsJson: string;
  metaJson?: string;
  /** owner. "local" for flows saved while auth was switched off. */
  uid?: string;
};

export function flowsRef() {
  return getDb().collection("flows");
}

export function toStored(
  flow: Omit<FlowDoc, "id" | "steps" | "meta"> & {
    steps: FlowStep[];
    meta?: StepMeta[];
    uid?: string;
  },
): StoredFlow {
  const { steps, meta, ...rest } = flow;
  // Firestore rejects an explicit `undefined` value outright, and an unsaved flow
  // legitimately has no env (recorded before the field existed, or imported JSON).
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as Omit<StoredFlow, "stepsJson" | "metaJson">;
  return {
    ...defined,
    stepsJson: JSON.stringify(steps),
    ...(meta?.length ? { metaJson: JSON.stringify(meta) } : {}),
  };
}

export function fromSnapshot(
  doc: FirebaseFirestore.DocumentSnapshot,
): FlowDoc {
  const data = doc.data() as Partial<StoredFlow> & {
    steps?: FlowStep[];
    env?: EnvRecord;
  };
  const steps: FlowStep[] =
    data.steps ?? (data.stepsJson ? (JSON.parse(data.stepsJson) as FlowStep[]) : []);
  const meta: StepMeta[] | undefined = data.metaJson
    ? (JSON.parse(data.metaJson) as StepMeta[])
    : undefined;
  return {
    id: doc.id,
    title: data.title ?? "flow",
    sourceUrl: data.sourceUrl ?? "",
    stepCount: data.stepCount ?? steps.length,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
    timeout: data.timeout,
    steps,
    meta,
    env: data.env,
  };
}
