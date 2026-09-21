// STUB DATA, NOT LIVE UPSTREAM INTEGRATION.
// 실제 upstream 이벤트 스트림을 구독하지 않는다(#41/#42). 계약 모양을 검증하기 위한
// 손으로 작성한 가짜 이벤트 목록이다. message는 architecture.md 원칙 4(Locale-neutral
// API)에 따라 로케일 중립적인 영문으로 유지한다 — 현지화는 Frontend 책임이다.
import { eventSchema, type Event } from "../schema/event.js";

export const events: Event[] = eventSchema.array().parse([
  {
    id: "evt-1",
    timestamp: "2026-09-21T05:00:00.000Z",
    severity: "error",
    message: "Health probe timed out",
    relatedServiceId: "svc-observability",
    relatedPipelineId: "pl-cluster-observability",
  },
  {
    id: "evt-2",
    timestamp: "2026-09-21T04:55:00.000Z",
    severity: "warning",
    message: "Under-replicated partitions detected",
    relatedServiceId: "svc-kafka",
    relatedPipelineId: "pl-lakehouse-ingest",
  },
  {
    id: "evt-3",
    timestamp: "2026-09-21T04:50:00.000Z",
    severity: "warning",
    message: "Checkpoint status stale beyond freshness window",
    relatedServiceId: "svc-flink",
    relatedPipelineId: "pl-lakehouse-ingest",
  },
  {
    id: "evt-4",
    timestamp: "2026-09-21T04:45:00.000Z",
    severity: "info",
    message: "Service health check completed",
    relatedServiceId: "svc-trino",
    relatedPipelineId: null,
  },
  {
    id: "evt-5",
    timestamp: "2026-09-21T04:40:00.000Z",
    severity: "info",
    message: "Correlation re-evaluated",
    relatedServiceId: null,
    relatedPipelineId: "pl-batch-reporting",
  },
  {
    id: "evt-6",
    timestamp: "2026-09-21T04:35:00.000Z",
    severity: "info",
    message: "Platform heartbeat",
    relatedServiceId: null,
    relatedPipelineId: null,
  },
] satisfies Event[]);
