import { expect, test } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { resourceSchema } from "../src/schema/resource.js";
import { resources } from "../src/stub-data/resources.js";

const responseSchema = listResponseSchema(resourceSchema, "ResourceListResponseTest");

test("GET /api/v1/resources returns a validated list envelope", async () => {
  const response = await createApp().request("/api/v1/resources?pageSize=100");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.data).toHaveLength(resources.length);
  expect(body.meta.total).toBe(resources.length);
});

test("resource list filters by namespace and kind", async () => {
  const app = createApp();
  const namespaceResponse = responseSchema.parse(await (await app.request("/api/v1/resources?namespace=data-platform&pageSize=100")).json());
  expect(namespaceResponse.data.length).toBeGreaterThan(0);
  expect(namespaceResponse.data.every((resource) => resource.namespace === "data-platform")).toBe(true);
  const kindResponse = responseSchema.parse(await (await app.request("/api/v1/resources?kind=Pod&pageSize=100")).json());
  expect(kindResponse.data.length).toBeGreaterThan(0);
  expect(kindResponse.data.every((resource) => resource.kind === "Pod")).toBe(true);
});

test("resource list rejects an unknown kind", async () => {
  const response = await createApp().request("/api/v1/resources?kind=Container");
  expect(response.status).toBe(400);
  expect(errorResponseSchema.parse(await response.json()).error.code).toBe("VALIDATION_ERROR");
});

test("resource detail returns its resource or the standard 404 envelope", async () => {
  const app = createApp();
  const found = await app.request("/api/v1/resources/k8s-pod-flink-jobmanager");
  expect(resourceSchema.parse(await found.json()).relatedEventIds).toContain("evt-3");
  const missing = await app.request("/api/v1/resources/missing");
  expect(missing.status).toBe(404);
  expect(errorResponseSchema.parse(await missing.json()).error.code).toBe("NOT_FOUND");
});

test("resource schema only accepts absolute HTTP(S) logs URLs", () => {
  const base = { id: "fixture-resource", kind: "Pod", name: "fixture", namespace: "test", status: "healthy", relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [] };
  expect(resourceSchema.parse({ ...base, logsUrl: "https://logs.example.test/pod" }).logsUrl).toBe("https://logs.example.test/pod");
  expect(resourceSchema.parse({ ...base, logsUrl: "http://logs.example.test/pod" }).logsUrl).toBe("http://logs.example.test/pod");
  for (const logsUrl of ["javascript:alert(1)", "data:text/plain,hello", "/relative/path"]) {
    expect(resourceSchema.safeParse({ ...base, logsUrl }).success).toBe(false);
  }
});

test("resource detail returns a test-local HTTPS logs URL", async () => {
  const fixture = resourceSchema.parse({ id: "fixture-resource", kind: "Pod", name: "fixture", namespace: "test", status: "healthy", relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: "https://logs.example.test/pod" });
  const app = new OpenAPIHono();
  const { registerResourceRoutes } = await import("../src/routes/resources.js");
  registerResourceRoutes(app, [fixture]);
  const response = await app.request("/api/v1/resources/fixture-resource");
  expect(response.status).toBe(200);
  expect(resourceSchema.parse(await response.json()).logsUrl).toBe("https://logs.example.test/pod");
});

test("resource list filters the new Endpoint and Job kinds", async () => {
  const app = createApp();
  for (const kind of ["Endpoint", "Job"]) {
    const body = responseSchema.parse(await (await app.request(`/api/v1/resources?kind=${kind}&pageSize=100`)).json());
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((resource) => resource.kind === kind)).toBe(true);
  }
});

test("PVC storage fields are optional: present on the stub PVC, absent fixtures still validate", () => {
  const pvc = resources.find((resource) => resource.kind === "PersistentVolumeClaim");
  expect(pvc?.capacity).toBe("128Gi");
  expect(pvc?.storageClass).toBeTruthy();
  const legacy = { id: "legacy-pvc", kind: "PersistentVolumeClaim", name: "legacy", namespace: "test", status: "healthy", relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null };
  const parsed = resourceSchema.parse(legacy);
  expect(parsed.capacity).toBeUndefined();
  expect(parsed.storageClass).toBeUndefined();
  expect(resourceSchema.safeParse({ ...legacy, capacity: "" }).success).toBe(false);
});
