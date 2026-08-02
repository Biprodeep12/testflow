/** zod schemas for request bodies. */

import { z } from "zod";

/**
 * Flows — DevTools Recorder format. Steps are kept loose on purpose: the format
 * belongs to DevTools, and rejecting a field it adds tomorrow would be a bug here.
 */
const flowStepSchema = z.looseObject({
  type: z.enum([
    "setViewport",
    "navigate",
    "click",
    "doubleClick",
    "change",
    "keyDown",
    "keyUp",
    "scroll",
    "waitForElement",
    "waitForExpression",
    "wheel", // TestFlow extension: consumed wheel input (map zoom etc.)
    "drag", // TestFlow extension: pointer drag (map pan, sliders, reorder)
  ]),
});

/**
 * TestFlow sidecars. Loose for the same reason the steps are — these describe a
 * browser environment that gains fields faster than a schema can, and dropping one
 * silently would cost fidelity nobody could then explain.
 */
const stepMetaSchema = z.looseObject({
  targetId: z.string().max(32),
  frameChain: z.array(z.looseObject({ index: z.number().int().min(0) })).max(20),
  tMono: z.number(),
});

export const saveFlowSchema = z.object({
  title: z.string().min(1).max(200),
  sourceUrl: z.string().max(2000).optional(),
  /** native DevTools flow-level wait budget; @puppeteer/replay clamps to <=30s */
  timeout: z.number().int().min(500).max(30000).optional(),
  steps: z.array(flowStepSchema).min(1).max(5000),
  /** one entry per step, same index — replay's targeting and pacing inputs */
  meta: z.array(stepMetaSchema).max(5000).optional(),
  /** the recording environment: viewport, DPR, fonts, locale, timezone */
  env: z.looseObject({}).optional(),
});

export const patchFlowSchema = z.object({
  title: z.string().min(1).max(200),
});
