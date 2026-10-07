// Boots the full app through the same wiring server.ts uses (createRuntime + loadUpstreamWiring + createApp)
// for every on/off combination of the three opt-in adapters, against fake upstreams. Payloads are
// spec-derived (Trino/Iceberg) or the recorded Flink fixtures; nothing here talks to a real cluster.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createRuntime } from "../src/adapters/runtime.js";
import { TRINO_HISTORY_ACK_VALUE, loadUpstreamWiring } from "../src/adapters/upstream/config.js";
import { createApp } from "../src/app.js";
import { json } from "./helpers/mockUpstream.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/flink-1.20/${name}`, import.meta.url)), "utf8"));
const FLINK_JIDS = ["e4ce0083a91b9378cd054e129326abf7", "5ec600a747e2a2be1d5bc75b6d5a98ad", "e1c03f689440a936a1ff5304c6934440"];
const FLINK_DETAIL: Record<string, string> = {
  [FLINK_JIDS[0]!]: "job-cdc_orders.json", [FLINK_JIDS[1]!]: "job-cdc_customers.json", [FLINK_JIDS[2]!]: "job-events_sessionization.json",
};

function fakeNetwork() {
  const hosts: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    hosts.push(url.host);
    expect(init?.method ?? "GET").toBe("GET");
    if (url.host === "flink.test:8081") {
      if (url.pathname === "/overview") return json(fixture("overview.json"));
      if (url.pathname === "/jobs/overview") return json(fixture("jobs-overview.json"));
      const file = FLINK_DETAIL[url.pathname.replace("/jobs/", "")];
      return file ? json(fixture(file)) : json({ errors: ["nf"] }, 404);
    }
    if (url.host === "trino.test") {
      return json([{ queryId: "q1", state: "FINISHED", query: "SELECT * FROM t WHERE a = 'secret'" }]);
    }
    if (url.host === "catalog.test") {
      if (url.pathname === "/catalog/v1/config") return json({ overrides: { prefix: "wh1" } });
      if (url.pathname === "/catalog/v1/wh1/namespaces") return json({ namespaces: [["analytics"]] });
    }
    return json({ error: { message: "unexpected", type: "X", code: 404 } }, 404);
  }) as typeof fetch;
  return { impl, hosts };
}

const ENV = {
  flink: { BELUGA_FLINK_REST_URL: "http://flink.test:8081" },
  trino: {
    BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "https://trino.test", BELUGA_TRINO_TOKEN: "t.k",
    BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE,
  },
  lakekeeper: {
    BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.test",
    BELUGA_LAKEKEEPER_WAREHOUSES: "beluga_lake=wh", BELUGA_LAKEKEEPER_TOKEN: "t.k",
  },
} as const;

function boot(enabled: { flink: boolean; trino: boolean; lakekeeper: boolean }) {
  const env: Record<string, string> = {
    ...(enabled.flink ? ENV.flink : {}), ...(enabled.trino ? ENV.trino : {}), ...(enabled.lakekeeper ? ENV.lakekeeper : {}),
  };
  const net = fakeNetwork();
  const { registry, pipelineAdapter } = createRuntime(env, net.impl);
  const upstream = loadUpstreamWiring(env, net.impl);
  const app = createApp(registry, upstream.queryHistoryAdapter, pipelineAdapter, upstream.dataAssetSource);
  return { app, net };
}
const get = async (app: ReturnType<typeof boot>["app"], path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as any };
};

const combos = [false, true].flatMap((flink) => [false, true].flatMap((trino) => [false, true].map((lakekeeper) => ({ flink, trino, lakekeeper }))));

test.each(combos)("combination flink=$flink trino=$trino lakekeeper=$lakekeeper: each adapter is independent", async (combo) => {
  const { app, net } = boot(combo);

  const pipelines = await get(app, "/api/v1/pipelines?pageSize=100");
  expect(pipelines.status).toBe(200);
  const ids: string[] = pipelines.body.data.map((p: { id: string }) => p.id);
  if (combo.flink) {
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("pl-flink-"))).toBe(true);
  } else {
    expect(ids).toContain("pl-lakehouse-ingest"); // stub pipelines
  }

  const history = await get(app, "/api/v1/query-history");
  if (combo.trino) {
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual([{ id: "q1", sql: "SELECT * FROM t WHERE a = ?", state: "FINISHED" }]);
  } else {
    expect(history.status).toBe(503);
  }

  const assets = await get(app, "/api/v1/data-assets?pageSize=100");
  expect(assets.status).toBe(200);
  if (combo.lakekeeper) {
    expect(assets.body.data.map((a: { id: string }) => a.id)).toEqual(["asset-catalog-beluga_lake"]);
    expect(assets.body.warnings.map((w: { code: string }) => w.code)).toContain("NODE_AUTHZ_NOT_ENFORCED");
    const schemas = await get(app, "/api/v1/data-assets?parentId=asset-catalog-beluga_lake");
    expect(schemas.body.data.map((a: { id: string }) => a.id)).toEqual(["asset-schema-beluga_lake.analytics"]);
  } else {
    expect(assets.body.data.map((a: { id: string }) => a.id)).toContain("asset-table-orders"); // fixtures
  }

  // services: svc-flink is live only with the Flink adapter; other services stay stubs regardless.
  const services = await get(app, "/api/v1/services?pageSize=100");
  expect(services.status).toBe(200);
  expect(services.body.data.map((s: { id: string }) => s.id)).toContain("svc-trino");

  // an adapter only ever talks to its own upstream
  const allowed = new Set([
    ...(combo.flink ? ["flink.test:8081"] : []), ...(combo.trino ? ["trino.test"] : []), ...(combo.lakekeeper ? ["catalog.test"] : []),
  ]);
  expect(net.hosts.every((h) => allowed.has(h))).toBe(true);
  for (const host of allowed) expect(net.hosts).toContain(host);
});

test("neither adapter: the app makes no upstream calls at all (stubs only)", async () => {
  const { app, net } = boot({ flink: false, trino: false, lakekeeper: false });
  await get(app, "/api/v1/pipelines");
  await get(app, "/api/v1/query-history");
  await get(app, "/api/v1/data-assets");
  await get(app, "/api/v1/data-assets/asset-table-orders/query-context");
  await get(app, "/api/v1/services");
  expect(net.hosts).toEqual([]);
});

test("a misconfigured Trino/Lakekeeper adapter is only disabled (diagnostic), it never disables Flink", () => {
  const env = { ...ENV.flink, BELUGA_TRINO_ENABLED: "true", BELUGA_LAKEKEEPER_ENABLED: "true" };
  const net = fakeNetwork();
  const runtime = createRuntime(env, net.impl);
  const upstream = loadUpstreamWiring(env, net.impl);
  expect(runtime.pipelineAdapter).toBeDefined();
  expect(upstream.queryHistoryAdapter).toBeUndefined();
  expect(upstream.dataAssetSource).toBeUndefined();
  expect(upstream.diagnostics).toHaveLength(2);
});
