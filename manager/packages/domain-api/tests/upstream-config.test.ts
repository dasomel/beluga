import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { loadUpstreamWiring, parseWarehouses, TRINO_HISTORY_ACK_VALUE } from "../src/adapters/upstream/config.js";
import { json, mockFetch } from "./helpers/mockUpstream.js";

const SECRET = "tok-SECRET-VALUE";

test("default (no env) disables every upstream adapter, so CI/dev keep using stubs", async () => {
  const wiring = loadUpstreamWiring({});
  expect(wiring).toEqual({ diagnostics: [] });
  expect((await createApp(undefined, wiring.queryHistoryAdapter, undefined, wiring.dataAssetSource).request("/api/v1/query-history")).status).toBe(503);
});

test("enabling without base URL/token, or without the shared-visibility ack, leaves history disabled", () => {
  expect(loadUpstreamWiring({ BELUGA_TRINO_ENABLED: "true" }).queryHistoryAdapter).toBeUndefined();
  const noAck = loadUpstreamWiring({ BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "https://trino.example", BELUGA_TRINO_TOKEN: SECRET });
  expect(noAck.queryHistoryAdapter).toBeUndefined();
  expect(noAck.diagnostics.join()).toContain("BELUGA_TRINO_HISTORY_ACK");
});

test("fully configured wiring enables read-only adapters; diagnostics never contain the token", async () => {
  const { impl, calls } = mockFetch(() => json([]));
  const wiring = loadUpstreamWiring({
    BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "https://trino.example", BELUGA_TRINO_TOKEN: SECRET,
    BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE, BELUGA_TRINO_USER: "svc",
    BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.example/", BELUGA_LAKEKEEPER_WAREHOUSES: "beluga_lake=wh1",
    BELUGA_LAKEKEEPER_TOKEN: SECRET,
  }, impl);
  expect(wiring.queryHistoryAdapter).toBeDefined();
  expect(wiring.dataAssetSource).toBeDefined();
  expect(wiring.diagnostics.join()).not.toContain(SECRET);
  await createApp(undefined, wiring.queryHistoryAdapter, undefined, wiring.dataAssetSource).request("/api/v1/query-history");
  expect(calls[0]?.url.href).toBe("https://trino.example/v1/query");
  expect(calls[0]?.headers.get("x-trino-user")).toBe("svc");
});

test("bearer over plain in-cluster http is refused unless explicitly allowed", () => {
  const env = { BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "http://trino.analytics.svc:8080", BELUGA_TRINO_TOKEN: SECRET, BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE };
  const refused = loadUpstreamWiring(env);
  expect(refused.queryHistoryAdapter).toBeUndefined();
  expect(refused.diagnostics.join()).toContain("plain http");
  expect(loadUpstreamWiring({ ...env, BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER: "true" }).queryHistoryAdapter).toBeDefined();
});

test("parseWarehouses supports `warehouse` and `catalog=warehouse`, dropping blanks", () => {
  expect(parseWarehouses("a, b=wh2 ,,=x")).toEqual([{ name: "a", warehouse: "a" }, { name: "b", warehouse: "wh2" }]);
});
