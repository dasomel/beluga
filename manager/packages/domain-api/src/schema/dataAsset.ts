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
