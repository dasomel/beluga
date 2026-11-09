import type { ListWarning } from "../schema/envelope.js";

export interface OverviewBatch<T> {
  items: T[];
  warnings: ListWarning[];
  inventoryComplete?: boolean;
}
export interface OverviewSource<T> {
  list(): Promise<OverviewBatch<T>>;
}

export async function readOverview<T>(source: T[] | OverviewSource<T>): Promise<OverviewBatch<T>> {
  return Array.isArray(source) ? { items: source, warnings: [] } : source.list();
}

export function cachedOverview<T>(source: T[] | OverviewSource<T>, ttlMs = 5000) {
  let cached: OverviewBatch<T> | undefined;
  let expiresAt = 0;
  let pending: Promise<OverviewBatch<T>> | undefined;
  // D365-5: list/detail share a five-second snapshot and concurrent load. Cost: bounded
  // staleness; failures are never cached. Escape hatch: lower ttlMs or recreate the app.
  return async (): Promise<OverviewBatch<T>> => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = readOverview(source).then((batch) => {
      cached = batch;
      expiresAt = Date.now() + ttlMs;
      return batch;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
