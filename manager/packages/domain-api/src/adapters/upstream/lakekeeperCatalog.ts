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
// service identity may see - NOT filtered per end user. ADR-0004 D7/Open Question 3 gate this: every
// hierarchy list carries an explicit `NODE_AUTHZ_NOT_ENFORCED` warning, `childCount` is always null, and
// the single-asset detail (no envelope) cannot carry the warning - flagged as an owner question.
//
// Security: LoadTableResult may contain `config` / `storage-credentials` (vended S3 credentials). Only the
// fields mapped below survive the zod parse (unknown keys are stripped), and the delegation header
// X-Iceberg-Access-Delegation is never sent.
import { z } from "@hono/zod-openapi";
import { deriveAssetId, isSafeUpstreamSegment, parseAssetId } from "../../lib/assetId.js";
import type { DataAsset, DataAssetColumn, DataAssetDetail } from "../../schema/dataAsset.js";
import { dataAssetDetailSchema, dataAssetSchema } from "../../schema/dataAsset.js";
import type { ListWarning } from "../../schema/envelope.js";
import type { DataAssetListResult, DataAssetSource } from "../dataAssetSource.js";
import { UpstreamError } from "./errors.js";
import type { UpstreamHttpClient } from "./httpClient.js";

const NS_SEP = "\u001F";
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // x PAGE_SIZE; beyond this the listing is truncated and a warning says so
const OPERATION_BUDGET_MS = 6000;
const DEFAULT_CACHE_TTL_MS = 5000;
const PREFIX_TTL_MS = 5 * 60 * 1000;
const SERVICE_ID = "svc-iceberg";
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
  // Single-flight is always on (identical concurrent requests share one upstream traversal). Successful
  // results are additionally kept for `cacheTtlMs` (default 5000; 0 = single-flight only). The cache is
  // keyed by asset id / parentId only: safe because the upstream principal is the shared service credential.
  cacheTtlMs?: number;
  maxCacheEntries?: number;
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
const icebergTypeSchema: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.object({ type: z.string() }).loose()]));
const structFieldSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  required: z.boolean(),
  type: icebergTypeSchema,
  doc: z.string().optional(),
});
const schemaSchema = z.object({ "schema-id": z.number().int().optional(), fields: z.array(structFieldSchema) });
const partitionSpecSchema = z.object({
  "spec-id": z.number().int().optional(),
  fields: z.array(z.object({ "source-id": z.number().int(), transform: z.string(), name: z.string() })),
});
const loadTableSchema = z.object({
  metadata: z.object({
    "format-version": z.number().int().optional(),
    location: z.string().min(1).optional(),
    schemas: z.array(schemaSchema).optional(),
    schema: schemaSchema.optional(), // v1 metadata
    "current-schema-id": z.number().int().optional(),
    "partition-specs": z.array(partitionSpecSchema).optional(),
    "default-spec-id": z.number().int().optional(),
    snapshots: z.array(z.unknown()).optional(),
    "last-updated-ms": z.number().optional(),
    properties: z.record(z.string(), z.string()).optional(),
  }),
});

// --- pure mapping helpers (exported for tests) -------------------------------------------------------
export function renderIcebergType(type: unknown, depth = 0): string {
  if (typeof type === "string") return type;
  if (depth >= 4 || typeof type !== "object" || type === null) return "complex";
  const t = type as Record<string, unknown>;
  switch (t["type"]) {
    case "struct": {
      const fields = Array.isArray(t["fields"]) ? (t["fields"] as Record<string, unknown>[]) : [];
      return `struct<${fields.map((f) => `${String(f["name"])}: ${renderIcebergType(f["type"], depth + 1)}`).join(", ")}>`;
    }
    case "list":
      return `list<${renderIcebergType(t["element"], depth + 1)}>`;
    case "map":
      return `map<${renderIcebergType(t["key"], depth + 1)}, ${renderIcebergType(t["value"], depth + 1)}>`;
    default:
      return "complex";
  }
}

export function mapLoadTable(
  catalog: string,
  namespace: readonly string[],
  table: string,
  body: unknown,
): DataAssetDetail {
  const parsed = loadTableSchema.safeParse(body);
  if (!parsed.success) throw new UpstreamError("malformed", UPSTREAM);
  const md = parsed.data.metadata;
  const schema =
    md.schemas?.find((s) => s["schema-id"] === md["current-schema-id"]) ??
    (md.schemas?.length === 1 ? md.schemas[0] : undefined) ??
    md.schema;
  if (!schema) throw new UpstreamError("malformed", UPSTREAM);
  const spec = md["partition-specs"]?.find((s) => s["spec-id"] === md["default-spec-id"]);
  const sourceIds = new Set(spec?.fields.map((f) => f["source-id"]) ?? []);
  const nameById = new Map(schema.fields.map((f) => [f.id, f.name]));
  const columns: DataAssetColumn[] = schema.fields.map((f) => ({
    name: f.name,
    type: renderIcebergType(f.type),
    nullable: !f.required,
    ...(f.doc ? { comment: f.doc } : {}),
    ...(sourceIds.has(f.id) ? { isPartition: true } : {}),
  }));
  const partitionSpec = (spec?.fields ?? [])
    .map((f) => {
      const source = nameById.get(f["source-id"]) ?? f.name;
      return f.transform === "identity" ? source : `${f.transform}(${source})`;
    })
    .join(", ");
  const fileFormat = md.properties?.["write.format.default"];
  const updated = md["last-updated-ms"] === undefined ? undefined : new Date(md["last-updated-ms"]);
  return dataAssetDetailSchema.parse({
    ...tableAsset(catalog, namespace, table),
    ...(md["format-version"] !== undefined
      ? { format: `Iceberg v${md["format-version"]}${fileFormat ? ` (${fileFormat})` : ""}` }
      : {}),
    ...(md.location ? { location: md.location } : {}),
    columns,
    metadataSummary: {
      ...(md.snapshots ? { snapshotCount: md.snapshots.length } : {}),
      ...(updated && !Number.isNaN(updated.getTime()) ? { lastUpdated: updated.toISOString() } : {}),
      ...(partitionSpec ? { partitionSpec } : {}),
    },
  });
}

