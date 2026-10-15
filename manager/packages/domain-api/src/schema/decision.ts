import { z } from "@hono/zod-openapi";
import { abstainCodeSchema, decisionSchema } from "../decision/types.js";

export const decisionRecordSchema = z.object({
  id: z.string().min(1),
  snapshotId: z.string().min(1),
  correlationId: z.string().min(1),
  evaluatedAt: z.iso.datetime(),
  result: z.object({
    decision: decisionSchema,
    confidence: z.number().min(0).max(1),
    abstained: z.boolean(),
    abstainCode: abstainCodeSchema.optional(),
    abstainReason: z.string().min(1).optional(),
    provider: z.string().min(1),
    providerVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    decidedAt: z.iso.datetime(),
    evidenceRefs: z.array(z.object({
      source: z.string().min(1),
      observedAt: z.iso.datetime(),
      ingestedAt: z.iso.datetime(),
      freshnessDeadline: z.iso.datetime(),
      contentHash: z.string().min(1),
    })),
    // This read projection omits wall-clock latency so fixture responses stay deterministic.
  }),
  inputSignals: z.array(z.object({
    name: z.string().min(1),
    observedAt: z.iso.datetime(),
    freshAtEvaluation: z.boolean(),
  })),
  freshnessPolicy: z.object({ maxAgeMs: z.number().nonnegative() }),
  relatedResourceId: z.string().min(1).nullable(),
  relatedServiceId: z.string().min(1).nullable(),
  relatedPipelineId: z.string().min(1).nullable(),
}).openapi("DecisionRecord");

export const decisionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  decision: decisionSchema.optional(),
});

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
