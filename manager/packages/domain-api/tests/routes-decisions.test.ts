import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { decisionRecordSchema } from "../src/schema/decision.js";
import { decisions } from "../src/stub-data/decisions.js";

const responseSchema = listResponseSchema(decisionRecordSchema, "DecisionListResponseTest");

test("decision list returns the paginated read-only projection", async () => {
  const response = await createApp().request("/api/v1/decisions?pageSize=100");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.data).toHaveLength(decisions.length);
  expect(body.meta.total).toBe(decisions.length);
  expect(body.data.every((record) => !('latencyMs' in record.result))).toBe(true);
  expect(body.data.every((record) => record.freshnessPolicy.maxAgeMs === 60_000)).toBe(true);
  expect(body.data[0]?.result.evidenceRefs).toEqual([]);
  expect(body.data[0]?.inputSignals.map(({ freshAtEvaluation }) => freshAtEvaluation)).toEqual([true, true]);
  expect(body.data[1]?.inputSignals.map(({ freshAtEvaluation }) => freshAtEvaluation)).toEqual([false]);
  expect(body.data[2]?.inputSignals).toEqual([]);
  expect(body.data.filter((record) => record.result.decision === 'ABSTAIN').every((record) => Boolean(record.result.abstainCode))).toBe(true);
  expect(body.data.filter((record) => record.result.decision === 'NORMAL').every((record) => record.result.abstainCode === undefined)).toBe(true);
  expect(body.data.map((record) => record.result.decision)).toEqual(["NORMAL", "ABSTAIN", "ABSTAIN"]);
});

test("decision pagination supports pages beyond the total and boundary page sizes", async () => {
  const app = createApp();
  const first = responseSchema.parse(await (await app.request("/api/v1/decisions?page=1&pageSize=1")).json());
  expect(first.data).toHaveLength(1);
  expect(first.meta.total).toBe(decisions.length);
  const beyond = responseSchema.parse(await (await app.request("/api/v1/decisions?page=99&pageSize=100")).json());
  expect(beyond.data).toEqual([]);
  expect(beyond.meta).toMatchObject({ total: decisions.length, page: 99, pageSize: 100 });
});

test("decision query filters by enum and rejects invalid values", async () => {
  const app = createApp();
  const filtered = responseSchema.parse(await (await app.request("/api/v1/decisions?decision=ABSTAIN")).json());
  expect(filtered.data.length).toBe(2);
  expect(filtered.data.every((record) => record.result.decision === "ABSTAIN")).toBe(true);
  const invalid = await app.request("/api/v1/decisions?decision=UNKNOWN");
  expect(invalid.status).toBe(400);
  expect(errorResponseSchema.parse(await invalid.json()).error.code).toBe("VALIDATION_ERROR");
});

test("decision detail uses the standard 404 envelope", async () => {
  const found = await createApp().request("/api/v1/decisions/decision-fresh");
  expect(decisionRecordSchema.parse(await found.json()).result.confidence).toBe(0.1);
  const missing = await createApp().request("/api/v1/decisions/missing");
  expect(missing.status).toBe(404);
  expect(errorResponseSchema.parse(await missing.json()).error.code).toBe("NOT_FOUND");
});

test("decision projection is stable across app instances", async () => {
  const first = await (await createApp().request("/api/v1/decisions?pageSize=100")).json();
  const second = await (await createApp().request("/api/v1/decisions?pageSize=100")).json();
  expect(second).toEqual(first);
});

test("decision endpoint does not expose write operations", async () => {
  const doc = await (await createApp().request("/api/v1/openapi.json")).json() as { paths: Record<string, Record<string, unknown>> };
  expect(Object.keys(doc.paths["/api/v1/decisions"] ?? {})).toEqual(["get"]);
  expect(Object.keys(doc.paths["/api/v1/decisions/{id}"] ?? {})).toEqual(["get"]);
});
