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

test("구조화된 catalog/namespace가 있으면 name 파싱 대신 그것으로 주소를 만든다", async () => {
  const app = new OpenAPIHono();
  registerQueryContextRoutes(app, [
    {
      id: "asset-table-x",
      name: "orders",
      kind: "table",
      serviceId: "svc-iceberg",
      status: "healthy",
      catalog: "other_cat",
      namespace: ["sales"],
    },
    {
      id: "asset-table-deep",
      name: "orders",
      kind: "table",
      serviceId: "svc-iceberg",
      status: "healthy",
      catalog: "other_cat",
      namespace: ["sales", "raw"],
    },
  ]);
  const ok = queryContextSchema.parse(await (await app.request("/api/v1/data-assets/asset-table-x/query-context")).json());
  expect(ok).toMatchObject({ catalog: "other_cat", schema: "sales", table: "orders" });
  expect(ok.sampleSql).toBe('SELECT * FROM "other_cat"."sales"."orders" LIMIT 20');
  // 다단계 namespace는 Trino schema로 추측하지 않고 질의 불가(404)로 처리한다.
  expect((await app.request("/api/v1/data-assets/asset-table-deep/query-context")).status).toBe(404);
});

test("점이 든 table 이름(orders.v2)과 빈 namespace의 flat 이름을 올바르게 해석한다", async () => {
  const app = new OpenAPIHono();
  registerQueryContextRoutes(app, [
    { id: "a", name: "orders.v2", kind: "table", serviceId: "svc-iceberg", status: "healthy", catalog: "c", namespace: ["sales"] },
    { id: "b", name: "sales.orders.v2", kind: "table", serviceId: "svc-iceberg", status: "healthy", catalog: "c", namespace: ["sales"] },
    { id: "c", name: "x.y", kind: "table", serviceId: "svc-iceberg", status: "healthy", catalog: "c", namespace: [] },
  ]);
  const a = queryContextSchema.parse(await (await app.request("/api/v1/data-assets/a/query-context")).json());
  expect(a).toMatchObject({ schema: "sales", table: "orders.v2" });
  const b = queryContextSchema.parse(await (await app.request("/api/v1/data-assets/b/query-context")).json());
  expect(b).toMatchObject({ schema: "sales", table: "orders.v2" });
  // namespace가 비어 있으면 schema를 알 수 없으므로 추측하지 않고 404다.
  expect((await app.request("/api/v1/data-assets/c/query-context")).status).toBe(404);
});
