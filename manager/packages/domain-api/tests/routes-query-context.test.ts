import { expect, test } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createApp } from "../src/app.js";
import { errorResponseSchema } from "../src/schema/envelope.js";
import { registerQueryContextRoutes } from "../src/routes/queryContext.js";
import { queryContextSchema } from "../src/schema/queryContext.js";

test("테이블 자산의 query-context는 catalog.schema.table과 읽기 전용 LIMIT SQL을 반환한다", async () => {
  const res = await createApp().request("/api/v1/data-assets/asset-table-orders/query-context");

  expect(res.status).toBe(200);
  const body = queryContextSchema.parse(await res.json());
  expect(body).toMatchObject({
    assetId: "asset-table-orders",
    catalog: "beluga_lake",
    schema: "analytics",
    table: "orders",
    trinoUiUrl: "https://trino.local.beluga.internal",
    readOnly: true,
    rowLimit: 20,
  });
  expect(body.sampleSql).toBe('SELECT * FROM "beluga_lake"."analytics"."orders" LIMIT 20');
});

test("topic/schema 자산은 질의 컨텍스트가 없으므로 404다", async () => {
  for (const id of ["asset-topic-events-raw", "asset-schema-analytics"]) {
    const res = await createApp().request(`/api/v1/data-assets/${id}/query-context`);
    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("NOT_FOUND");
  }
});

test("존재하지 않는 id는 404 envelope을 반환한다", async () => {
  const res = await createApp().request("/api/v1/data-assets/nope/query-context");
  expect(res.status).toBe(404);
  expect(errorResponseSchema.parse(await res.json()).error.message).toContain("nope");
});

test("SQL은 항상 단일 SELECT + LIMIT이다 (모든 stub 테이블)", async () => {
  const app = createApp();
  const list = (await (await app.request("/api/v1/data-assets?kind=table&pageSize=100")).json()) as {
    data: { id: string }[];
  };
  expect(list.data.length).toBeGreaterThan(0);
  for (const { id } of list.data) {
    const body = queryContextSchema.parse(await (await app.request(`/api/v1/data-assets/${id}/query-context`)).json());
    expect(body.sampleSql).toMatch(/^SELECT \* FROM "[^"]+"\."[^"]+"\."[^"]+" LIMIT \d+$/);
  }
});

test('식별자의 큰따옴표는 이중화되어 SQL 인용을 탈출할 수 없다', async () => {
  const app = new OpenAPIHono();
  registerQueryContextRoutes(app, [
    {
      id: "asset-table-evil",
      name: 'sch"ema.ta"ble; DROP TABLE x --',
      kind: "table",
      serviceId: "svc-iceberg",
      status: "healthy",
    },
  ]);
  const res = await app.request("/api/v1/data-assets/asset-table-evil/query-context");

  expect(res.status).toBe(200);
  const body = queryContextSchema.parse(await res.json());
  expect(body.sampleSql).toBe('SELECT * FROM "beluga_lake"."sch""ema"."ta""ble; DROP TABLE x --" LIMIT 20');
});
