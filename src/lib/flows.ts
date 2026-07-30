/**
 * Flow storage.
 *
 * Firestore rejects arrays nested directly inside arrays ("invalid nested entity"),
 * and DevTools selector groups are exactly that — `selectors: string[][]`. So steps
 * are stored as ONE JSON string field and rehydrated on read; every API response and
 * the UI still speak the exact DevTools shape.
 */

import { getDb } from "./firebase-admin";
import type { FlowDoc, FlowStep } from "@/types/flow";

/** What actually sits in Firestore. */
type StoredFlow = Omit<FlowDoc, "id" | "steps"> & { stepsJson: string };

export function flowsRef() {
  return getDb().collection("flows");
}

export function toStored(
  flow: Omit<FlowDoc, "id" | "steps"> & { steps: FlowStep[] },
): StoredFlow {
  const { steps, ...rest } = flow;
  return { ...rest, stepsJson: JSON.stringify(steps) };
}

export function fromSnapshot(
  doc: FirebaseFirestore.DocumentSnapshot,
): FlowDoc {
  const data = doc.data() as Partial<StoredFlow> & { steps?: FlowStep[] };
  const steps: FlowStep[] =
    data.steps ?? (data.stepsJson ? (JSON.parse(data.stepsJson) as FlowStep[]) : []);
  return {
    id: doc.id,
    title: data.title ?? "flow",
    sourceUrl: data.sourceUrl ?? "",
    stepCount: data.stepCount ?? steps.length,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
    timeout: data.timeout,
    steps,
  };
}
