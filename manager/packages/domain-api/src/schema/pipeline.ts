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

export const jobKindSchema = z.enum(["flink", "airflow", "cdc"]).openapi("PipelineJobKind");
export const jobRunResultSchema = z.enum(["running", "succeeded", "failed", "unknown"]).openapi("PipelineJobRunResult");

// 이슈 #16: Manager는 orchestration engine을 대체하지 않으므로 Job은 upstream(Flink/
// Airflow/CDC)이 보고한 실행 상태의 읽기 전용 투영이다. failureReason은 실패한 실행에서만
// 의미가 있고, relatedResourceIds는 Resource(k8s) drill-down용 id 참조다(존재 검증은
// discovery 레이어 책임).
export const pipelineJobSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "job-flink-orders-sync" }),
    name: z.string().min(1).openapi({ example: "orders-sync" }),
    kind: jobKindSchema,
    serviceId: z.string().min(1).openapi({ example: "svc-flink" }),
    lastRun: z
      .object({
        result: jobRunResultSchema,
        startedAt: z.iso.datetime().openapi({ example: "2026-09-21T05:00:00.000Z" }),
        finishedAt: z.iso.datetime().nullable().openapi({ example: "2026-09-21T05:10:00.000Z" }),
        failureReason: z.string().min(1).nullable().openapi({ example: "Checkpoint timeout" }),
      })
      .nullable(),
    relatedResourceIds: z.array(z.string().min(1)).openapi({ example: ["k8s-workload-flink"] }),
  })
  .openapi("PipelineJob");

// 이슈 #35: 서비스 경계를 넘는 correlation을 암묵적 stage 순서가 아니라 타입이 있는
// 명시적 링크로 표현한다. 4개 쌍(Kafka topic->Flink job, Flink job->Iceberg table,
// Iceberg table->Trino catalog, Airflow DAG->job)이 relation으로 고정되며, 추정된 링크는
// confidence/method/evidence를 항상 함께 싣는다(architecture.md 원칙 6).
export const correlationEntityKindSchema = z
  .enum(["kafka-topic", "flink-job", "iceberg-table", "trino-catalog", "airflow-dag"])
  .openapi("CorrelationEntityKind");

export const correlationRelationSchema = z
  .enum(["topic-feeds-job", "job-writes-table", "table-served-by-catalog", "dag-triggers-job"])
  .openapi("CorrelationRelation");

export const correlationMethodSchema = z
  .enum(["declared-label", "name-convention", "ambiguous-name-convention"])
  .openapi("CorrelationMethod");

export const correlationEntityRefSchema = z
  .object({
    kind: correlationEntityKindSchema,
    id: z.string().min(1).openapi({ example: "topic-orders-cdc" }),
  })
  .openapi("CorrelationEntityRef");

export const correlationLinkSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "topic-feeds-job:topic-orders-cdc->job-flink-orders-sync" }),
    source: correlationEntityRefSchema,
    target: correlationEntityRefSchema,
    relation: correlationRelationSchema,
    confidence: z.number().min(0).max(1).openapi({ example: 0.95 }),
    method: correlationMethodSchema,
    evidence: z.array(z.string().min(1)).openapi({ example: ["label beluga.io/source-topic=orders.cdc"] }),
  })
  .openapi("PipelineCorrelationLink");

export const pipelineSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "pl-lakehouse-ingest" }),
    name: z.string().min(1).openapi({ example: "Kafka to Iceberg Lakehouse Ingest" }),
    stages: z.array(pipelineStageSchema),
    // 기존 소비자를 깨지 않도록 입력에서는 생략 가능, 출력에서는 항상 배열.
    jobs: z.array(pipelineJobSchema).default([]),
    // jobs와 같이 입력에서는 생략 가능, 출력에서는 항상 배열(하위 호환).
    correlationLinks: z.array(correlationLinkSchema).default([]),
    status: healthStatusSchema,
    correlation: pipelineCorrelationSchema,
    lastUpdatedAt: z.iso.datetime().openapi({ example: "2026-09-21T00:00:00.000Z" }),
  })
  .openapi("Pipeline");

export type PipelineStage = z.infer<typeof pipelineStageSchema>;
export type PipelineCorrelation = z.infer<typeof pipelineCorrelationSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
export type PipelineJob = z.infer<typeof pipelineJobSchema>;
export type CorrelationEntityKind = z.infer<typeof correlationEntityKindSchema>;
export type CorrelationRelation = z.infer<typeof correlationRelationSchema>;
export type CorrelationLink = z.infer<typeof correlationLinkSchema>;
