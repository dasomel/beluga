import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";
import { serviceTypeSchema } from "./service.js";

export const pipelineStageSchema = z
  .object({
    serviceId: z.string().min(1).openapi({ example: "svc-kafka" }),
    serviceType: serviceTypeSchema,
    status: healthStatusSchema,
    detail: z.string().min(1).nullable().openapi({ example: "Under-replicated partitions detected" }),
  })
  .openapi("PipelineStage");

// architecture.md 원칙 6(Explicit correlation): 추정된 관계를 사실처럼 제시하지 않는다.
// confidence/method를 선택적 부가 정보가 아니라 Pipeline의 필수 필드로 고정해, 이
// correlation이 명시적으로 선언된 것인지("declared") 추론된 것인지("inferred")를 항상
// 함께 반환하도록 강제한다.
export const pipelineCorrelationSchema = z
  .object({
    confidence: z.number().min(0).max(1).openapi({ example: 0.95 }),
    method: z.string().min(1).openapi({ example: "declared" }),
  })
  .openapi("PipelineCorrelation");

export const pipelineSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "pl-lakehouse-ingest" }),
    name: z.string().min(1).openapi({ example: "Kafka to Iceberg Lakehouse Ingest" }),
    stages: z.array(pipelineStageSchema),
    status: healthStatusSchema,
    correlation: pipelineCorrelationSchema,
    lastUpdatedAt: z.iso.datetime().openapi({ example: "2026-09-21T00:00:00.000Z" }),
  })
  .openapi("Pipeline");

export type PipelineStage = z.infer<typeof pipelineStageSchema>;
export type PipelineCorrelation = z.infer<typeof pipelineCorrelationSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
