import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { dataAssetDetailSchema, dataAssetSchema } from "../src/schema/dataAsset.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { dataAssets } from "../src/stub-data/dataAssets.js";

const dataAssetListResponseSchema = listResponseSchema(dataAssetSchema, "DataAssetListResponseTest");

test("GET /api/v1/data-assets는 스키마와 정확히 일치하는 목록 envelope을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets");

  expect(res.status).toBe(200);
  const body = dataAssetListResponseSchema.parse(await res.json());
  expect(body.meta.total).toBe(dataAssets.length);
});

test("page/pageSize가 실제로 stub 데이터를 슬라이스한다", async () => {
  const app = createApp();
  const page1 = dataAssetListResponseSchema.parse(
    await (await app.request("/api/v1/data-assets?page=1&pageSize=2")).json(),
  );
  const page2 = dataAssetListResponseSchema.parse(
    await (await app.request("/api/v1/data-assets?page=2&pageSize=2")).json(),
  );

  expect(page1.data).toHaveLength(2);
  expect(page2.data).toHaveLength(2);
  const idsPage1 = page1.data.map((asset) => asset.id);
  const idsPage2 = page2.data.map((asset) => asset.id);
  expect(idsPage1).not.toEqual(idsPage2);
});

test("?status= 필터는 해당 status의 자산만 남기고 stale 자산은 warnings를 발생시킨다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?status=stale");
  const body = dataAssetListResponseSchema.parse(await res.json());

  expect(body.data).toEqual([expect.objectContaining({ id: "asset-table-orders-enriched", status: "stale" })]);
  expect(body.warnings).toEqual([
    { code: "STALE", message: "analytics.orders_enriched status is stale", serviceId: "svc-iceberg" },
  ]);
});

test("모든 kind 값(table/topic/schema)이 stub에 존재하고 스키마를 통과한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?pageSize=100");
  const body = dataAssetListResponseSchema.parse(await res.json());

  const kinds = new Set(body.data.map((asset) => asset.kind));
  expect(kinds).toEqual(new Set(["table", "topic", "schema"]));
});

test("GET /api/v1/data-assets/{id}는 테이블 자산의 상세 정보(columns, location, format, metadataSummary)를 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets/asset-table-orders");

  expect(res.status).toBe(200);
  const detail = dataAssetDetailSchema.parse(await res.json());
  expect(detail.id).toBe("asset-table-orders");
  expect(detail.kind).toBe("table");
  expect(detail.format).toBe("Iceberg v2 (Parquet)");
  expect(detail.location).toBe("s3://beluga-lake/warehouse/analytics/orders");
  expect(detail.metadataSummary).toEqual({
    snapshotCount: 84,
    lastUpdated: "2026-09-28T09:30:00Z",
    partitionSpec: "order_date",
  });
  expect(detail.columns).toBeDefined();
  expect(detail.columns!.length).toBeGreaterThan(0);
  expect(detail.columns![0]).toEqual({
    name: "order_id",
    type: "BIGINT",
    nullable: false,
    comment: "Order primary key",
  });
});

test("GET /api/v1/data-assets/{id}는 비-테이블 자산(topic, schema) 조회 시 table-only 필드를 생략한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets/asset-topic-events-raw");

  expect(res.status).toBe(200);
  const detail = dataAssetDetailSchema.parse(await res.json());
  expect(detail.id).toBe("asset-topic-events-raw");
  expect(detail.kind).toBe("topic");
  expect(detail.columns).toBeUndefined();
  expect(detail.location).toBeUndefined();
  expect(detail.format).toBeUndefined();
  expect(detail.metadataSummary).toBeUndefined();
});

test("GET /api/v1/data-assets/{id}는 존재하지 않는 id에 대해 일관된 404 에러 봉투를 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets/missing-asset-id");

  expect(res.status).toBe(404);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.message).toContain("missing-asset-id");
});

test("dataAssetDetailSchema는 잘못된 스키마 입력을 거절한다", () => {
  const baseTable = {
    id: "test-table",
    name: "analytics.test",
    kind: "table" as const,
    serviceId: "svc-iceberg",
    status: "healthy" as const,
  };

  // 음수 snapshotCount 거절
  expect(
    dataAssetDetailSchema.safeParse({
      ...baseTable,
      metadataSummary: { snapshotCount: -1 },
    }).success,
  ).toBe(false);

  // 컬럼 name이 빈 문자열인 경우 거절
  expect(
    dataAssetDetailSchema.safeParse({
      ...baseTable,
      columns: [{ name: "", type: "BIGINT", nullable: false }],
    }).success,
  ).toBe(false);

  // 컬럼 nullable이 boolean이 아닌 경우 거절
  expect(
    dataAssetDetailSchema.safeParse({
      ...baseTable,
      columns: [{ name: "id", type: "BIGINT", nullable: "not-a-bool" }],
    }).success,
  ).toBe(false);

  // 허용되지 않은 kind 값 거절
  expect(
    dataAssetDetailSchema.safeParse({
      ...baseTable,
      kind: "stream",
    }).success,
  ).toBe(false);
});
