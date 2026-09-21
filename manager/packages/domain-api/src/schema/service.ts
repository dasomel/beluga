import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";

export const serviceTypeSchema = z
  .enum(["kafka", "flink", "iceberg", "trino", "airflow", "kubernetes", "observability"])
  .openapi("ServiceType");

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
    // 다른 Service의 id를 참조한다 — 순환/미존재 참조 검증은 실제 discovery/correlation
    // 레이어(#41/#42)의 책임이라 이 stub 계약에서는 강제하지 않는다.
    dependencies: z.array(z.string().min(1)).openapi({ example: ["svc-iceberg"] }),
    lastCheckedAt: z.iso.datetime().openapi({ example: "2026-09-21T00:00:00.000Z" }),
    staleAfterMs: z.number().int().nonnegative().openapi({ example: 60_000 }),
  })
  .openapi("Service");

export type ServiceType = z.infer<typeof serviceTypeSchema>;
export type Service = z.infer<typeof serviceSchema>;
