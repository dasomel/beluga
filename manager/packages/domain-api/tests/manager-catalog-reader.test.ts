import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { listResponseSchema } from "../src/schema/envelope.js";
import { dataAssetSchema, dataAssetDetailSchema } from "../src/schema/dataAsset.js";
import { domainApiHealthSchema } from "../src/routes/health.js";
import { loadUpstreamWiring } from "../src/adapters/upstream/config.js";
import { clientCredentialsProvider } from "../src/adapters/upstream/clientCredentials.js";
import { json, mockFetch } from "./helpers/mockUpstream.js";

const credentials = { endpoint: "https://sso.test/token", clientId: "reader", clientSecret: "SECRET", allowInsecureBearer: false };
afterEach(() => vi.useRealTimers());

test("coalesces token exchange, refreshes below expiry and fails closed without leaking credential errors", async () => {
  let now = 0;
  const fetchImpl = vi.fn(async (_url, init) => {
    expect(init.redirect).toBe("error");
    expect(new URLSearchParams(init.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(init.body).get("client_secret")).toBe("SECRET");
    return json({ access_token: "first", token_type: "Bearer", expires_in: 300 });
  });
  const provider = clientCredentialsProvider({ ...credentials, fetchImpl: fetchImpl as typeof fetch, now: () => now });
  expect(await Promise.all([provider.getToken(), provider.getToken()])).toEqual(["first", "first"]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now = 269999;
  expect(await provider.getToken()).toBe("first");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now = 270000;
  fetchImpl.mockRejectedValueOnce(new Error("SECRET malicious error body"));
  expect(await provider.getToken()).toBeNull();
  expect(await provider.getToken()).toBe("first");
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

test("bounds token timeout, rejects redirect/error/malformed/oversized responses and retries", async () => {
  vi.useFakeTimers();
  const pending = clientCredentialsProvider({ ...credentials, fetchImpl: (() => new Promise(() => {})) as typeof fetch }).getToken();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toBeNull();
  for (const response of [json({ error: "SECRET" }, 401), json({}, 302), json({ access_token: "bad token", expires_in: 300, token_type: "bearer" }),
    json({ access_token: "ok", expires_in: 0, token_type: "bearer" }), json({ access_token: "ok", expires_in: 300 }),
    new Response("x".repeat(65537)), new Response("malformed SECRET")]) {
    expect(await clientCredentialsProvider({ ...credentials, fetchImpl: (async () => response) as typeof fetch }).getToken()).toBeNull();
  }
  for (const endpoint of ["ftp://sso/token", "https://user:SECRET@sso/token", "http://sso/token", "https://sso/token?secret=SECRET"]) {
    expect(() => clientCredentialsProvider({ ...credentials, endpoint })).toThrow();
  }
});

const env = { BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.test",
  BELUGA_LAKEKEEPER_WAREHOUSES: "iceberg=lake", BELUGA_LAKEKEEPER_TOKEN_ENDPOINT: credentials.endpoint,
  BELUGA_LAKEKEEPER_CLIENT_ID: credentials.clientId, BELUGA_LAKEKEEPER_CLIENT_SECRET: credentials.clientSecret,
  BELUGA_LAKEKEEPER_NAMES_ONLY: "true" };

test("reader config fails fast for missing or conflicting credentials", () => {
  for (const name of ["BELUGA_LAKEKEEPER_CLIENT_ID", "BELUGA_LAKEKEEPER_CLIENT_SECRET", "BELUGA_LAKEKEEPER_TOKEN_ENDPOINT"]) {
    expect(() => loadUpstreamWiring({ ...env, [name]: "" })).toThrow(name);
  }
  expect(() => loadUpstreamWiring({ ...env, BELUGA_LAKEKEEPER_TOKEN: "static" })).toThrow("mutually exclusive");
});

test("authenticated non-admin overview counts nested namespaces and tables, returns names only, never falls back on outage", async () => {
  let failed = false;
  const { impl, calls } = mockFetch(({ url, method }) => {
    if (method === "POST") return json({ access_token: "service-token", expires_in: 300, token_type: "bearer" });
    if (failed) return json({}, 503);
    if (url.pathname.endsWith("/config")) return json({ overrides: { prefix: "warehouse-id" } });
    if (url.pathname.endsWith("/namespaces")) {
      const parent = url.searchParams.get("parent");
      return json({ namespaces: parent === null ? [["lake"]] : parent === "lake" ? [["lake", "nested"]] : [] });
    }
    if (url.pathname.endsWith("/tables")) {
      return json({ identifiers: [{ namespace: ["lake"], name: "orders" }], "storage-credentials": [{ secret: "MUST-NOT-LEAK" }] });
    }
    throw new Error("unexpected metadata load");
  });
  const source = loadUpstreamWiring({ ...env, BELUGA_LAKEKEEPER_CACHE_TTL_MS: "0", BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS: "0" }, impl).dataAssetSource;
  const app = createApp(undefined, undefined, undefined, source, undefined, { verify: async () => ({ sub: "analyst", groups: [] }) });
  const auth = { headers: { Authorization: "Bearer user-token" } };
  expect((await app.request("/api/v1/data-assets?kind=table")).status).toBe(401);
  const tables = listResponseSchema(dataAssetSchema, "ReaderTables").parse(await (await app.request("/api/v1/data-assets?kind=table&pageSize=1", auth)).json());
  expect(tables.meta.total).toBe(2);
  expect(tables.data).toHaveLength(1);
  expect(tables.data[0]!.name).toBe("lake.orders");
  const schemas = listResponseSchema(dataAssetSchema, "ReaderSchemas").parse(await (await app.request("/api/v1/data-assets?kind=schema", auth)).json());
  expect(schemas.meta.total).toBe(2);
  const detail = dataAssetDetailSchema.parse(await (await app.request(`/api/v1/data-assets/${tables.data[0]!.id}`, auth)).json());
  expect(detail.columns).toBeUndefined();
  expect(JSON.stringify(detail)).not.toMatch(/MUST-NOT-LEAK|location|properties|metadataSummary/);
  expect(calls.filter((c) => c.method === "GET").every((c) => c.headers.get("Authorization") === "Bearer service-token")).toBe(true);
  expect(domainApiHealthSchema.parse(await (await app.request("/api/v1/health")).json()).components.lakekeeper).toBe("live");
  failed = true;
  expect((await app.request("/api/v1/data-assets?kind=table", auth)).status).toBe(503);
});

test("overview totals drain catalog pages and refuse a truncated count", async () => {
  let truncate = false;
  const { impl } = mockFetch(({ url }) => {
    if (url.pathname.endsWith("config")) return json({ overrides: { prefix: "wh" } });
    if (url.pathname.endsWith("namespaces")) {
      return json({ namespaces: url.searchParams.has("parent") ? [] : [["lake"]] });
    }
    const page = url.searchParams.get("pageToken");
    return json({ identifiers: [{ namespace: ["lake"], name: page ? "customers" : "orders" }],
      "next-page-token": truncate || !page ? "next" : null });
  });
  const source = loadUpstreamWiring({ BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.test",
    BELUGA_LAKEKEEPER_WAREHOUSES: "iceberg=lake", BELUGA_LAKEKEEPER_TOKEN: "reader", BELUGA_LAKEKEEPER_NAMES_ONLY: "true",
    BELUGA_LAKEKEEPER_CACHE_TTL_MS: "0", BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS: "0" }, impl).dataAssetSource;
  const app = createApp(undefined, undefined, undefined, source);
  const result = listResponseSchema(dataAssetSchema, "PagedReaderTables").parse(await (await app.request("/api/v1/data-assets?kind=table&pageSize=1")).json());
  expect(result.meta.total).toBe(2);
  truncate = true;
  expect((await app.request("/api/v1/data-assets?kind=table&pageSize=1")).status).toBe(503);
  expect((await app.request("/api/v1/data-assets/asset-table-iceberg.lake.missing")).status).toBe(503);
});
