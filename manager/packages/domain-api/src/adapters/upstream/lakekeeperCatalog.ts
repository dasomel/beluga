// Read-only Iceberg REST catalog source (Lakekeeper) for the Data Asset hierarchy (issue #36, ADR-0004).
//
// Contract used (read-only calls only), Apache Iceberg REST Catalog OpenAPI:
//   https://github.com/apache/iceberg/blob/main/open-api/rest-catalog-open-api.yaml
//     GET /v1/config?warehouse=            -> overrides.prefix / defaults.prefix
//     GET /v1/{prefix}/namespaces[?parent=&pageToken=&pageSize=]  -> {namespaces, next-page-token}
//     GET /v1/{prefix}/namespaces/{namespace}                      -> {namespace, properties}
//     GET /v1/{prefix}/namespaces/{namespace}/tables               -> {identifiers, next-page-token}
//     GET /v1/{prefix}/namespaces/{namespace}/tables/{table}       -> LoadTableResult
//   Multi-level namespaces are joined with the unit separator 0x1F (%1F) in paths and `parent`.
// Lakekeeper serves this API under /catalog (https://docs.lakekeeper.io/docs/latest/concepts/: "endpoints
// prefixed with /catalog"); a warehouse is selected with the `warehouse` config parameter. The base path is
// configurable.
//
// Authorization: Lakekeeper authenticates the bearer JWT and applies its own authorizer (OpenFGA) to the
// *calling principal*. Here that principal is Manager's service credential, so the listing is what that
// service identity may see. ADR-0010 D-MCAT-6 accepts shared names/counts for authenticated users.
// Keep the existing NODE_AUTHZ_NOT_ENFORCED list warning for API compatibility; deployed namesOnly
// detail omits columns, storage properties and metadata summaries. Other opt-in configurations retain
// the richer ADR-0004 detail contract.
//
// Security: LoadTableResult may contain `config` / `storage-credentials` (vended S3 credentials). Only the
// fields mapped below survive the zod parse (unknown keys are stripped), and the delegation header
// X-Iceberg-Access-Delegation is never sent.
import { z } from "@hono/zod-openapi";
import { isSafeUpstreamSegment, parseAssetId } from "../../lib/assetId.js";
import type { DataAsset, DataAssetDetail } from "../../schema/dataAsset.js";
import { dataAssetDetailSchema } from "../../schema/dataAsset.js";
import type { ListWarning } from "../../schema/envelope.js";
import type { DataAssetListResult, DataAssetSource } from "../dataAssetSource.js";
import { UpstreamError } from "./errors.js";
import { catalogAsset, schemaAsset, tableAsset, mapLoadTable, SERVICE_ID } from "./lakekeeperMapping.js";
export { renderIcebergType, mapLoadTable } from "./lakekeeperMapping.js";
import { createMemo, DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_MAX_CACHE_WEIGHT, DEFAULT_NEGATIVE_CACHE_TTL_MS } from "./memo.js";
import type { UpstreamHttpClient } from "./httpClient.js";

const NS_SEP = "\u001F";
const PAGE_SIZE = 100;
const MAX_PAGES = 10; // x PAGE_SIZE (1000 items per upstream listing); beyond this the listing is truncated and a warning says so
const OPERATION_BUDGET_MS = 6000;
const PREFIX_TTL_MS = 5 * 60 * 1000;
const UPSTREAM = "lakekeeper";

export const NODE_AUTHZ_WARNING: ListWarning = {
  code: "NODE_AUTHZ_NOT_ENFORCED",
  message:
    "Visibility reflects Manager's service credential at the catalog, not the end user; node-level OPA filtering is not implemented (ADR-0004 D7)",
  serviceId: SERVICE_ID,
};

export interface LakekeeperCatalogMapping {
  name: string; // Beluga/Trino catalog name shown as the catalog node
  warehouse: string; // Lakekeeper warehouse used for GET /v1/config?warehouse=
}

