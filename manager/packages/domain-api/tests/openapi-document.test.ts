import { z } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema } from "../src/schema/envelope.js";

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

// list 엔드포인트들은 실제로 400 VALIDATION_ERROR를 반환할 수 있는데(예: ?page=0),
// 문서에는 200만 선언되어 있었다(#43 finding #2). 각 path가 "실제로 내는 응답 코드"와
// "문서가 선언한 응답 코드"가 서로 정확히 일치하는지 확인한다 -- path의 존재 여부만이
// 아니라.
const LIST_PATHS = ["/api/v1/services", "/api/v1/pipelines", "/api/v1/data-assets", "/api/v1/events"];

const BY_ID_REQUESTS: Record<string, string> = {
  "/api/v1/services/{id}": "/api/v1/services/does-not-exist",
  "/api/v1/pipelines/{id}": "/api/v1/pipelines/does-not-exist",
};

const responseSchema = z.object({
  content: z.object({
    "application/json": z.object({
      schema: z.object({ $ref: z.string() }),
    }),
  }),
});

test("list 엔드포인트는 ?page=0에 실제로 400을 반환하고, 문서도 400 + ErrorResponse를 선언한다", async () => {
  const app = createApp();
  const doc = openApiDocumentShapeSchema.parse(await (await app.request("/api/v1/openapi.json")).json());

  for (const path of LIST_PATHS) {
    const res = await app.request(`${path}?page=0`);
    expect(res.status).toBe(400);
    const body = errorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("VALIDATION_ERROR");

    const responses = doc.paths[path]?.get as { responses: Record<string, unknown> };
    expect(Object.keys(responses.responses).sort()).toEqual(["200", "400", "500"]);
    const badRequest = responseSchema.parse(responses.responses["400"]);
    expect(badRequest.content["application/json"].schema.$ref).toBe("#/components/schemas/ErrorResponse");
  }
});

test("단일 리소스 엔드포인트는 실제로 404를 반환하고, 문서도 404 + ErrorResponse를 선언한다", async () => {
  const app = createApp();
  const doc = openApiDocumentShapeSchema.parse(await (await app.request("/api/v1/openapi.json")).json());

  for (const [path, url] of Object.entries(BY_ID_REQUESTS)) {
    const res = await app.request(url);
    expect(res.status).toBe(404);

    const responses = doc.paths[path]?.get as { responses: Record<string, unknown> };
    const notFound = responseSchema.parse(responses.responses["404"]);
    expect(notFound.content["application/json"].schema.$ref).toBe("#/components/schemas/ErrorResponse");
  }
});

// onError(app.ts)는 모든 documented route에 적용되므로(issue #43 finding #3), 각
// route가 500 + ErrorResponse도 선언하는지 확인한다 -- 실제로 500을 트리거하는 것은
// tests/app-error-handling.test.ts가 별도로 검증한다.
test("모든 documented path는 500 + ErrorResponse도 선언한다", async () => {
  const app = createApp();
  const doc = openApiDocumentShapeSchema.parse(await (await app.request("/api/v1/openapi.json")).json());

  for (const path of DOCUMENTED_PATHS) {
    const responses = doc.paths[path]?.get as { responses: Record<string, unknown> };
    const serverError = responseSchema.parse(responses.responses["500"]);
    expect(serverError.content["application/json"].schema.$ref).toBe("#/components/schemas/ErrorResponse");
  }
});
