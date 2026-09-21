// STUB DATA, NOT LIVE UPSTREAM INTEGRATION.
// Lakekeeper/Kafka로부터 실제 카탈로그를 조회하지 않는다(#41/#42). 계약 모양을
// 검증하기 위한 손으로 작성한 가짜 자산 목록이다.
import { dataAssetSchema, type DataAsset } from "../schema/dataAsset.js";

export const dataAssets: DataAsset[] = dataAssetSchema.array().parse([
  { id: "asset-topic-events-raw", name: "events.raw", kind: "topic", serviceId: "svc-kafka", status: "degraded" },
  { id: "asset-schema-analytics", name: "analytics", kind: "schema", serviceId: "svc-iceberg", status: "healthy" },
  {
    id: "asset-table-orders",
    name: "analytics.orders",
    kind: "table",
    serviceId: "svc-iceberg",
    status: "healthy",
  },
  {
    id: "asset-table-orders-enriched",
    name: "analytics.orders_enriched",
    kind: "table",
    serviceId: "svc-iceberg",
    status: "stale",
  },
] satisfies DataAsset[]);
