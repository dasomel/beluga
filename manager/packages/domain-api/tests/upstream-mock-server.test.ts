// Integration of the dev fake-upstream server (packages/domain-api/dev/mock-upstreams.mjs, issue #252) with the REAL
// adapters through createAppFromEnv: real HTTP on 127.0.0.1 ephemeral ports, real fetch, no injected fetchImpl.
// This proves adapter WIRING (env contract, paths, auth header, parsing) against dummy data. It proves nothing
// about real Flink / Trino / Lakekeeper behaviour.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DUMMY_TOKEN, startMockUpstreams, type MockUpstreams } from "../dev/mock-upstreams.mjs";
import { createAppFromEnv } from "../src/wiring.js";

const ENV_FILE = fileURLToPath(new URL("../dev/mock-upstreams.env", import.meta.url));
const TOKEN_FILE = fileURLToPath(new URL("../dev/mock-upstreams/dev-token", import.meta.url));
let mock: MockUpstreams;

beforeAll(async () => {
  mock = await startMockUpstreams(); // ephemeral ports
});
afterAll(async () => {
  await mock.close();
});
afterEach(() => vi.restoreAllMocks());

function envFor(overrides: Record<string, string> = {}): Record<string, string> {
  const origin = (port: number) => `http://${mock.host}:${port}`;
  return {
    NODE_ENV: "development",
    AUTH_MODE: "disabled",
    BELUGA_FLINK_REST_URL: origin(mock.ports.flink),
    BELUGA_TRINO_ENABLED: "true",
    BELUGA_TRINO_BASE_URL: origin(mock.ports.trino),
    BELUGA_TRINO_TOKEN: DUMMY_TOKEN,
    BELUGA_TRINO_HISTORY_ACK: "shared-service-credential",
    BELUGA_LAKEKEEPER_ENABLED: "true",
    BELUGA_LAKEKEEPER_BASE_URL: origin(mock.ports.lakekeeper),
    BELUGA_LAKEKEEPER_WAREHOUSES: "beluga_lake",
    BELUGA_LAKEKEEPER_TOKEN: DUMMY_TOKEN,
    ...overrides,
  };
}

const getJson = async (app: { request(path: string): Response | Promise<Response> }, path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as any };
};

test("all three adapters serve live data from the fake upstreams", async () => {
  const { app, flinkEnabled } = createAppFromEnv(envFor());
  expect(flinkEnabled).toBe(true);

  const pipelines = await getJson(app, "/api/v1/pipelines");
  expect(pipelines.status).toBe(200);
  expect(pipelines.body.data.map((p: { name: string }) => p.name).sort()).toEqual([
    "beluga-cdc_customers",
    "beluga-cdc_orders",
    "beluga-events_sessionization",
  ]);

  const history = await getJson(app, "/api/v1/query-history");
  expect(history.status).toBe(200);
  expect(history.body.data.map((q: { id: string }) => q.id)).toEqual([
    "20261007_000001_00001_abcde",
    "20261007_000002_00001_abcde",
    "20261007_000003_00001_abcde",
  ]);
  expect(history.body.data[0].sql).toContain("email = ?"); // literal redaction is applied by the adapter, not the fake
  expect(JSON.stringify(history.body)).not.toContain("dev@example.invalid");

  const catalogs = await getJson(app, "/api/v1/data-assets");
  expect(catalogs.status).toBe(200);
  expect(catalogs.body.data.map((a: { id: string }) => a.id)).toEqual(["asset-catalog-beluga_lake"]);
  const schemas = await getJson(app, "/api/v1/data-assets?parentId=asset-catalog-beluga_lake");
  expect(schemas.body.data.map((a: { id: string }) => a.id)).toEqual(["asset-schema-beluga_lake.analytics", "asset-schema-beluga_lake.raw"]);
  const tables = await getJson(app, "/api/v1/data-assets?parentId=asset-schema-beluga_lake.analytics");
  expect(tables.body.data.map((a: { id: string }) => a.id)).toEqual([
    "asset-schema-beluga_lake.analytics.marts",
    "asset-table-beluga_lake.analytics.orders",
    "asset-table-beluga_lake.analytics.customers",
  ]);
  const detail = await getJson(app, "/api/v1/data-assets/asset-table-beluga_lake.analytics.orders");
  expect(detail.status).toBe(200);
  expect(detail.body.columns.map((c: { name: string }) => c.name)).toEqual(["order_id", "order_date", "email", "amount"]);
  expect(detail.body.columns.find((c: { name: string }) => c.name === "order_date").isPartition).toBe(true);
  expect(JSON.stringify(detail.body)).not.toContain(DUMMY_TOKEN);
});

