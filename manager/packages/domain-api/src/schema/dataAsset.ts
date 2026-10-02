import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";

export const dataAssetKindSchema = z.enum(["table", "topic", "schema", "catalog"]).openapi("DataAssetKind");

export const dataAssetSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "asset-table-orders" }),
    name: z.string().min(1).openapi({ example: "analytics.orders" }),
    kind: dataAssetKindSchema,
    // 이 자산을 소유하는 OSS의 Service.id — 예: Iceberg 테이블이면 카탈로그를 서빙하는
    // iceberg 서비스, Kafka 토픽이면 kafka 서비스.
    serviceId: z.string().min(1).openapi({ example: "svc-iceberg" }),
    status: healthStatusSchema,
    // ADR-0004 D2/D8 계층 필드. 모두 optional이라 기존 flat 소비자(name/id)와 호환된다.
    // topic처럼 catalog/namespace 체인이 없는 자산은 생략한다.
    catalog: z.string().min(1).optional().openapi({ example: "beluga_lake", description: "Owning catalog name" }),
    namespace: z
      .array(z.string().min(1))
      .optional()
      .openapi({ example: ["analytics"], description: "Ordered namespace segments (Iceberg N-level namespace); empty for a catalog" }),
    parentId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .openapi({ example: "asset-catalog-beluga_lake", description: "Parent asset id; null for top-level (catalog/topic). Pass as `parentId` query to list children" }),
    path: z
      .array(z.string().min(1))
      .optional()
      .openapi({ example: ["beluga_lake", "analytics"], description: "Ancestor segment names from the catalog down, excluding the asset itself" }),
  })
  .openapi("DataAsset");

export type DataAssetKind = z.infer<typeof dataAssetKindSchema>;
export type DataAsset = z.infer<typeof dataAssetSchema>;

export const dataAssetColumnSchema = z
  .object({
    name: z.string().min(1).openapi({ example: "order_id", description: "Column identifier" }),
    type: z.string().min(1).openapi({ example: "BIGINT", description: "Data type name" }),
    nullable: z.boolean().openapi({ example: false, description: "Whether the column allows null values" }),
    comment: z.string().optional().openapi({ example: "Primary key", description: "Optional column description" }),
    isPartition: z
      .boolean()
      .optional()
      .openapi({ example: true, description: "Whether the column is part of the table partition spec (ADR-0004 D9)" }),
  })
  .openapi("DataAssetColumn");

export const dataAssetMetadataSummarySchema = z
  .object({
    snapshotCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({ example: 84, description: "Total snapshot count in Iceberg metadata" }),
    lastUpdated: z
      .string()
      .optional()
      .openapi({ example: "2026-09-28T09:30:00Z", description: "Timestamp of last metadata update" }),
    partitionSpec: z
      .string()
      .optional()
      .openapi({ example: "order_date", description: "Table partition specification" }),
  })
  .openapi("DataAssetMetadataSummary");

export const dataAssetDetailSchema = dataAssetSchema
  .extend({
    columns: z
      .array(dataAssetColumnSchema)
      .optional()
      .openapi({ description: "Table columns (present for kind=table)" }),
    location: z
      .string()
      .min(1)
      .optional()
      .openapi({
        example: "s3://beluga-lake/warehouse/analytics/orders",
        description: "Storage location URI (present for kind=table)",
      }),
    format: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "Iceberg v2 (Parquet)", description: "Storage format (present for kind=table)" }),
    childCount: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .openapi({
        example: null,
        description:
          "Authorized child count (kind=catalog/schema). Always null until node-level OPA filtering exists " +
          "(ADR-0004 D7/D9): an unfiltered count would leak child cardinality.",
      }),
    metadataSummary: dataAssetMetadataSummarySchema
      .optional()
      .openapi({ description: "Metadata summary (present for kind=table)" }),
  })
  .openapi("DataAssetDetail");

export type DataAssetColumn = z.infer<typeof dataAssetColumnSchema>;
export type DataAssetMetadataSummary = z.infer<typeof dataAssetMetadataSummarySchema>;
export type DataAssetDetail = z.infer<typeof dataAssetDetailSchema>;

// 목록 항목은 dataAssetSchema 필드만 allowlist로 투영한다 — 상세 전용 필드가 추가돼도 목록에 새지 않는다.
export function toDataAsset(detail: DataAssetDetail): DataAsset {
  return dataAssetSchema.parse(detail);
}
