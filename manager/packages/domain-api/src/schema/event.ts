import { z } from "@hono/zod-openapi";

export const eventSeveritySchema = z.enum(["info", "warning", "error"]).openapi("EventSeverity");

// 출처 구분(선택). 값이 없으면 출처 미상이며 권위 있는 값으로 추정·보충하지 않는다.
export const eventSourceSchema = z.enum(["kubernetes", "service", "job"]).openapi("EventSource");

// architecture.md 원칙 4(Locale-neutral API): message는 로케일 중립적인 영문 기술
// 설명이어야 한다 — 현지화는 Frontend의 책임이다. 이 계약을 따르지 않는 지역화된
// 문자열을 여기 담지 않는다.
export const eventSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "evt-1" }),
    timestamp: z.iso.datetime().openapi({ example: "2026-09-21T00:00:00.000Z" }),
    severity: eventSeveritySchema,
    message: z.string().min(1).openapi({ example: "Health probe timed out" }),
    relatedServiceId: z.string().min(1).nullable().openapi({ example: "svc-observability" }),
    relatedPipelineId: z.string().min(1).nullable().openapi({ example: "pl-lakehouse-ingest" }),
    relatedResourceId: z.string().min(1).nullable().openapi({ example: "k8s-pod-flink-jobmanager" }),
    source: eventSourceSchema.optional().openapi({ description: "Origin of the event; absent when unknown." }),
  })
  .openapi("Event");

export type EventSeverity = z.infer<typeof eventSeveritySchema>;
export type EventSource = z.infer<typeof eventSourceSchema>;
export type Event = z.infer<typeof eventSchema>;
