// Single-flight + short-TTL LRU memo shared by the upstream adapters.
//  - Identical concurrent loads share one promise (single-flight), also for failures in flight.
//  - Successes are reused for `ttlMs` (0 = single-flight only).
//  - Genuine upstream failures (unreachable/401/403/5xx/malformed) are kept briefly (`negativeTtlMs`) so a
//    failing upstream is not hammered; failures caused by our own limits (timeout, overloaded) and
//    non-UpstreamErrors are never cached.
//  - LRU eviction by entry count and by total weight (an approximate item count per entry), so memory is
//    bounded: at most `maxEntries` entries and `maxWeight` units (~assets/columns/history rows) overall.
//  - Values are deep-frozen once, because every caller receives the same object: mutation is an error.
// Accounting invariant: `totalWeight === sum(entry.weight over the live map)`. `link`, `unlink` and `reweigh`
// are the ONLY writers of both the map and totalWeight, and each acts only on the entry that is still the
// live one for its key - a stale entry (evicted/replaced while its load was pending) can never change totals.
// Callers must validate keys BEFORE calling memo so garbage input never occupies a slot.
import { isUpstreamError } from "./errors.js";

export interface MemoOptions {
  ttlMs: number;
  negativeTtlMs: number;
  maxEntries: number;
  maxWeight: number;
  now?: () => number;
}

interface Entry { promise: Promise<unknown>; pending: boolean; expires: number; weight: number }

// NaN / non-number / <1 -> 1 (safe minimum); fractional -> ceil; Infinity -> Infinity (never cacheable).
export function normalizeWeight(weight: unknown): number {
  if (typeof weight !== "number" || Number.isNaN(weight) || weight < 1) return 1;
  return Number.isFinite(weight) ? Math.ceil(weight) : Number.POSITIVE_INFINITY;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createMemo(options: MemoOptions) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>(); // insertion order == LRU order (oldest first)
  let totalWeight = 0;

  const isLive = (key: string, entry: Entry) => cache.get(key) === entry;
  function link(key: string, entry: Entry): void {
    cache.set(key, entry);
    totalWeight += entry.weight;
  }
  function unlink(key: string, entry: Entry): void {
    if (!isLive(key, entry)) return;
    cache.delete(key);
    totalWeight -= entry.weight;
  }
  function reweigh(key: string, entry: Entry, weight: number): void {
    if (!isLive(key, entry)) return;
    totalWeight += weight - entry.weight;
    entry.weight = weight;
  }
  function evict(): void {
    while (cache.size > options.maxEntries || totalWeight > options.maxWeight) {
      const oldest = cache.entries().next().value as [string, Entry] | undefined;
      if (!oldest) break;
      unlink(oldest[0], oldest[1]);
    }
  }
  const cacheable = (error: unknown) => isUpstreamError(error) && error.kind !== "timeout" && error.kind !== "overloaded";

  function memo<T>(key: string, load: () => Promise<T>, o: { ttlMs?: number; weight?: (value: T) => number } = {}): Promise<T> {
    const hit = cache.get(key);
    if (hit && (hit.pending || hit.expires > now())) {
      cache.delete(key); cache.set(key, hit); // touch -> most recently used (weight unchanged)
      return hit.promise as Promise<T>;
    }
    if (hit) unlink(key, hit);
    const entry: Entry = { promise: load().then(deepFreeze), pending: true, expires: 0, weight: 1 };
    link(key, entry);
    entry.promise.then(
      (value) => {
        entry.pending = false;
        if (!isLive(key, entry)) return; // evicted/replaced while pending: the caller still gets the value, totals untouched
        const ttl = o.ttlMs ?? options.ttlMs;
        let weight: number;
        try { weight = normalizeWeight(o.weight?.(value as T) ?? 1); } catch { weight = 1; }
        if (ttl <= 0 || weight > options.maxWeight) return unlink(key, entry); // too heavy: not cached, others untouched
        reweigh(key, entry, weight);
        entry.expires = now() + ttl;
        evict();
      },
      (error) => {
        entry.pending = false;
        if (!isLive(key, entry)) return;
        if (options.negativeTtlMs > 0 && cacheable(error)) entry.expires = now() + options.negativeTtlMs;
        else unlink(key, entry);
      },
    );
    evict();
    return entry.promise as Promise<T>;
  }

  function invalidate(key: string): void {
    const entry = cache.get(key);
    if (entry) unlink(key, entry);
  }
  // Test/diagnostic view: `sum` is recomputed from the live map and must always equal `totalWeight`.
  function stats() {
    let sum = 0;
    for (const entry of cache.values()) sum += entry.weight;
    return { size: cache.size, totalWeight, sum };
  }
  return { memo, invalidate, stats, size: () => cache.size, weight: () => totalWeight };
}

export const DEFAULT_CACHE_TTL_MS = 5000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 2000;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_MAX_CACHE_WEIGHT = 20_000;
