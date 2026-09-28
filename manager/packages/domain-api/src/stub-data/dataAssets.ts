// STUB DATA, NOT LIVE UPSTREAM INTEGRATION.
// Lakekeeper/Kafka로부터 실제 카탈로그를 조회하지 않는다(#41/#42). 계약 모양을
// 검증하기 위한 손으로 작성한 가짜 자산 목록이다.
import {
  dataAssetDetailSchema,
  dataAssetSchema,
  type DataAsset,
  type DataAssetDetail,
} from "../schema/dataAsset.js";

export const dataAssetDetails: DataAssetDetail[] = dataAssetDetailSchema.array().parse([
  { id: "asset-topic-events-raw", name: "events.raw", kind: "topic", serviceId: "svc-kafka", status: "degraded" },
  { id: "asset-schema-analytics", name: "analytics", kind: "schema", serviceId: "svc-iceberg", status: "healthy" },
  {
    id: "asset-table-orders",
    name: "analytics.orders",
    kind: "table",
    serviceId: "svc-iceberg",
    status: "healthy",
    format: "Iceberg v2 (Parquet)",
    location: "s3://beluga-lake/warehouse/analytics/orders",
    metadataSummary: {
      snapshotCount: 84,
      lastUpdated: "2026-09-28T09:30:00Z",
      partitionSpec: "order_date",
    },
    columns: [
      { name: "order_id", type: "BIGINT", nullable: false, comment: "Order primary key" },
      { name: "customer_id", type: "BIGINT", nullable: false, comment: "Customer identifier" },
      { name: "order_status", type: "VARCHAR", nullable: false, comment: "Order status (COMPLETED, PENDING, CANCELLED)" },
      { name: "total_amount", type: "DECIMAL(12, 2)", nullable: false, comment: "Total order amount" },
      { name: "order_date", type: "DATE", nullable: false, comment: "Order date partition key" },
      { name: "created_at", type: "TIMESTAMP(6) WITH TIME ZONE", nullable: false, comment: "Record creation timestamp" },
      { name: "updated_at", type: "TIMESTAMP(6) WITH TIME ZONE", nullable: false, comment: "Record last updated timestamp" },
    ],
  },
  {
    id: "asset-table-orders-enriched",
    name: "analytics.orders_enriched",
    kind: "table",
    serviceId: "svc-iceberg",
    status: "stale",
    format: "Iceberg v2 (Parquet)",
    location: "s3://beluga-lake/warehouse/analytics/orders_enriched",
    metadataSummary: {
      snapshotCount: 120,
      lastUpdated: "2026-09-27T18:00:00Z",
      partitionSpec: "order_date",
    },
    columns: [
      { name: "order_id", type: "BIGINT", nullable: false, comment: "Order primary key" },
      { name: "customer_id", type: "BIGINT", nullable: false, comment: "Customer identifier" },
      { name: "customer_email", type: "VARCHAR", nullable: true, comment: "Customer email address (PII Masking)" },
      { name: "customer_grade", type: "VARCHAR", nullable: true, comment: "Customer loyalty grade (VIP, GOLD, REGULAR)" },
      { name: "order_status", type: "VARCHAR", nullable: false, comment: "Order status" },
      { name: "total_amount", type: "DECIMAL(12, 2)", nullable: false, comment: "Total order amount" },
      { name: "order_date", type: "DATE", nullable: false, comment: "Order date partition key" },
      { name: "enriched_at", type: "TIMESTAMP(6) WITH TIME ZONE", nullable: false, comment: "Record enrichment timestamp" },
    ],
  },
] satisfies DataAssetDetail[]);

export const dataAssets: DataAsset[] = dataAssetSchema.array().parse(
  dataAssetDetails.map(({ id, name, kind, serviceId, status }) => ({
    id,
    name,
    kind,
    serviceId,
    status,
  })),
);