test("the shipped dummy token FILE works through BELUGA_*_TOKEN_FILE", async () => {
  const { app } = createAppFromEnv(
    envFor({ BELUGA_TRINO_TOKEN: "", BELUGA_LAKEKEEPER_TOKEN: "", BELUGA_TRINO_TOKEN_FILE: TOKEN_FILE, BELUGA_LAKEKEEPER_TOKEN_FILE: TOKEN_FILE }),
  );
  expect((await getJson(app, "/api/v1/query-history")).status).toBe(200);
  expect((await getJson(app, "/api/v1/data-assets")).status).toBe(200);
});

test("a wrong token degrades Trino history and the Lakekeeper catalog to 503, and leaks nothing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const wrong = "wrong-dummy-token";
  const { app } = createAppFromEnv(envFor({ BELUGA_TRINO_TOKEN: wrong, BELUGA_LAKEKEEPER_TOKEN: wrong }));

  const history = await app.request("/api/v1/query-history");
  const historyText = await history.text();
  expect(history.status).toBe(503);
  expect(historyText).toContain("did not accept Manager's service credential");
  expect(historyText + JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(wrong);
  expect(historyText).not.toContain("20261007");

  const assets = await app.request("/api/v1/data-assets");
  expect(assets.status).toBe(503);
  expect(await assets.text()).not.toContain("beluga_lake");

  // Flink's REST client sends no credential, so the token is not part of its contract: still live.
  expect((await app.request("/api/v1/pipelines")).status).toBe(200);
});

test("the fake itself: GET only, 401 without the dummy token, Flink needs none", async () => {
  const trino = `http://${mock.host}:${mock.ports.trino}/v1/query`;
  expect((await fetch(trino)).status).toBe(401);
  expect((await fetch(trino, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await fetch(trino, { headers: { authorization: `Bearer ${DUMMY_TOKEN}` } })).status).toBe(200);
  for (const [port, path] of [[mock.ports.flink, "/overview"], [mock.ports.trino, "/v1/query"], [mock.ports.lakekeeper, "/catalog/v1/config"]] as const) {
    const response = await fetch(`http://${mock.host}:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${DUMMY_TOKEN}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  }
  expect((await fetch(`http://${mock.host}:${mock.ports.flink}/overview`)).status).toBe(200);
  expect((await fetch(`http://${mock.host}:${mock.ports.lakekeeper}/catalog/v1/config?warehouse=beluga_lake`)).status).toBe(401);
});

test("mock-upstreams.env overrides an inherited real token file, so no real credential reaches the fake", async () => {
  // Parse the documented `set -a; . mock-upstreams.env` file and apply it over a shell that still has real settings.
  const fromFile = Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const inherited = { BELUGA_TRINO_TOKEN_FILE: "/nonexistent/real-trino-token", BELUGA_LAKEKEEPER_TOKEN_FILE: "/nonexistent/real-lk-token" };
  const origin = (port: number) => `http://${mock.host}:${port}`;
  const env = {
    ...inherited,
    ...fromFile,
    BELUGA_FLINK_REST_URL: origin(mock.ports.flink),
    BELUGA_TRINO_BASE_URL: origin(mock.ports.trino),
    BELUGA_LAKEKEEPER_BASE_URL: origin(mock.ports.lakekeeper),
  };
  // A surviving *_TOKEN_FILE would fail startup (missing file); the dummy static token must be used instead.
  const { app } = createAppFromEnv(env);
  expect((await getJson(app, "/api/v1/query-history")).status).toBe(200);
  expect((await getJson(app, "/api/v1/data-assets")).status).toBe(200);
});