export interface LakekeeperSourceOptions {
  client: UpstreamHttpClient; // base URL must already include the /catalog base path
  catalogs: readonly LakekeeperCatalogMapping[];
  now?: () => number;
  namesOnly?: boolean; // deployed reader exposes names/counts only, never loads table metadata
  // Single-flight is always on (identical concurrent requests share one upstream traversal). Successful
  // results are additionally kept for `cacheTtlMs` (default 5000; 0 = single-flight only). The cache is
  // keyed by asset id / parentId only: safe because the upstream principal is the shared service credential.
  cacheTtlMs?: number;
  // Genuine upstream failures (not our own timeouts/overload) are kept this long (default 2000).
  negativeCacheTtlMs?: number;
  // LRU bounds: entries (default 100) and total weight (assets/columns across entries, default 20000).
  maxCacheEntries?: number;
  maxCacheWeight?: number;
}

// --- spec-shaped response schemas (only the fields we use) -------------------------------------------
const namespaceSchema = z.array(z.string().min(1)).min(1);
const configSchema = z.object({
  defaults: z.record(z.string(), z.string()).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
});
const listNamespacesSchema = z.object({
  namespaces: z.array(namespaceSchema),
  "next-page-token": z.string().nullish(),
});
const listTablesSchema = z.object({
  identifiers: z.array(z.object({ namespace: z.array(z.string()), name: z.string().min(1) })),
  "next-page-token": z.string().nullish(),
});
// Segments are validated at the parse boundary (parseAssetId) and on upstream-provided names; this is the
// last line: refuse anything that could change the URL structure instead of encoding it (`%2E%2E` is still
// a dot segment to the WHATWG URL parser).
function nsPath(ns: readonly string[]): string {
  if (!ns.every(isSafeUpstreamSegment)) throw new UpstreamError("malformed", UPSTREAM);
  return encodeURIComponent(ns.join(NS_SEP));
}
function tablePath(name: string): string {
  if (!isSafeUpstreamSegment(name)) throw new UpstreamError("malformed", UPSTREAM);
  return encodeURIComponent(name);
}
// Upstream-provided `prefix` becomes a path segment: allow a conservative name charset only.
const SAFE_PREFIX = /^[A-Za-z0-9_\-~][A-Za-z0-9_.\-~]*$/;

