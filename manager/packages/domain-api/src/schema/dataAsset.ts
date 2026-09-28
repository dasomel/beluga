import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";

export const dataAssetKindSchema = z.enum(["table", "topic", "schema"]).openapi("DataAssetKind");

export const dataAssetSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "asset-table-orders" }),
    name: z.string().min(1).openapi({ example: "analytics.orders" }),
    kind: dataAssetKindSchema,
    // 이 자산을 소유하는 OSS의 Service.id — 예: Iceberg 테이블이면 카탈로그를 서빙하는
    // iceberg 서비스, Kafka 토픽이면 kafka 서비스.
    serviceId: z.string().min(1).openapi({ example: "svc-iceberg" }),
    status: healthStatusSchema,
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
    metadataSummary: dataAssetMetadataSummarySchema
      .optional()
      .openapi({ description: "Metadata summary (present for kind=table)" }),
  })
  .openapi("DataAssetDetail");

export type DataAssetColumn = z.infer<typeof dataAssetColumnSchema>;
export type DataAssetMetadataSummary = z.infer<typeof dataAssetMetadataSummarySchema>;
export type DataAssetDetail = z.infer<typeof dataAssetDetailSchema>;
