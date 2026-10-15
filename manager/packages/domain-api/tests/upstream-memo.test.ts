import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { UpstreamError, type UpstreamErrorKind } from "../src/adapters/upstream/errors.js";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { createLakekeeperDataAssetSource } from "../src/adapters/upstream/lakekeeperCatalog.js";
import { createMemo, deepFreeze, normalizeWeight } from "../src/adapters/upstream/memo.js";
import { createTrinoQueryHistoryAdapter } from "../src/adapters/upstream/trinoQueryHistory.js";
import { staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { json, mockFetch } from "./helpers/mockUpstream.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("regression: bursts of concurrent distinct heavy keys never drift totalWeight; cache and single-flight stay alive", async () => {
  const { memo, stats } = createMemo({ ttlMs: 60_000, negativeTtlMs: 0, maxEntries: 100, maxWeight: 20_000 });
  for (let round = 0; round < 3; round++) {
    await Promise.all(Array.from({ length: 300 }, (_, i) => memo(`k${round}-${i}`, async () => { await tick(1); return i; }, { weight: () => 100 })));
    const s = stats();
    expect(s.sum).toBe(s.totalWeight);
    expect(s.totalWeight).toBeLessThanOrEqual(20_000);
    expect(s.size).toBeLessThanOrEqual(100);
  }
  let calls = 0;
  const same = () => memo("hot", async () => { calls++; await tick(2); return "v"; }, { weight: () => 10 });
  await Promise.all(Array.from({ length: 50 }, same));
  await same();
  expect(calls).toBe(1); // single-flight + cache still work
});

test("weights are sanitized: NaN/negative/fractional/Infinity; an over-limit entry does not evict others", async () => {
  expect([NaN, -5, 0, 0.2, 2.1, 7, Infinity, "x" as unknown].map(normalizeWeight)).toEqual([1, 1, 1, 1, 3, 7, Infinity, 1]);
  const { memo, stats } = createMemo({ ttlMs: 1000, negativeTtlMs: 0, maxEntries: 10, maxWeight: 20 });
  for (const [k, w] of [["a", 5], ["b", 5]] as const) await memo(k, async () => k, { weight: () => w });
  for (const [k, w] of [["inf", Infinity], ["huge", 21], ["nan", NaN], ["neg", -9]] as const) await memo(k, async () => k, { weight: () => w });
  await flush();
  const s = stats();
  expect(s.sum).toBe(s.totalWeight);
  let loads = 0;
  await memo("a", async () => { loads++; return "a"; });
  await memo("b", async () => { loads++; return "b"; });
  expect(loads).toBe(0); // a and b were not evicted by the oversize entries
  await memo("throws", async () => 1, { weight: () => { throw new Error("bad weight fn"); } });
  await flush();
  expect(stats().sum).toBe(stats().totalWeight);
});

