import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { pipelineSchema } from "../src/schema/pipeline.js";
import { pipelines } from "../src/stub-data/pipelines.js";

const pipelineListResponseSchema = listResponseSchema(pipelineSchema, "PipelineListResponseTest");

test("GET /api/v1/pipelines는 스키마와 정확히 일치하는 목록 envelope을 반환하고 correlation을 포함한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines");

  expect(res.status).toBe(200);
  const body = pipelineListResponseSchema.parse(await res.json());
  expect(body.meta.total).toBe(pipelines.length);
  for (const pipeline of body.data) {
    expect(pipeline.correlation.confidence).toBeGreaterThanOrEqual(0);
    expect(pipeline.correlation.confidence).toBeLessThanOrEqual(1);
    expect(typeof pipeline.correlation.method).toBe("string");
  }
});

test("GET /api/v1/pipelines/{id}는 단일 파이프라인을 스키마 그대로 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines/pl-lakehouse-ingest");

  expect(res.status).toBe(200);
  const body = pipelineSchema.parse(await res.json());
  expect(body.correlation.method).toBe("declared");
});

test("GET /api/v1/pipelines/{id}는 존재하지 않는 id에 대해 일관된 404 모양을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines/does-not-exist");

  expect(res.status).toBe(404);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("NOT_FOUND");
});

test("page/pageSize가 실제로 stub 데이터를 슬라이스한다", async () => {
  const app = createApp();
  const page1 = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines?page=1&pageSize=1")).json());
  const page2 = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines?page=2&pageSize=1")).json());

  expect(page1.data).toHaveLength(1);
  expect(page2.data).toHaveLength(1);
  expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
  expect(page1.meta).toEqual({ total: pipelines.length, page: 1, pageSize: 1 });
});

test("?status= 필터는 aggregate status가 일치하는 파이프라인만 남긴다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines?status=healthy");
  const body = pipelineListResponseSchema.parse(await res.json());

  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((pipeline) => pipeline.status === "healthy")).toBe(true);
  expect(body.warnings).toBeUndefined();
});

test("healthy가 아닌 파이프라인이 있으면 warnings가 나타나고 serviceId는 null이다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines");
  const body = pipelineListResponseSchema.parse(await res.json());

  expect(body.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "DEGRADED", serviceId: null }),
      expect.objectContaining({ code: "UNAVAILABLE", serviceId: null }),
    ]),
  );
});
