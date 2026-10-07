// Adversarial / resource-exhaustion tests for the upstream adapters. Fixtures are spec-derived (Iceberg REST
// OpenAPI, Trino 483 BasicQueryInfo); nothing here is live-recorded.
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { withRouteDeadline } from "../src/adapters/dataAssetSource.js";
import { UpstreamError } from "../src/adapters/upstream/errors.js";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { createLakekeeperDataAssetSource } from "../src/adapters/upstream/lakekeeperCatalog.js";
import { createTrinoQueryHistoryAdapter } from "../src/adapters/upstream/trinoQueryHistory.js";
import { staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { isSafeUpstreamSegment, parseAssetId } from "../src/lib/assetId.js";
import { json, mockFetch, type Responder } from "./helpers/mockUpstream.js";

const PREFIX = "wh-0001";
const BASE = `/catalog/v1/${PREFIX}/`;
const tok = staticTokenProvider("tok.en-1");
afterEach(() => vi.restoreAllMocks());

function setup(responder: Responder, clientOpts: Record<string, unknown> = {}, sourceOpts: Record<string, unknown> = {}) {
  const { impl, calls } = mockFetch(responder);
  const client = new UpstreamHttpClient({ upstream: "lakekeeper", baseUrl: "http://127.0.0.1:8181/catalog", tokenProvider: tok, fetchImpl: impl, ...clientOpts });
  const source = createLakekeeperDataAssetSource({ client, catalogs: [{ name: "c", warehouse: "c" }], ...sourceOpts });
  return { app: createApp(undefined, undefined, source), calls, source, client };
}
const permissive: Responder = ({ url }) =>
  url.pathname === "/catalog/v1/config" ? json({ overrides: { prefix: PREFIX } })
  : url.pathname.endsWith("/tables") ? json({ identifiers: [] })
  : url.pathname.endsWith("/namespaces") ? json({ namespaces: [] })
  : json({ namespace: ["x"], metadata: { schemas: [{ fields: [] }] } });

// ---- 1. path traversal ------------------------------------------------------------------------------
const HOSTILE = [
  "asset-schema-c.%2E%2E",
  "asset-table-c.s.%2E%2E",
  "asset-table-c.%2E%2E.t",
  "asset-schema-c.%2E",
  "asset-schema-c.a/../b",
  "asset-schema-c.a%2F..%2Fb",
  "asset-schema-c.a\\b",
  "asset-schema-c.a\u0000b",
  "asset-schema-c.a\u001Fb",
  "asset-table-c.s.t\nx",
  `asset-schema-c.${"a".repeat(300)}`,
];
test.each(HOSTILE)("hostile id %s never reaches the upstream and is not found / empty", async (raw) => {
  const id = raw;
  const { app, calls } = setup(permissive);
  const encoded = encodeURIComponent(id);
  expect((await app.request(`/api/v1/data-assets/${encoded}`)).status).toBe(404);
  const list = await app.request(`/api/v1/data-assets?parentId=${encoded}`);
  expect([list.status, ((await list.json()) as { data: unknown[] }).data]).toEqual([200, []]);
  expect((await app.request(`/api/v1/data-assets/${encoded}/query-context`)).status).toBe(404);
  expect(calls).toHaveLength(0);
});

test("query-string and fragment characters in names stay encoded inside the path", async () => {
  const { app, calls } = setup(permissive);
  for (const seg of ["a?x=1", "a#b", "%2e%2e", "a b"]) {
    await app.request(`/api/v1/data-assets/${encodeURIComponent(`asset-schema-c.${seg}`)}`);
  }
  for (const call of calls) {
    expect(call.url.pathname.startsWith(BASE) || call.url.pathname === "/catalog/v1/config").toBe(true);
    expect(call.url.hash).toBe("");
    expect([...call.url.searchParams.keys()].filter((k) => k !== "warehouse")).toEqual([]);
  }
  expect(calls.map((c) => c.url.pathname)).toContain(`${BASE}namespaces/a%3Fx%3D1`);
  expect(calls.map((c) => c.url.pathname)).toContain(`${BASE}namespaces/%252e%252e`); // literal name, not a dot segment
});

test("the client refuses any path the URL parser would normalize (defense in depth), without sending", async () => {
  const { impl, calls } = mockFetch(() => json({}));
  const client = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:1/catalog", fetchImpl: impl });
  for (const path of ["/v1/p/namespaces/..", "/v1/p/namespaces/%2E%2E", "/v1/p/namespaces/%2e", "/v1/p/a/./b"]) {
    expect(((await client.getJson(path).catch((e) => e)) as UpstreamError).kind).toBe("malformed");
  }
  expect(calls).toHaveLength(0);
});

test("parse boundary: dot segments, separators and control characters are rejected after decoding", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\u001Fb", "a\nb", "a\u007Fb"]) expect(isSafeUpstreamSegment(bad)).toBe(false);
  for (const ok of ["a", "orders.v2", "a b", "a?b", "%2e%2e", "한글"]) expect(isSafeUpstreamSegment(ok)).toBe(true);
  expect(parseAssetId("asset-schema-c.%2E%2E")).toBeUndefined();
  expect(parseAssetId("asset-table-c.s.%2E")).toBeUndefined();
});

