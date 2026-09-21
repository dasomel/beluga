import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { dataAssetSchema } from "../src/schema/dataAsset.js";
import { listResponseSchema } from "../src/schema/envelope.js";
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
