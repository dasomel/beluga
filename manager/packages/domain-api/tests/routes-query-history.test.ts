import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { QueryHistoryAdapter } from "../src/adapters/queryHistory.js";
import { queryHistoryResponseSchema } from "../src/schema/queryHistory.js";

const rows = [
  { id: "q1", sql: "SELECT 1", state: "FINISHED" },
  { id: "q2", sql: "SELECT 2", state: "RUNNING" },
];
const stub: QueryHistoryAdapter = { listQueryHistory: async () => rows };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("default app explicitly reports unsupported history, not fabricated data", async () => {
  expect((await createApp().request("/api/v1/query-history")).status).toBe(503);
});

test("injected test stub preserves adapter order and paginates without invented metadata", async () => {
  const response = await createApp(undefined, stub).request("/api/v1/query-history?page=2&pageSize=1");
  expect(response.status).toBe(200);
  expect(queryHistoryResponseSchema.parse(await response.json())).toEqual({
    data: [rows[1]], meta: { total: 2, page: 2, pageSize: 1 },
  });
  expect(rows).toHaveLength(2);
});

test("empty available snapshot is 200, including pages beyond the snapshot", async () => {
  const response = await createApp(undefined, stub).request("/api/v1/query-history?page=3&pageSize=1");
  expect(queryHistoryResponseSchema.parse(await response.json())).toEqual({ data: [], meta: { total: 2, page: 3, pageSize: 1 } });
  expect((await createApp(undefined, { listQueryHistory: async () => [] }).request("/api/v1/query-history")).status).toBe(200);
});

test.each(["page=0", "page=1.5", "pageSize=101", "page=abc"])("invalid pagination %s is rejected before fetching", async (query) => {
  const listQueryHistory = vi.fn(async () => rows);
  const response = await createApp(undefined, { listQueryHistory }).request(`/api/v1/query-history?${query}`);
  expect(response.status).toBe(400);
  expect(listQueryHistory).not.toHaveBeenCalled();
});

test("503 body carries the SERVICE_UNAVAILABLE error code", async () => {
  const body = (await (await createApp().request("/api/v1/query-history")).json()) as { error: { code: string } };
  expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
});

test("upstream errors and invalid records degrade without exposing internal details", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const adapter of [
    { listQueryHistory: async () => { throw new Error("secret upstream detail"); } },
    { listQueryHistory: async () => [{ id: "", sql: "SELECT 1", state: "RUNNING" }] },
  ]) {
    const response = await createApp(undefined, adapter).request("/api/v1/query-history");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  }
});

test("a hanging adapter is bounded by the existing adapter deadline", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const pending = createApp(undefined, { listQueryHistory: () => new Promise(() => {}) }).request("/api/v1/query-history");
  await vi.advanceTimersByTimeAsync(3000);
  expect((await pending).status).toBe(503);
});

test("history is documented as a read-only OpenAPI contract", async () => {
  const response = await createApp().request("/api/v1/openapi.json");
  const document = (await response.json()) as any;
  expect(Object.keys(document.paths["/api/v1/query-history"])).toEqual(["get"]);
  expect(document.components.schemas.QueryHistoryEntry).toBeDefined();
});
