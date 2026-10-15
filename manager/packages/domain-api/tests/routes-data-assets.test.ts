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

test("?kind=table 필터는 table 자산만 남기고 meta.total은 필터된 전체 개수를 반영한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?kind=table");
  const body = dataAssetListResponseSchema.parse(await res.json());

  expect(body.data.every((asset) => asset.kind === "table")).toBe(true);
  expect(body.meta.total).toBe(dataAssets.filter((asset) => asset.kind === "table").length);
});

test("?kind=topic 필터는 topic 자산만 남긴다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?kind=topic");
  const body = dataAssetListResponseSchema.parse(await res.json());

  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((asset) => asset.kind === "topic")).toBe(true);
  expect(body.meta.total).toBe(dataAssets.filter((asset) => asset.kind === "topic").length);
});

test("알 수 없는 kind 값은 400 VALIDATION_ERROR를 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?kind=not-a-real-kind");

  expect(res.status).toBe(400);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("VALIDATION_ERROR");
});

test("meta.total은 pageSize로 잘린 data.length보다 클 수 있다 (kind=table을 pageSize=1로 조회)", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?kind=table&pageSize=1");
  const body = dataAssetListResponseSchema.parse(await res.json());

  const expectedTotal = dataAssets.filter((asset) => asset.kind === "table").length;
  expect(expectedTotal).toBeGreaterThan(1);
  expect(body.data).toHaveLength(1);
  expect(body.meta.total).toBe(expectedTotal);
  expect(body.meta.total).toBeGreaterThan(body.data.length);
});

test("모든 kind 값(catalog/schema/table/topic)이 stub에 존재하고 스키마를 통과한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?pageSize=100");
  const body = dataAssetListResponseSchema.parse(await res.json());

  const kinds = new Set(body.data.map((asset) => asset.kind));
  expect(kinds).toEqual(new Set(["catalog", "schema", "table", "topic"]));
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

test("?parentId=<catalogId>는 해당 catalog의 schema만, ?parentId=<schemaId>는 그 schema의 table만 반환한다", async () => {
  const app = createApp();
  const schemas = dataAssetListResponseSchema.parse(
    await (await app.request("/api/v1/data-assets?parentId=asset-catalog-beluga_lake")).json(),
  );
  expect(schemas.data.map((asset) => asset.id)).toEqual(["asset-schema-analytics"]);
  expect(schemas.meta.total).toBe(1);

  const tables = dataAssetListResponseSchema.parse(
    await (await app.request("/api/v1/data-assets?parentId=asset-schema-analytics")).json(),
  );
  expect(tables.data.map((asset) => asset.id)).toEqual(["asset-table-orders", "asset-table-orders-enriched"]);
  expect(tables.data.every((asset) => asset.kind === "table")).toBe(true);
});

test("?parentId=는 status/kind 필터와 함께 쓸 수 있다", async () => {
  const app = createApp();
  const body = dataAssetListResponseSchema.parse(
    await (await app.request("/api/v1/data-assets?parentId=asset-schema-analytics&status=stale")).json(),
  );
  expect(body.data.map((asset) => asset.id)).toEqual(["asset-table-orders-enriched"]);
});

test("알 수 없는 parentId는 404가 아니라 빈 목록이다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/data-assets?parentId=asset-catalog-nope");
  expect(res.status).toBe(200);
  const body = dataAssetListResponseSchema.parse(await res.json());
  expect(body.data).toEqual([]);
  expect(body.meta.total).toBe(0);
});

test("kind=catalog는 최상위 catalog를 반환하고 parentId가 null이다", async () => {
  const app = createApp();
  const body = dataAssetListResponseSchema.parse(await (await app.request("/api/v1/data-assets?kind=catalog")).json());
  expect(body.data).toEqual([
    expect.objectContaining({ id: "asset-catalog-beluga_lake", name: "beluga_lake", parentId: null, path: [] }),
  ]);
});

test("table 자산은 구조화된 catalog/namespace/path를 가지면서 flat name/id를 유지한다", async () => {
  const app = createApp();
  const detail = dataAssetDetailSchema.parse(await (await app.request("/api/v1/data-assets/asset-table-orders")).json());
  expect(detail).toMatchObject({
    id: "asset-table-orders",
    name: "analytics.orders",
    catalog: "beluga_lake",
    namespace: ["analytics"],
    parentId: "asset-schema-analytics",
    path: ["beluga_lake", "analytics"],
  });
});

test("목록 응답에는 상세 전용 필드가 포함되지 않는다", async () => {
  const app = createApp();
  const body = dataAssetListResponseSchema.parse(await (await app.request("/api/v1/data-assets?pageSize=100")).json());
  for (const asset of body.data) {
    expect(asset).not.toHaveProperty("columns");
    expect(asset).not.toHaveProperty("childCount");
    expect(asset).not.toHaveProperty("metadataSummary");
  }
});

test("partition 컬럼은 isPartition=true로 구조화되고 metadataSummary.partitionSpec과 일치한다", async () => {
  const app = createApp();
  const detail = dataAssetDetailSchema.parse(await (await app.request("/api/v1/data-assets/asset-table-orders")).json());
  const partitionColumns = detail.columns!.filter((column) => column.isPartition).map((column) => column.name);
  expect(partitionColumns).toEqual([detail.metadataSummary!.partitionSpec]);
});

test("catalog/schema 상세의 childCount는 항상 null이다 (D7/D9: OPA 노드 필터링 전 interim)", async () => {
  const app = createApp();
  for (const id of ["asset-catalog-beluga_lake", "asset-schema-analytics"]) {
    const detail = dataAssetDetailSchema.parse(await (await app.request(`/api/v1/data-assets/${id}`)).json());
    expect(detail.childCount).toBeNull();
  }
});