test("hostile upstream data: unsafe namespace/table names are dropped; unsafe prefix is malformed (503)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const evil = setup(({ url }) =>
    url.pathname === "/catalog/v1/config" ? json({ overrides: { prefix: PREFIX } })
    : url.pathname.endsWith("/tables") ? json({ identifiers: [{ namespace: ["s"], name: ".." }, { namespace: ["s"], name: "ok" }] })
    : json({ namespaces: [["s", ".."], ["s", "fine"]] }));
  const body = (await (await evil.app.request(`/api/v1/data-assets?parentId=${encodeURIComponent("asset-schema-c.s")}`)).json()) as { data: { name: string }[] };
  expect(body.data.map((a) => a.name)).toEqual(["s.fine", "s.ok"]);
  for (const prefix of ["..", "a/b", ".", "%2e%2e", "a?b", "x".repeat(200), "a\u0000"]) {
    const bad = setup(() => json({ overrides: { prefix } }));
    expect((await bad.app.request("/api/v1/data-assets")).status).toBe(503);
    expect(bad.calls.every((c) => c.url.pathname === "/catalog/v1/config")).toBe(true);
  }
});

// ---- 2. streamed byte cap ---------------------------------------------------------------------------
function chunkedResponse(chunkBytes: number, chunks: number, state: { pulled: number; cancelled: boolean }) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent++;
      state.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() { state.cancelled = true; },
  });
  return new Response(body, { status: 200 }); // no content-length (chunked)
}

test("a 60MB chunked body with a 1000-byte cap is cancelled after a few chunks, not buffered", async () => {
  const state = { pulled: 0, cancelled: false };
  const { impl } = mockFetch(() => chunkedResponse(1024 * 1024, 60, state));
  const client = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:1", fetchImpl: impl, maxBodyBytes: 1000 });
  expect(((await client.getJson("/x").catch((e) => e)) as UpstreamError).kind).toBe("malformed");
  expect(state.cancelled).toBe(true);
  expect(state.pulled).toBeLessThan(10 * 1024 * 1024);
});

test("the cap counts bytes, not characters", async () => {
  const text = JSON.stringify({ v: "é".repeat(600) }); // ~620 chars, ~1220 bytes
  expect(text.length).toBeLessThan(1000);
  const { impl } = mockFetch(() => new Response(text, { status: 200 }));
  const client = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:1", fetchImpl: impl, maxBodyBytes: 1000 });
  expect(((await client.getJson("/x").catch((e) => e)) as UpstreamError).kind).toBe("malformed");
  const ok = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:1", fetchImpl: impl, maxBodyBytes: 5000 });
  expect(((await ok.getJson("/x")) as { v: string }).v).toHaveLength(600);
});

