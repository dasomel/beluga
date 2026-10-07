// Single-flight + short-TTL LRU memo shared by the upstream adapters.
//  - Identical concurrent loads share one promise (single-flight), also for failures in flight.
//  - Successes are reused for `ttlMs` (0 = single-flight only).
//  - Genuine upstream failures (unreachable/401/403/5xx/malformed) are kept briefly (`negativeTtlMs`) so a
//    failing upstream is not hammered; failures caused by our own limits (timeout, overloaded) and
//    non-UpstreamErrors are never cached.
//  - LRU eviction by entry count and by total weight (an approximate item count per entry), so memory is
//    bounded: at most `maxEntries` entries and `maxWeight` units (~assets/columns/history rows) overall.
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

export function createMemo(options: MemoOptions) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>(); // insertion order == LRU order (oldest first)
  let totalWeight = 0;

  const drop = (key: string, entry: Entry) => {
    if (cache.get(key) === entry) { cache.delete(key); totalWeight -= entry.weight; }
  };
  const evict = () => {
    while (cache.size > options.maxEntries || totalWeight > options.maxWeight) {
      const oldest = cache.entries().next().value as [string, Entry] | undefined;
      if (!oldest) break;
      drop(oldest[0], oldest[1]);
    }
  };
  const cacheable = (error: unknown) => isUpstreamError(error) && error.kind !== "timeout" && error.kind !== "overloaded";

  function memo<T>(key: string, load: () => Promise<T>, o: { ttlMs?: number; weight?: (value: T) => number } = {}): Promise<T> {
    const hit = cache.get(key);
    if (hit && (hit.pending || hit.expires > now())) {
      cache.delete(key); cache.set(key, hit); // touch -> most recently used
      return hit.promise as Promise<T>;
    }
    if (hit) drop(key, hit);
    const entry: Entry = { promise: load(), pending: true, expires: 0, weight: 1 };
    cache.set(key, entry);
    totalWeight += entry.weight;
    entry.promise.then(
      (value) => {
        entry.pending = false;
        const ttl = o.ttlMs ?? options.ttlMs;
        const weight = Math.max(1, o.weight?.(value as T) ?? 1);
        if (ttl <= 0 || weight > options.maxWeight) return drop(key, entry);
        totalWeight += weight - entry.weight;
        entry.weight = weight;
        entry.expires = now() + ttl;
        evict();
      },
      (error) => {
        entry.pending = false;
        if (options.negativeTtlMs > 0 && cacheable(error)) entry.expires = now() + options.negativeTtlMs;
        else drop(key, entry);
      },
    );
    evict();
    return entry.promise as Promise<T>;
  }
  return { memo, size: () => cache.size, weight: () => totalWeight };
}

export const DEFAULT_CACHE_TTL_MS = 5000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 2000;
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_MAX_CACHE_WEIGHT = 20_000;
