import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { serviceSchema } from "../src/schema/service.js";
import { services } from "../src/stub-data/services.js";

const serviceListResponseSchema = listResponseSchema(serviceSchema, "ServiceListResponseTest");

test("GET /api/v1/services는 스키마와 정확히 일치하는 목록 envelope을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/services");

  expect(res.status).toBe(200);
  const body = serviceListResponseSchema.parse(await res.json());
  expect(body.meta.total).toBe(services.length);
});

test("GET /api/v1/services/{id}는 단일 서비스를 스키마 그대로 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/services/svc-trino");

  expect(res.status).toBe(200);
  const body = serviceSchema.parse(await res.json());
  expect(body.id).toBe("svc-trino");
});

test("GET /api/v1/services/{id}는 존재하지 않는 id에 대해 일관된 404 모양을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/services/does-not-exist");

  expect(res.status).toBe(404);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("NOT_FOUND");
});

test("page/pageSize가 실제로 stub 데이터를 슬라이스한다", async () => {
  const app = createApp();
  const page1 = serviceListResponseSchema.parse(await (await app.request("/api/v1/services?page=1&pageSize=2")).json());
  const page2 = serviceListResponseSchema.parse(await (await app.request("/api/v1/services?page=2&pageSize=2")).json());

  expect(page1.data).toHaveLength(2);
  expect(page2.data).toHaveLength(2);
  expect(page1.meta).toEqual({ total: services.length, page: 1, pageSize: 2 });
  expect(page2.meta).toEqual({ total: services.length, page: 2, pageSize: 2 });

  const idsPage1 = page1.data.map((svc) => svc.id);
  const idsPage2 = page2.data.map((svc) => svc.id);
  expect(idsPage1).not.toEqual(idsPage2);
});

test("?type= 필터는 해당 type의 서비스만 남긴다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/services?type=kafka");
  const body = serviceListResponseSchema.parse(await res.json());

  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((svc) => svc.type === "kafka")).toBe(true);
});

test("degraded인 stub 항목이 있으면 warnings가 나타난다", async () => {
  const app = createApp();
  // svc-kafka는 stub-data/services.ts에서 status: "degraded"로 고정되어 있다.
  const res = await app.request("/api/v1/services?type=kafka");
  const body = serviceListResponseSchema.parse(await res.json());

  expect(body.warnings).toEqual([{ code: "DEGRADED", message: "Kafka status is degraded", serviceId: "svc-kafka" }]);
});

test("모두 healthy인 필터 결과에는 warnings 키가 없다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/services?status=healthy");
  const body = serviceListResponseSchema.parse(await res.json());

  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((svc) => svc.status === "healthy")).toBe(true);
  expect(body.warnings).toBeUndefined();
});