// Deterministic fuzz: random interleaving of get / resolve / reject / expire / invalidate with pending and
// resolved entries; the accounting invariant is checked after EVERY operation.
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test.each([1, 2, 3, 4, 5, 6])("fuzz seed %i: sum(entry weights) === totalWeight, bounds hold after every operation", async (seed) => {
  const rand = rng(seed);
  const MAX_ENTRIES = 5, MAX_WEIGHT = 30;
  let t = 0;
  const { memo, invalidate, stats } = createMemo({ ttlMs: 50, negativeTtlMs: 20, maxEntries: MAX_ENTRIES, maxWeight: MAX_WEIGHT, now: () => t });
  const pending: Array<{ resolve: (w: number) => void; reject: (k: UpstreamErrorKind) => void }> = [];
  const weights = [1, 2, 3, 7, 29, 30, 31, 100, NaN, -4, 2.5, Infinity, 0];
  const kinds: UpstreamErrorKind[] = ["timeout", "overloaded", "forbidden", "upstream_error", "malformed", "unreachable"];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  for (let op = 0; op < 2500; op++) {
    const r = rand();
    if (r < 0.4) {
      const key = `k${Math.floor(rand() * 12)}`;
      let box!: { resolve: (w: number) => void; reject: (k: UpstreamErrorKind) => void };
      const p = memo(key, () => new Promise<{ w: number }>((resolve, reject) => {
        box = { resolve: (w) => resolve({ w }), reject: (k) => reject(new UpstreamError(k, "fuzz")) };
      }), { weight: (v) => v.w });
      p.catch(() => {});
      if (box) pending.push(box); // joined (single-flight) calls create no new load
    } else if (r < 0.7 && pending.length > 0) {
      const box = pending.splice(Math.floor(rand() * pending.length), 1)[0]!;
      if (rand() < 0.75) box.resolve(pick(weights)); else box.reject(pick(kinds));
    } else if (r < 0.85) {
      t += pick([1, 10, 25, 60]);
    } else {
      invalidate(`k${Math.floor(rand() * 12)}`);
    }
    await flush();
    const s = stats();
    expect(s.sum).toBe(s.totalWeight);
    expect(s.totalWeight).toBeGreaterThanOrEqual(0);
    expect(s.size).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(s.totalWeight).toBeLessThanOrEqual(MAX_WEIGHT);
  }
  for (const box of pending) box.resolve(1);
  await flush();
  expect(stats().sum).toBe(stats().totalWeight);
}, 60_000);

test("cached values are deep-frozen: shared objects cannot be mutated by one caller to affect another", async () => {
  const { memo } = createMemo({ ttlMs: 1000, negativeTtlMs: 0, maxEntries: 5, maxWeight: 100 });
  const value = await memo("k", async () => ({ list: [{ a: 1 }], nested: { b: [2] } }));
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.list)).toBe(true);
  expect(Object.isFrozen(value.list[0])).toBe(true);
  expect(() => { (value.list as unknown as unknown[]).push(1); }).toThrow(TypeError);
  expect(deepFreeze("x")).toBe("x");
});

test("Lakekeeper results are frozen too, so concurrent callers sharing one result cannot corrupt it", async () => {
  const { impl } = mockFetch(({ url }) =>
    url.pathname === "/catalog/v1/config" ? json({ overrides: { prefix: "p" } }) : json({ namespaces: [["a"]] }));
  const client = new UpstreamHttpClient({ upstream: "lakekeeper", baseUrl: "http://127.0.0.1:1/catalog", tokenProvider: staticTokenProvider("t.k"), fetchImpl: impl });
  const source = createLakekeeperDataAssetSource({ client, catalogs: [{ name: "c", warehouse: "c" }] });
  const first = await source.list({ parentId: "asset-catalog-c" });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.assets)).toBe(true);
  expect(await source.list({ parentId: "asset-catalog-c" })).toBe(first);
});

test("Trino history reports truncation beyond 1000 rows as a warning on every page; exactly 1000 is not truncated", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ queryId: `q${i}`, state: "FINISHED", query: "SELECT 1" }));
  const appFor = (n: number) => {
    const { impl } = mockFetch(() => json(rows(n)));
    const client = new UpstreamHttpClient({ upstream: "trino", baseUrl: "http://127.0.0.1:8080", fetchImpl: impl });
    return createApp(undefined, createTrinoQueryHistoryAdapter({ client }));
  };
  const big = (await (await appFor(1203).request("/api/v1/query-history?page=10&pageSize=100")).json()) as { meta: { total: number }; warnings?: { code: string; message: string }[]; data: unknown[] };
  expect(big.meta.total).toBe(1000);
  expect(big.data).toHaveLength(100);
  expect(big.warnings?.map((w) => w.code)).toEqual(["HISTORY_TRUNCATED"]);
  const exact = (await (await appFor(1000).request("/api/v1/query-history")).json()) as { warnings?: unknown };
  expect(exact.warnings).toBeUndefined();
  const small = (await (await appFor(3).request("/api/v1/query-history")).json()) as { warnings?: unknown };
  expect(small.warnings).toBeUndefined();
});