test("the Trino history adapter inherits the cap: oversized chunked body -> 503, no partial list", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const state = { pulled: 0, cancelled: false };
  const { impl } = mockFetch(() => chunkedResponse(4096, 1000, state));
  const client = new UpstreamHttpClient({ upstream: "trino", baseUrl: "http://127.0.0.1:8080", fetchImpl: impl, maxBodyBytes: 1000 });
  const app = createApp(undefined, createTrinoQueryHistoryAdapter({ client }));
  expect((await app.request("/api/v1/query-history")).status).toBe(503);
  expect(state.cancelled).toBe(true);
});

// ---- 3. request amplification -----------------------------------------------------------------------
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("single-flight: 20 concurrent identical requests cost one traversal", async () => {
  const solo = setup(async (c) => { await tick(5); return permissive(c); });
  await solo.app.request(`/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}`);
  const one = solo.calls.length;
  const many = setup(async (c) => { await tick(5); return permissive(c); });
  const rs = await Promise.all(Array.from({ length: 20 }, () => many.app.request(`/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}`)));
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(many.calls.length).toBe(one);
});

test("TTL cache serves repeats without upstream calls, expires, and never caches failures", async () => {
  let t = 1_000;
  let fail = true;
  const { app, calls } = setup((c) => (fail && c.url.pathname.endsWith("/namespaces") ? json({}, 500) : permissive(c)), {}, { now: () => t, cacheTtlMs: 1000, negativeCacheTtlMs: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const url = `/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}`;
  expect((await app.request(url)).status).toBe(503);
  fail = false;
  expect((await app.request(url)).status).toBe(200); // failure was not cached
  const afterFirstOk = calls.length;
  expect((await app.request(url)).status).toBe(200);
  expect(calls.length).toBe(afterFirstOk); // cached
  t += 1001;
  await app.request(url);
  expect(calls.length).toBeGreaterThan(afterFirstOk); // expired
});

test("cacheTtlMs 0 keeps single-flight only (sequential repeats hit upstream again)", async () => {
  const { app, calls } = setup(permissive, {}, { cacheTtlMs: 0 });
  const url = `/api/v1/data-assets?parentId=${encodeURIComponent("asset-catalog-c")}`;
  await app.request(url);
  const n = calls.length;
  await app.request(url);
  expect(calls.length).toBeGreaterThan(n);
});

test("global concurrency cap: 30 distinct requests never exceed maxConcurrent in-flight upstream calls", async () => {
  let inFlight = 0, peak = 0;
  const { app, calls } = setup(async (c) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await tick(3);
    inFlight--;
    return permissive(c);
  }, { maxConcurrent: 3 });
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => app.request(`/api/v1/data-assets?parentId=${encodeURIComponent(`asset-schema-c.n${i}`)}`)));
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(peak).toBeLessThanOrEqual(3);
  expect(calls.length).toBeGreaterThan(30);
});

test("a full wait queue sheds load as 503 without calling the upstream; queue waiting respects the budget", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const release: Array<() => void> = [];
  const { impl, calls } = mockFetch(() => new Promise<Response>((resolve) => release.push(() => resolve(json({ namespaces: [] })))));
  const client = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:1", fetchImpl: impl, maxConcurrent: 1, maxQueued: 1, timeoutMs: 80 });
  const first = client.getJson("/a").catch((e) => e);
  const second = client.getJson("/b").catch((e) => e); // queued
  const third = (await client.getJson("/c").catch((e) => e)) as UpstreamError; // shed
  expect(third.kind).toBe("overloaded");
  expect(calls).toHaveLength(1);
  expect(((await second) as UpstreamError).kind).toBe("timeout"); // waited past its budget
  expect(((await first) as UpstreamError).kind).toBe("timeout");
  release.forEach((r) => r());
});

test("total per-request deadline: withRouteDeadline turns a hung source into a timeout error", async () => {
  const err = (await withRouteDeadline(new Promise(() => {}), 20).catch((e) => e)) as UpstreamError;
  expect(err).toBeInstanceOf(UpstreamError);
  expect(err.kind).toBe("timeout");
  expect(await withRouteDeadline(Promise.resolve(7), 20)).toBe(7);
});
