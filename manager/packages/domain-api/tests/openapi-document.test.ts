import { z } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";

const DOCUMENTED_PATHS = [
  "/api/v1/services",
  "/api/v1/services/{id}",
  "/api/v1/pipelines",
  "/api/v1/pipelines/{id}",
  "/api/v1/data-assets",
  "/api/v1/health",
  "/api/v1/events",
];

// OpenAPI 3.1 문서 전체를 모델링하는 스키마는 이 이슈 범위 밖이다 — 테스트가 실제로
// 확인해야 하는 최소 모양만 정의한다.
const openApiDocumentShapeSchema = z.object({
  openapi: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

test("GET /api/v1/openapi.json은 유효한 JSON이고 이슈 #43의 7개 경로를 모두 포함한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/openapi.json");

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");

  const doc = openApiDocumentShapeSchema.parse(await res.json());
  expect(doc.openapi).toBe("3.1.0");
  for (const path of DOCUMENTED_PATHS) {
    expect(doc.paths).toHaveProperty(path);
  }
  expect(Object.keys(doc.paths)).toHaveLength(DOCUMENTED_PATHS.length);
});

test("openapi.json 자신과 /docs, 두 부가 엔드포인트도 실제로 응답한다", async () => {
  const app = createApp();

  const openapiRes = await app.request("/api/v1/openapi.json");
  expect(openapiRes.status).toBe(200);

  const docsRes = await app.request("/api/v1/docs");
  expect(docsRes.status).toBe(200);
  expect(docsRes.headers.get("content-type")).toContain("text/html");
});

test("각 documented path는 정확히 GET 메서드만 노출한다(MVP는 read-only)", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/openapi.json");
  const doc = openApiDocumentShapeSchema.parse(await res.json());

  for (const path of DOCUMENTED_PATHS) {
    expect(Object.keys(doc.paths[path] ?? {})).toEqual(["get"]);
  }
});