export function createLakekeeperDataAssetSource(options: LakekeeperSourceOptions): DataAssetSource {
  const { client, catalogs } = options;
  const now = options.now ?? Date.now;
  const byName = new Map(catalogs.map((c) => [c.name, c]));
  const { memo } = createMemo({
    ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    negativeTtlMs: options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
    maxEntries: options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
    maxWeight: options.maxCacheWeight ?? DEFAULT_MAX_CACHE_WEIGHT,
    now,
  });

  // /v1/config is single-flighted and kept for PREFIX_TTL_MS (failures briefly), on its own small memo so
  // listings cannot evict it.
  const prefixMemo = createMemo({
    ttlMs: PREFIX_TTL_MS, negativeTtlMs: options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
    maxEntries: 50, maxWeight: 50, now,
  }).memo;
  function prefixFor(mapping: LakekeeperCatalogMapping, deadline: number): Promise<string> {
    return prefixMemo(`prefix:${mapping.warehouse}`, async () => {
      const parsed = configSchema.safeParse(await client.getJson("/v1/config", { warehouse: mapping.warehouse }, deadline));
      if (!parsed.success) throw new UpstreamError("malformed", UPSTREAM);
      const raw = parsed.data.overrides?.["prefix"] ?? parsed.data.defaults?.["prefix"] ?? "";
      if (raw !== "" && (!SAFE_PREFIX.test(raw) || raw === ".." || raw.length > 128)) throw new UpstreamError("malformed", UPSTREAM);
      return raw === "" ? "" : `/${raw}`;
    });
  }

  // Drains upstream pages (ADR-0004 D5) and reports truncation instead of silently dropping items.
  async function drain<T>(
    fetchPage: (token: string | undefined) => Promise<{ items: T[]; next: string | null | undefined }>,
    warnings: ListWarning[],
  ): Promise<T[]> {
    const all: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, next } = await fetchPage(token);
      all.push(...items);
      if (!next) return all;
      token = next;
    }
    warnings.push({ code: "LISTING_TRUNCATED", message: `Upstream listing exceeded ${MAX_PAGES * PAGE_SIZE} items and was truncated`, serviceId: SERVICE_ID });
    return all;
  }

  async function listNamespaces(prefix: string, parent: readonly string[], deadline: number, warnings: ListWarning[]) {
    return drain(async (pageToken) => {
      const parsed = listNamespacesSchema.safeParse(
        await client.getJson(`/v1${prefix}/namespaces`, {
          parent: parent.length > 0 ? parent.join(NS_SEP) : undefined,
          pageToken, pageSize: String(PAGE_SIZE),
        }, deadline),
      );
      if (!parsed.success) throw new UpstreamError("malformed", UPSTREAM);
      // A child must be exactly one level below the parent; anything else is not the shape we asked for.
      for (const ns of parsed.data.namespaces) {
        if (ns.length !== parent.length + 1 || parent.some((seg, i) => ns[i] !== seg)) throw new UpstreamError("malformed", UPSTREAM);
      }
      // Names that cannot be addressed safely (`.`, `..`, control chars, separators) are not exposed as assets.
      return { items: parsed.data.namespaces.filter((ns) => ns.every(isSafeUpstreamSegment)), next: parsed.data["next-page-token"] };
    }, warnings);
  }

  async function listTables(prefix: string, ns: readonly string[], deadline: number, warnings: ListWarning[]) {
    return drain(async (pageToken) => {
      const parsed = listTablesSchema.safeParse(
        await client.getJson(`/v1${prefix}/namespaces/${nsPath(ns)}/tables`, { pageToken, pageSize: String(PAGE_SIZE) }, deadline),
      );
      if (!parsed.success) throw new UpstreamError("malformed", UPSTREAM);
      return { items: parsed.data.identifiers.filter((id) => isSafeUpstreamSegment(id.name)), next: parsed.data["next-page-token"] };
    }, warnings);
  }

  async function listUncached(parentId: string | undefined, kind?: DataAsset["kind"]): Promise<DataAssetListResult> {
    const deadline = Date.now() + OPERATION_BUDGET_MS; // wall clock: compared by the HTTP client
    const warnings: ListWarning[] = [NODE_AUTHZ_WARNING];
    if (parentId === undefined) {
      // Validate each configured warehouse against upstream before presenting it (also exercises the credential).
      for (const mapping of catalogs) await prefixFor(mapping, deadline);
      if (kind !== "table" && kind !== "schema") return { assets: catalogs.map((c) => catalogAsset(c.name)), warnings };
      // D-MCAT-5: overview kind counts drain the hierarchy, never count just catalog roots.
      // Cost: bounded traversal per cached snapshot; escape hatch: add an upstream aggregate API.
      const assets: DataAsset[] = [];
      for (const mapping of catalogs) {
        const prefix = await prefixFor(mapping, deadline);
        const queue: string[][] = [[]];
        for (let i = 0; i < queue.length; i++) {
          const ns = queue[i]!;
          if (queue.length > 1000 || ns.length > 32 || assets.length > 10000) throw new UpstreamError("overloaded", UPSTREAM);
          for (const child of await listNamespaces(prefix, ns, deadline, warnings)) {
            queue.push(child);
            if (kind === "schema") assets.push(schemaAsset(mapping.name, child));
          }
          if (kind === "table" && ns.length > 0) {
            for (const table of await listTables(prefix, ns, deadline, warnings)) assets.push(tableAsset(mapping.name, ns, table.name));
          }
        }
      }
      // An incomplete traversal cannot substantiate an exact overview count.
      if (assets.length > 10000 || warnings.some((w) => w.code === "LISTING_TRUNCATED")) throw new UpstreamError("overloaded", UPSTREAM);
      return { assets, warnings };
    }
    const parent = parseAssetId(parentId);
    if (!parent || parent.kind === "table") return { assets: [], warnings }; // unknown parent -> empty (ADR-0004)
    const mapping = byName.get(parent.segments[0] as string);
    if (!mapping) return { assets: [], warnings };
    const catalog = mapping.name;
    const ns = parent.segments.slice(1);
    const prefix = await prefixFor(mapping, deadline);
    const assets: DataAsset[] = (await listNamespaces(prefix, ns, deadline, warnings)).map((child) => schemaAsset(catalog, child));
    if (parent.kind === "schema") {
      for (const id of await listTables(prefix, ns, deadline, warnings)) {
        assets.push(tableAsset(catalog, ns, id.name));
      }
    }
    return { assets, warnings };
  }

  async function getUncached(id: string): Promise<DataAssetDetail | undefined> {
    const parsed = parseAssetId(id);
    const mapping = parsed ? byName.get(parsed.segments[0] as string) : undefined;
    if (!parsed || !mapping) return undefined;
    const deadline = Date.now() + OPERATION_BUDGET_MS; // wall clock: compared by the HTTP client
    const prefix = await prefixFor(mapping, deadline);
    const catalog = mapping.name;
    try {
      // D-MCAT-6: all authenticated users may see names/counts, not schema/storage metadata.
      // Cost: detail omits columns/properties; escape hatch: separately review richer visibility.
      if (options.namesOnly && parsed.kind !== "catalog") {
        const ns = parsed.segments.slice(1, parsed.kind === "table" ? -1 : undefined);
        const parent = parsed.kind === "table" ? ns : ns.slice(0, -1);
        const warnings: ListWarning[] = [];
        const complete = () => {
          if (warnings.some((w) => w.code === "LISTING_TRUNCATED")) throw new UpstreamError("overloaded", UPSTREAM);
        };
        if (parsed.kind === "schema") {
          const found = (await listNamespaces(prefix, parent, deadline, warnings)).some((item) => item.join(NS_SEP) === ns.join(NS_SEP));
          complete();
          return found ? dataAssetDetailSchema.parse(schemaAsset(catalog, ns)) : undefined;
        }
        const table = parsed.segments.at(-1)!;
        const found = (await listTables(prefix, ns, deadline, warnings)).some((item) => item.name === table);
        complete();
        return found ? dataAssetDetailSchema.parse(tableAsset(catalog, ns, table)) : undefined;
      }
      if (parsed.kind === "catalog") return dataAssetDetailSchema.parse({ ...catalogAsset(catalog), childCount: null });
      if (parsed.kind === "schema") {
        const ns = parsed.segments.slice(1);
        await client.getJson(`/v1${prefix}/namespaces/${nsPath(ns)}`, undefined, deadline);
        return dataAssetDetailSchema.parse({ ...schemaAsset(catalog, ns), childCount: null });
      }
      const ns = parsed.segments.slice(1, -1);
      const table = parsed.segments[parsed.segments.length - 1] as string;
      const body = await client.getJson(`/v1${prefix}/namespaces/${nsPath(ns)}/tables/${tablePath(table)}`, undefined, deadline);
      return mapLoadTable(catalog, ns, table, body);
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "not_found") return undefined;
      throw error;
    }
  }

  // Invalid / unknown-catalog / non-listable ids are answered here, BEFORE the memo, so garbage input never
  // occupies a cache slot or reaches the upstream.
  const listWeight = (r: DataAssetListResult) => r.assets.length;
  return {
    emitsItemHealthWarnings: false,
    async list({ parentId, kind }) {
      if (parentId !== undefined) {
        const parent = parseAssetId(parentId);
        if (!parent || parent.kind === "table" || !byName.has(parent.segments[0] as string)) {
          return { assets: [], warnings: [NODE_AUTHZ_WARNING] }; // unknown parent -> empty (ADR-0004)
        }
      }
      return memo(`list:${parentId ?? ""}:${kind ?? ""}`, () => listUncached(parentId, kind), { weight: listWeight });
    },
    async get(id) {
      const parsed = parseAssetId(id);
      if (!parsed || !byName.has(parsed.segments[0] as string)) return undefined;
      return memo(`get:${id}`, () => getUncached(id), {
        weight: (d) => 1 + (d?.columns?.length ?? 0),
      });
    },
  };
}
