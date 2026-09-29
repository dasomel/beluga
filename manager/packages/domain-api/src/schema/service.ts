import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";

export const serviceTypeSchema = z
  .enum(["kafka", "flink", "iceberg", "trino", "airflow", "superset", "kubernetes", "observability"])
  .openapi("ServiceType");

// 이슈 #37: `capabilities`(문자열 배열)는 이미 operation-level capability
// ("query.execute", "catalog.list")를 모델링하지만, 이슈가 예시로 든 상위 Platform
// Capability 분류(Streaming/Processing/Lakehouse/Query/BI/Orchestration/Storage/
// Observability)는 별도 필드가 없었다. 이 closed enum이 그 gap을 메운다 — operation
// capability 목록을 대체하지 않고 그 위에 얹는 분류축이다. 빈 배열은 누락/미분류가
// 아니라 특정 Platform Capability에 속하지 않는 범용 인프라를 뜻한다.
export const capabilityCategorySchema = z
  .enum(["streaming", "processing", "lakehouse", "query", "bi", "orchestration", "storage", "observability"])
  .openapi("CapabilityCategory");

export const serviceKeyMetricSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().min(1).nullable().default(null),
}).openapi("ServiceKeyMetric");

// 이슈 #42의 "하나의 공통 service 모델"을 표현한다: identity/type, version, health,
// endpoint, capabilities, dependency summary. 개별 OSS API 응답 모양을 그대로 노출하지
// 않고 이 형태로 고정한다.
export const serviceSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "svc-trino" }),
    name: z.string().min(1).openapi({ example: "Trino" }),
    type: serviceTypeSchema,
    version: z.string().min(1).nullable().openapi({ example: "483" }),
    status: healthStatusSchema,
    endpoint: z.url().nullable().openapi({ example: "https://trino.local.beluga.internal" }),
    capabilities: z.array(z.string().min(1)).openapi({ example: ["query.execute", "catalog.list"] }),
    // D1: 기존 Service 응답과 소비자가 새 필드를 즉시 제공하도록 강제하지 않는다.
    // 입력에는 기본값을 적용해 출력에서는 항상 배열을 보장한다. 대부분의 서비스는
    // 정확히 하나의 카테고리에 속하지만 배열로 두어 여러 카테고리도 표현할 수 있다.
    capabilityCategories: z.array(capabilityCategorySchema).default([]).openapi({ example: ["query"] }),
    // D3: keep this projection sparse until discovery evidence exists; the cost is blank UI
    // details for unknown services, and live discovery can populate these fields later.
    namespace: z.string().min(1).nullable().default(null).openapi({ example: "data-platform" }),
    workloadRef: z.string().min(1).nullable().default(null).openapi({ example: "flink-cluster" }),
    keyMetrics: z.array(serviceKeyMetricSchema).default([]).openapi({ example: [{ name: "CPU", value: "850", unit: "m" }] }),
    // 다른 Service의 id를 참조한다 — 순환/미존재 참조 검증은 실제 discovery/correlation
    // 레이어(#41/#42)의 책임이라 이 stub 계약에서는 강제하지 않는다.
    dependencies: z.array(z.string().min(1)).openapi({ example: ["svc-iceberg"] }),
    lastCheckedAt: z.iso.datetime().openapi({ example: "2026-09-21T00:00:00.000Z" }),
    staleAfterMs: z.number().int().nonnegative().openapi({ example: 60_000 }),
  })
  .openapi("Service");

export type ServiceType = z.infer<typeof serviceTypeSchema>;
export type CapabilityCategory = z.infer<typeof capabilityCategorySchema>;
export type Service = z.infer<typeof serviceSchema>;
