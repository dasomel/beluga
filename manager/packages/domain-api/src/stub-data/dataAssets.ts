// STUB DATA, NOT LIVE UPSTREAM INTEGRATION.
// Lakekeeper/Kafka로부터 실제 카탈로그를 조회하지 않는다(#41/#42). 계약 모양을
// 검증하기 위한 손으로 작성한 가짜 자산 목록이다.
import { deriveAssetId } from "../lib/assetId.js";
import {
  dataAssetDetailSchema,
  toDataAsset,
  type DataAsset,
  type DataAssetDetail,
} from "../schema/dataAsset.js";

const CATALOG = "beluga_lake";
const CATALOG_ID = deriveAssetId("catalog", [CATALOG]);
// 기존 flat id(asset-table-orders 등)는 live caller 호환을 위해 유지한다 — id는 opaque이므로
// D4 파생 규칙(deriveAssetId)은 새 노드(catalog)부터 적용하고 어댑터(#41/#42)가 이어받는다.
const SCHEMA_ID = "asset-schema-analytics";
const analyticsLineage = { catalog: CATALOG, namespace: ["analytics"], parentId: SCHEMA_ID, path: [CATALOG, "analytics"] };

export const dataAssetDetails: DataAssetDetail[] = dataAssetDetailSchema.array().parse([
  {
    id: "asset-topic-events-raw",
    name: "events.raw",
    kind: "topic",
    serviceId: "svc-kafka",
    status: "degraded",
    parentId: null,
    path: [],
  },
  {
    id: CATALOG_ID,
    name: CATALOG,
    kind: "catalog",
    serviceId: "svc-iceberg",
    status: "healthy",
    catalog: CATALOG,
    namespace: [],
    parentId: null,
    path: [],
    // D7/D9 interim: node-level OPA 필터링 전에는 항상 null.
    childCount: null,
  },
  {
    id: SCHEMA_ID,
    name: "analytics",
    kind: "schema",
    serviceId: "svc-iceberg",
    status: "healthy",
    catalog: CATALOG,
    namespace: ["analytics"],
    parentId: CATALOG_ID,
    path: [CATALOG],
    childCount: null,
  },
  {
    id: "asset-table-orders",
    name: "analytics.orders",
    kind: "table",
    serviceId: "svc-iceberg",
    status: "healthy",
    ...analyticsLineage,
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
      { name: "order_date", type: "DATE", nullable: false, comment: "Order date partition key", isPartition: true },
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
    ...analyticsLineage,
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
      { name: "order_date", type: "DATE", nullable: false, comment: "Order date partition key", isPartition: true },
      { name: "enriched_at", type: "TIMESTAMP(6) WITH TIME ZONE", nullable: false, comment: "Record enrichment timestamp" },
    ],
  },
] satisfies DataAssetDetail[]);

export const dataAssets: DataAsset[] = dataAssetDetails.map(toDataAsset);
