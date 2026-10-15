import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { loadUpstreamWiring, parseWarehouses, TRINO_HISTORY_ACK_VALUE } from "../src/adapters/upstream/config.js";
import { ConfigError } from "../src/config.js";
import { json, mockFetch } from "./helpers/mockUpstream.js";

const SECRET = "tok-SECRET-VALUE";

test("default (no env) disables every upstream adapter, so CI/dev keep using stubs", async () => {
  const wiring = loadUpstreamWiring({});
  expect(wiring).toEqual({ diagnostics: [] });
  expect((await createApp(undefined, wiring.queryHistoryAdapter, undefined, wiring.dataAssetSource).request("/api/v1/query-history")).status).toBe(503);
});

const TRINO_OK = { BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "https://trino.example", BELUGA_TRINO_TOKEN: SECRET, BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE };
const LK_OK = { BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.example", BELUGA_LAKEKEEPER_WAREHOUSES: "w", BELUGA_LAKEKEEPER_TOKEN: SECRET };
const fails = (env: Record<string, string>, pattern: RegExp) => {
  let error: unknown;
  try { loadUpstreamWiring(env); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toMatch(pattern);
  expect((error as Error).message).not.toContain(SECRET);
};

test("valid minimal configurations load", () => {
  expect(loadUpstreamWiring(TRINO_OK).queryHistoryAdapter).toBeDefined();
  expect(loadUpstreamWiring(LK_OK).dataAssetSource).toBeDefined();
  expect(loadUpstreamWiring({ BELUGA_TRINO_ENABLED: "false", BELUGA_LAKEKEEPER_ENABLED: "" })).toEqual({ diagnostics: [] });
});

test("fail-fast (like Flink): an enabled adapter with missing/invalid settings throws ConfigError, never silently disables", () => {
  fails({ BELUGA_TRINO_ENABLED: "true" }, /BELUGA_TRINO_BASE_URL/);
  fails({ ...TRINO_OK, BELUGA_TRINO_BASE_URL: "not a url" }, /valid http\(s\) URL/);
  fails({ ...TRINO_OK, BELUGA_TRINO_BASE_URL: "ftp://trino" }, /http/);
  fails({ ...TRINO_OK, BELUGA_TRINO_TOKEN: undefined as never, BELUGA_TRINO_TOKEN_FILE: undefined as never }, /TOKEN/);
  fails({ ...TRINO_OK, BELUGA_TRINO_TOKEN: "bad token\nX: 1" }, /not a valid bearer token/);
  fails({ ...TRINO_OK, BELUGA_TRINO_HISTORY_ACK: "yes" }, /BELUGA_TRINO_HISTORY_ACK/);
  fails({ ...TRINO_OK, BELUGA_TRINO_HISTORY_SQL: "all" }, /BELUGA_TRINO_HISTORY_SQL/);
  fails({ ...TRINO_OK, BELUGA_TRINO_USER: "a\nb" }, /BELUGA_TRINO_USER/);
  fails({ ...LK_OK, BELUGA_LAKEKEEPER_WAREHOUSES: " , ," }, /WAREHOUSES/);
  fails({ ...LK_OK, BELUGA_LAKEKEEPER_BASE_URL: "nope" }, /valid http\(s\) URL/);
  fails({ ...LK_OK, BELUGA_LAKEKEEPER_BASE_PATH: "catalog" }, /BASE_PATH/);
  fails({ ...LK_OK, BELUGA_LAKEKEEPER_BASE_URL: undefined as never }, /BASE_URL/);
});

test("booleans accept exactly 'true'/'false'; TRUE, 1, yes are rejected", () => {
  for (const bad of ["TRUE", "True", "1", "yes", " true"]) {
    fails({ BELUGA_TRINO_ENABLED: bad }, /BELUGA_TRINO_ENABLED must be exactly/);
    fails({ BELUGA_LAKEKEEPER_ENABLED: bad }, /BELUGA_LAKEKEEPER_ENABLED must be exactly/);
    fails({ ...TRINO_OK, BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER: bad }, /ALLOW_INSECURE_BEARER must be exactly/);
  }
});

test.each([
  ["BELUGA_UPSTREAM_TIMEOUT_MS", ["abc", "-5", "0", "1.5", "30001", "1e3", " 5"]],
  ["BELUGA_UPSTREAM_MAX_CONCURRENT", ["abc", "0", "33", "-1"]],
  ["BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS", ["abc", "-5", "600001"]],
  ["BELUGA_TRINO_HISTORY_CACHE_TTL_MS", ["abc", "-5", "1.5"]],
])("numeric %s rejects invalid values instead of falling back to defaults", (name, bad) => {
  for (const value of bad) fails({ ...TRINO_OK, [name]: value }, new RegExp(`${name} must be an integer`));
  expect(() => loadUpstreamWiring({ ...TRINO_OK, [name]: "5" })).not.toThrow();
});

test("BELUGA_LAKEKEEPER_CACHE_TTL_MS=-5 is rejected; 0 is accepted", () => {
  fails({ ...LK_OK, BELUGA_LAKEKEEPER_CACHE_TTL_MS: "-5" }, /BELUGA_LAKEKEEPER_CACHE_TTL_MS must be an integer/);
  expect(() => loadUpstreamWiring({ ...LK_OK, BELUGA_LAKEKEEPER_CACHE_TTL_MS: "0" })).not.toThrow();
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

test("bearer over plain in-cluster http is refused (ConfigError) unless explicitly allowed", () => {
  const env = { ...TRINO_OK, BELUGA_TRINO_BASE_URL: "http://trino.analytics.svc:8080" };
  fails(env, /plain http/);
  expect(loadUpstreamWiring({ ...env, BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER: "true" }).queryHistoryAdapter).toBeDefined();
});

test("parseWarehouses supports `warehouse` and `catalog=warehouse`, dropping blanks", () => {
  expect(parseWarehouses("a, b=wh2 ,,=x")).toEqual([{ name: "a", warehouse: "a" }, { name: "b", warehouse: "wh2" }]);
});
