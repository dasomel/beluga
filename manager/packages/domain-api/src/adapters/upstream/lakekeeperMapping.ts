// Lakekeeper-to-domain mapping; unknown upstream fields (including vended credentials) are stripped.
// D-MCAT-6: isolate mapping from traversal so names-only reads never load richer metadata.
// Cost: one module; escape hatch: extend this mapping only after reviewing visibility.
import { z } from "@hono/zod-openapi";
import { deriveAssetId } from "../../lib/assetId.js";
import type { DataAsset, DataAssetColumn, DataAssetDetail } from "../../schema/dataAsset.js";
import { dataAssetDetailSchema, dataAssetSchema } from "../../schema/dataAsset.js";
import { UpstreamError } from "./errors.js";

export const SERVICE_ID = "svc-iceberg";
const UPSTREAM = "lakekeeper";

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
export function catalogAsset(catalog: string): DataAsset {
  return dataAssetSchema.parse({
    id: catalogId(catalog), name: catalog, kind: "catalog", serviceId: SERVICE_ID, status: "unknown",
    catalog, namespace: [], parentId: null, path: [],
  });
}
export function schemaAsset(catalog: string, ns: readonly string[]): DataAsset {
  return dataAssetSchema.parse({
    id: schemaId(catalog, ns), name: ns.join("."), kind: "schema", serviceId: SERVICE_ID, status: "unknown",
    catalog, namespace: [...ns],
    parentId: ns.length === 1 ? catalogId(catalog) : schemaId(catalog, ns.slice(0, -1)),
    path: [catalog, ...ns.slice(0, -1)],
  });
}
// name keeps the flat-compatible "namespace.table" form the stub and DataCatalogView use.
export function tableAsset(catalog: string, ns: readonly string[], table: string): DataAsset {
  return dataAssetSchema.parse({
    id: deriveAssetId("table", [catalog, ...ns, table]), name: `${ns.join(".")}.${table}`, kind: "table",
    serviceId: SERVICE_ID, status: "unknown", catalog, namespace: [...ns], parentId: schemaId(catalog, ns),
    path: [catalog, ...ns],
  });
}