const catalogId = (catalog: string) => deriveAssetId("catalog", [catalog]);
const schemaId = (catalog: string, ns: readonly string[]) => deriveAssetId("schema", [catalog, ...ns]);

// Health of an individual catalog object is not something the REST catalog reports -> "unknown".
function catalogAsset(catalog: string): DataAsset {
  return dataAssetSchema.parse({
    id: catalogId(catalog), name: catalog, kind: "catalog", serviceId: SERVICE_ID, status: "unknown",
    catalog, namespace: [], parentId: null, path: [],
  });
}
function schemaAsset(catalog: string, ns: readonly string[]): DataAsset {
  return dataAssetSchema.parse({
    id: schemaId(catalog, ns), name: ns.join("."), kind: "schema", serviceId: SERVICE_ID, status: "unknown",
    catalog, namespace: [...ns],
    parentId: ns.length === 1 ? catalogId(catalog) : schemaId(catalog, ns.slice(0, -1)),
    path: [catalog, ...ns.slice(0, -1)],
  });
}
// name keeps the flat-compatible "namespace.table" form the stub and DataCatalogView use.
function tableAsset(catalog: string, ns: readonly string[], table: string): DataAsset {
  return dataAssetSchema.parse({
    id: deriveAssetId("table", [catalog, ...ns, table]), name: `${ns.join(".")}.${table}`, kind: "table",
    serviceId: SERVICE_ID, status: "unknown", catalog, namespace: [...ns], parentId: schemaId(catalog, ns),
    path: [catalog, ...ns],
  });
}
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
  const prefixCache = new Map<string, { prefix: string; expires: number }>();
  const byName = new Map(catalogs.map((c) => [c.name, c]));
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.maxCacheEntries ?? 200;
  const cache = new Map<string, { promise: Promise<unknown>; pending: boolean; expires: number }>();

  function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && (hit.pending || hit.expires > now())) return hit.promise as Promise<T>;
    const entry = { promise: load(), pending: true, expires: 0 };
    cache.set(key, entry);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    entry.promise.then(
      () => { entry.pending = false; entry.expires = now() + ttl; if (ttl <= 0 && cache.get(key) === entry) cache.delete(key); },
      () => { if (cache.get(key) === entry) cache.delete(key); }, // failures are shared in flight, never cached
    );
    return entry.promise as Promise<T>;
  }

  async function prefixFor(mapping: LakekeeperCatalogMapping, deadline: number): Promise<string> {
    const hit = prefixCache.get(mapping.warehouse);
    if (hit && hit.expires > now()) return hit.prefix;
    const parsed = configSchema.safeParse(await client.getJson("/v1/config", { warehouse: mapping.warehouse }, deadline));
    if (!parsed.success) throw new UpstreamError("malformed", UPSTREAM);
    const raw = parsed.data.overrides?.["prefix"] ?? parsed.data.defaults?.["prefix"] ?? "";
    if (raw !== "" && (!SAFE_PREFIX.test(raw) || raw === ".." || raw.length > 128)) throw new UpstreamError("malformed", UPSTREAM);
    const prefix = raw === "" ? "" : `/${raw}`;
    prefixCache.set(mapping.warehouse, { prefix, expires: now() + PREFIX_TTL_MS });
    return prefix;
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

  async function listUncached(parentId: string | undefined): Promise<DataAssetListResult> {
    const deadline = Date.now() + OPERATION_BUDGET_MS; // wall clock: compared by the HTTP client
    const warnings: ListWarning[] = [NODE_AUTHZ_WARNING];
    if (parentId === undefined) {
      // Validate each configured warehouse against upstream before presenting it (also exercises the credential).
      for (const mapping of catalogs) await prefixFor(mapping, deadline);
      return { assets: catalogs.map((c) => catalogAsset(c.name)), warnings };
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

  return {
    emitsItemHealthWarnings: false,
    list: ({ parentId }) => memo(`list:${parentId ?? ""}`, () => listUncached(parentId)),
    get: (id) => memo(`get:${id}`, () => getUncached(id)),
  };
}
