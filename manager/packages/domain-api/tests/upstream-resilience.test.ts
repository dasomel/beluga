// Socket-leak (real HTTP server), single-flight/TTL for the Trino adapter, LRU + negative cache + weight bounds.
// Iceberg / Trino payloads are spec-derived, not live-recorded.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { UpstreamError } from "../src/adapters/upstream/errors.js";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { createLakekeeperDataAssetSource } from "../src/adapters/upstream/lakekeeperCatalog.js";
import { createMemo } from "../src/adapters/upstream/memo.js";
import { createTrinoQueryHistoryAdapter } from "../src/adapters/upstream/trinoQueryHistory.js";
import { staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { hangForever, json, mockFetch, type Responder } from "./helpers/mockUpstream.js";

afterEach(() => vi.restoreAllMocks());
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. sockets released on every non-consumed path --------------------------------------------------
async function withServer(handler: Parameters<typeof createServer>[1], run: (url: string, open: () => number) => Promise<void>) {
  let open = 0;
  const server: Server = createServer(handler);
  server.on("connection", (sock) => { open++; sock.on("close", () => { open--; }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => open);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const endless = (res: import("node:http").ServerResponse) => {
  const timer = setInterval(() => res.write("x".repeat(1024)), 1);
  res.on("close", () => clearInterval(timer));
};

test.each([
  ["HTTP 500 with an endless body", (res: import("node:http").ServerResponse) => { res.writeHead(500); endless(res); }, "upstream_error"],
  ["HTTP 403 with an endless body", (res: import("node:http").ServerResponse) => { res.writeHead(403); endless(res); }, "forbidden"],
  ["declared-oversize 200 with an endless body", (res: import("node:http").ServerResponse) => { res.writeHead(200, { "content-length": "100000000" }); endless(res); }, "malformed"],
  ["undeclared-oversize (chunked) 200", (res: import("node:http").ServerResponse) => { res.writeHead(200); endless(res); }, "malformed"],
])("no socket leak: %s (60 sequential calls)", async (_name, behave, kind) => {
  await withServer((_req, res) => behave(res), async (url, open) => {
    const client = new UpstreamHttpClient({ upstream: "t", baseUrl: url, maxBodyBytes: 4096, timeoutMs: 2000 });
    for (let i = 0; i < 60; i++) {
      expect(((await client.getJson("/x").catch((e) => e)) as UpstreamError).kind).toBe(kind);
    }
    await tick(300);
    expect(open()).toBeLessThanOrEqual(2); // before the fix: ~17-32 sockets stayed open
  });
}, 30_000);

// ---- 2. Trino adapter: single-flight + TTL + negative cache -------------------------------------------
const history = [{ queryId: "q1", state: "FINISHED", query: "SELECT 1" }];
function trino(responder: Responder, opts: { cacheTtlMs?: number; negativeCacheTtlMs?: number; now?: () => number; timeoutMs?: number } = {}) {
  const { impl, calls } = mockFetch(responder);
  const client = new UpstreamHttpClient({ upstream: "trino", baseUrl: "http://127.0.0.1:8080", tokenProvider: staticTokenProvider("t.k"), fetchImpl: impl, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  const { timeoutMs: _t, ...rest } = opts;
  return { app: createApp(undefined, createTrinoQueryHistoryAdapter({ client, ...rest })), calls };
}

test("Trino history: 50 concurrent identical requests -> exactly 1 upstream call; repeats within TTL -> 0", async () => {
  const { app, calls } = trino(async () => { await tick(5); return json(history); });
  const rs = await Promise.all(Array.from({ length: 50 }, () => app.request("/api/v1/query-history")));
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(calls).toHaveLength(1);
  await app.request("/api/v1/query-history?page=1&pageSize=1");
  expect(calls).toHaveLength(1); // pagination does not change the upstream request -> same key
});

test("Trino history: TTL expiry refetches; ttl 0 = single-flight only; failures are remembered briefly", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let t = 0;
  const ok = trino(() => json(history), { cacheTtlMs: 1000, now: () => t });
  await ok.app.request("/api/v1/query-history");
  t = 999; await ok.app.request("/api/v1/query-history");
  expect(ok.calls).toHaveLength(1);
  t = 1001; await ok.app.request("/api/v1/query-history");
  expect(ok.calls).toHaveLength(2);

  const noTtl = trino(() => json(history), { cacheTtlMs: 0 });
  await noTtl.app.request("/api/v1/query-history");
  await noTtl.app.request("/api/v1/query-history");
  expect(noTtl.calls).toHaveLength(2);

  let t2 = 0;
  const failing = trino(() => json({}, 500), { negativeCacheTtlMs: 1000, now: () => t2 });
  for (let i = 0; i < 20; i++) expect((await failing.app.request("/api/v1/query-history")).status).toBe(503);
  expect(failing.calls).toHaveLength(1);
  t2 = 1001; await failing.app.request("/api/v1/query-history");
  expect(failing.calls).toHaveLength(2);
});

test("our own timeouts are NOT negatively cached", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { app, calls } = trino(hangForever, { timeoutMs: 15 });
  for (let i = 0; i < 3; i++) expect((await app.request("/api/v1/query-history")).status).toBe(503);
  expect(calls).toHaveLength(3);
});

// ---- 3-5. Lakekeeper memo behaviour ------------------------------------------------------------------
const PREFIX = "wh-1";
function catalog(responder: Responder, sourceOpts: Record<string, unknown> = {}) {
  const { impl, calls } = mockFetch(responder);
  const client = new UpstreamHttpClient({ upstream: "lakekeeper", baseUrl: "http://127.0.0.1:8181/catalog", tokenProvider: staticTokenProvider("t.k"), fetchImpl: impl });
  const source = createLakekeeperDataAssetSource({ client, catalogs: [{ name: "c", warehouse: "c" }], ...sourceOpts });
  return { app: createApp(undefined, undefined, undefined, source), calls };
}
const ok: Responder = ({ url }) =>
  url.pathname === "/catalog/v1/config" ? json({ overrides: { prefix: PREFIX } })
  : url.pathname.endsWith("/tables") ? json({ identifiers: [] })
  : json({ namespaces: [] });
const parent = (n: string) => encodeURIComponent(`asset-schema-c.${n}`);

test("LRU: a hot entry survives; invalid/garbage ids never occupy slots or hit the upstream", async () => {
  const { app, calls } = catalog(ok, { maxCacheEntries: 5 });
  const hot = `/api/v1/data-assets?parentId=${parent("hot")}`;
  await app.request(hot);
  const base = calls.length;
  for (let i = 0; i < 200; i++) {
    await app.request(`/api/v1/data-assets?parentId=${encodeURIComponent(`garbage-${i}`)}`);
    await app.request(`/api/v1/data-assets?parentId=${encodeURIComponent(`asset-schema-unknowncatalog.x${i}`)}`);
    await app.request(`/api/v1/data-assets/${encodeURIComponent(`garbage-${i}`)}`);
  }
  expect(calls.length).toBe(base);
  await app.request(hot);
  expect(calls.length).toBe(base); // still cached
  // real LRU ordering (touching refreshes): 5 slots, hot touched between inserts
  for (let i = 0; i < 4; i++) { await app.request(`/api/v1/data-assets?parentId=${parent(`n${i}`)}`); await app.request(hot); }
  const before = calls.length;
  await app.request(hot);
  expect(calls.length).toBe(before);
});

test("memo unit: LRU order, weight bound, oversize entry not cached, overload/timeout not negatively cached", async () => {
  let t = 0;
  const { memo, size, weight } = createMemo({ ttlMs: 1000, negativeTtlMs: 1000, maxEntries: 3, maxWeight: 10, now: () => t });
  const loads: string[] = [];
  const load = (k: string, w = 1) => memo(k, async () => { loads.push(k); return k; }, { weight: () => w });
  await load("a"); await load("b"); await load("c");
  await load("a"); // touch a -> b is now LRU
  await load("d"); // evicts b
  loads.length = 0;
  await load("a"); await load("c"); await load("d");
  expect(loads).toEqual([]);
  await load("b");
  expect(loads).toEqual(["b"]);
  await load("big", 11); // heavier than the whole budget -> returned but not cached
  loads.length = 0; await load("big", 11);
  expect(loads).toEqual(["big"]);
  await load("w6", 6); await load("w5", 5);
  expect(weight()).toBeLessThanOrEqual(10);
  expect(size()).toBeLessThanOrEqual(3);
  let n = 0;
  const failWith = (kind: "overloaded" | "timeout" | "forbidden") => memo(`f-${kind}`, async () => { n++; throw new UpstreamError(kind, "x"); }).catch(() => {});
  for (const kind of ["overloaded", "timeout"] as const) { await failWith(kind); await failWith(kind); }
  expect(n).toBe(4);
  n = 0; await failWith("forbidden"); await failWith("forbidden");
  expect(n).toBe(1);
  t = 1001; await failWith("forbidden");
  expect(n).toBe(2);
});

test("negative cache: 50 sequential requests against a failing upstream cost one traversal, not 50", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let t = 0;
  const { app, calls } = catalog(({ url }) => (url.pathname.endsWith("/namespaces") ? json({}, 500) : ok({ url } as never)), { now: () => t, negativeCacheTtlMs: 2000 });
  const url = `/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}`;
  for (let i = 0; i < 50; i++) expect((await app.request(url)).status).toBe(503);
  expect(calls.length).toBe(2); // config + the failing namespaces call
  t = 2001;
  await app.request(url);
  expect(calls.length).toBe(3); // namespaces retried (prefix still cached)
});

test("prefix lookup is single-flighted: cold concurrent distinct requests fetch /v1/config once", async () => {
  const { app, calls } = catalog(async (c) => { await tick(3); return ok(c); });
  await Promise.all(Array.from({ length: 25 }, (_, i) => app.request(`/api/v1/data-assets?parentId=${parent(`n${i}`)}`)));
  expect(calls.filter((c) => c.url.pathname === "/catalog/v1/config")).toHaveLength(1);
});

test("a never-ending page token is bounded: at most 10 pages / 1000 items per listing, with a truncation warning", async () => {
  let page = 0;
  const { app, calls } = catalog(({ url }) =>
    url.pathname === "/catalog/v1/config" ? json({ overrides: { prefix: PREFIX } })
    : json({ namespaces: Array.from({ length: 100 }, (_, i) => [`ns${page}_${i}`]), "next-page-token": `t${++page}` }));
  const body = (await (await app.request(`/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}&pageSize=1`)).json()) as { meta: { total: number }; warnings: { code: string }[] };
  expect(body.meta.total).toBe(1000);
  expect(body.warnings.map((w) => w.code)).toContain("LISTING_TRUNCATED");
  expect(calls.filter((c) => c.url.pathname.endsWith("/namespaces"))).toHaveLength(10);
});
