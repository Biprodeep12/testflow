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

export const saveFlowSchema = z.object({
  title: z.string().min(1).max(200),
  sourceUrl: z.string().max(2000).optional(),
  /** native DevTools flow-level wait budget; @puppeteer/replay clamps to <=30s */
  timeout: z.number().int().min(500).max(30000).optional(),
  steps: z.array(flowStepSchema).min(1).max(5000),
});

export const patchFlowSchema = z.object({
  title: z.string().min(1).max(200),
});
