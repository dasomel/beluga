// Fixtures are SPEC-DERIVED from the Apache Iceberg REST Catalog OpenAPI (rest-catalog-open-api.yaml:
// ConfigResponse, ListNamespacesResponse, ListTablesResponse, GetNamespaceResponse, LoadTableResult,
// IcebergErrorResponse). They are NOT recorded from a live Lakekeeper; authenticated flows are NOT verified live.
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createLakekeeperDataAssetSource } from "../src/adapters/upstream/lakekeeperCatalog.js";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { deriveAssetId, parseAssetId } from "../src/lib/assetId.js";
import { hangForever, json, mockFetch, type Responder } from "./helpers/mockUpstream.js";

const SECRET = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD.sig";
const PREFIX = "wh-0001";
const UNIT = "%1F";
const loadTableResult = {
  "metadata-location": "s3://beluga-lake/warehouse/analytics/orders/metadata/00003.metadata.json",
  metadata: {
    "format-version": 2,
    location: "s3://beluga-lake/warehouse/analytics/orders",
    "last-updated-ms": 1790587800000,
    "current-schema-id": 1,
    schemas: [
      { "schema-id": 0, fields: [{ id: 1, name: "old", required: true, type: "long" }] },
      {
        "schema-id": 1,
        fields: [
          { id: 1, name: "order_id", required: true, type: "long", doc: "Order primary key" },
          { id: 2, name: "order_date", required: true, type: "date" },
          { id: 3, name: "email", required: false, type: "string" },
          { id: 4, name: "tags", required: false, type: { type: "list", "element-id": 5, element: "string", "element-required": true } },
          { id: 6, name: "addr", required: false, type: { type: "struct", fields: [{ id: 7, name: "zip", required: false, type: "string" }] } },
        ],
      },
    ],
    "default-spec-id": 1,
    "partition-specs": [
      { "spec-id": 0, fields: [] },
      { "spec-id": 1, fields: [{ "source-id": 2, "field-id": 1000, name: "order_date_day", transform: "day" }] },
    ],
    snapshots: [{ "snapshot-id": 1 }, { "snapshot-id": 2 }],
    properties: { "write.format.default": "parquet" },
  },
  // Vended credentials / table config must never reach Manager's response.
  config: { "s3.access-key-id": "AKIA-LEAK", "s3.secret-access-key": "SECRET-LEAK" },
  "storage-credentials": [{ prefix: "s3://beluga-lake", config: { "s3.session-token": "TOKEN-LEAK" } }],
};

// Routes: namespaces/tables per the spec; `tail` builds the path after /catalog/v1/{prefix}.
function lakekeeper(overrides: Record<string, Responder> = {}, timeoutMs?: number) {
  const defaults: Record<string, Responder> = {
    "/catalog/v1/config": () => json({ defaults: {}, overrides: { prefix: PREFIX } }),
    [`/catalog/v1/${PREFIX}/namespaces`]: ({ url }) =>
      url.searchParams.get("parent") === null
        ? json({ namespaces: [["analytics"], ["raw.v1"]] })
        : json({ namespaces: [["analytics", "marts"]] }),
    [`/catalog/v1/${PREFIX}/namespaces/analytics/tables`]: () =>
      json({ identifiers: [{ namespace: ["analytics"], name: "orders" }, { namespace: ["analytics"], name: "orders.v2" }] }),
    [`/catalog/v1/${PREFIX}/namespaces/analytics/tables/orders`]: () => json(loadTableResult),
    [`/catalog/v1/${PREFIX}/namespaces/analytics`]: () => json({ namespace: ["analytics"], properties: {} }),
  };
  const table = { ...defaults, ...overrides };
  const { impl, calls } = mockFetch((call) => {
    const responder = table[call.url.pathname];
    return responder ? responder(call) : json({ error: { message: "nope", type: "NoSuchTableException", code: 404 } }, 404);
  });
  const client = new UpstreamHttpClient({
    upstream: "lakekeeper", baseUrl: "http://127.0.0.1:8181/catalog", tokenProvider: staticTokenProvider(SECRET), fetchImpl: impl,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const source = createLakekeeperDataAssetSource({ client, catalogs: [{ name: "beluga_lake", warehouse: "beluga_lake" }] });
  return { app: createApp(undefined, undefined, source), calls };
}
const CAT = deriveAssetId("catalog", ["beluga_lake"]);
const SCHEMA = deriveAssetId("schema", ["beluga_lake", "analytics"]);
const TABLE = deriveAssetId("table", ["beluga_lake", "analytics", "orders"]);
const get = async (app: ReturnType<typeof lakekeeper>["app"], path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as any };
};
afterEach(() => vi.restoreAllMocks());

test("no parentId -> configured catalogs only; warehouse resolved via /v1/config; childCount null; authz warning present", async () => {
  const { app, calls } = lakekeeper();
  const { status, body } = await get(app, "/api/v1/data-assets");
  expect(status).toBe(200);
  expect(body.data).toEqual([expect.objectContaining({ id: CAT, kind: "catalog", name: "beluga_lake", status: "unknown", parentId: null })]);
  expect(body.warnings).toEqual([expect.objectContaining({ code: "NODE_AUTHZ_NOT_ENFORCED", serviceId: "svc-iceberg" })]);
  expect(calls[0]?.url.search).toBe("?warehouse=beluga_lake");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect((await get(app, `/api/v1/data-assets/${CAT}`)).body.childCount).toBeNull();
});

test("catalog -> schemas (top-level namespaces; dotted segment is encoded in the id)", async () => {
  const { app } = lakekeeper();
  const { body } = await get(app, `/api/v1/data-assets?parentId=${CAT}`);
  expect(body.data.map((a: any) => [a.id, a.name, a.namespace, a.parentId])).toEqual([
    [SCHEMA, "analytics", ["analytics"], CAT],
    ["asset-schema-beluga_lake.raw%2Ev1", "raw.v1", ["raw.v1"], CAT],
  ]);
});

test("schema -> nested namespaces + tables, with `parent` sent as %1F-joined namespace", async () => {
  const { app, calls } = lakekeeper();
  const { body } = await get(app, `/api/v1/data-assets?parentId=${SCHEMA}`);
  expect(body.data.map((a: any) => [a.kind, a.id, a.name])).toEqual([
    ["schema", deriveAssetId("schema", ["beluga_lake", "analytics", "marts"]), "analytics.marts"],
    ["table", TABLE, "analytics.orders"],
    ["table", deriveAssetId("table", ["beluga_lake", "analytics", "orders.v2"]), "analytics.orders.v2"],
  ]);
  const nsCall = calls.find((c) => c.url.pathname.endsWith("/namespaces") && c.url.searchParams.has("parent"));
  expect(nsCall?.url.search).toContain("parent=analytics");
  const nested = lakekeeper({
    [`/catalog/v1/${PREFIX}/namespaces`]: () => json({ namespaces: [] }),
    [`/catalog/v1/${PREFIX}/namespaces/analytics${UNIT}marts/tables`]: () => json({ identifiers: [{ namespace: ["analytics", "marts"], name: "t" }] }),
  });
  const r = await get(nested.app, `/api/v1/data-assets?parentId=${deriveAssetId("schema", ["beluga_lake", "analytics", "marts"])}`);
  expect(r.body.data.map((a: any) => a.id)).toEqual([deriveAssetId("table", ["beluga_lake", "analytics", "marts", "t"])]);
});

test("upstream pagination is drained (next-page-token) before Beluga re-slices", async () => {
  const pages: Record<string, unknown> = {
    "": { namespaces: [["a"], ["b"]], "next-page-token": "t2" },
    t2: { namespaces: [["c"]], "next-page-token": "t3" },
    t3: { namespaces: [["d"]], "next-page-token": null },
  };
  const { app, calls } = lakekeeper({ [`/catalog/v1/${PREFIX}/namespaces`]: ({ url }) => json(pages[url.searchParams.get("pageToken") ?? ""]) });
  const { body } = await get(app, `/api/v1/data-assets?parentId=${CAT}&page=2&pageSize=3`);
  expect(body.meta).toEqual({ total: 4, page: 2, pageSize: 3 });
  expect(body.data.map((a: any) => a.name)).toEqual(["d"]);
  expect(calls.filter((c) => c.url.pathname.endsWith("/namespaces"))).toHaveLength(3);
});

test("empty namespace, unknown/legacy/table parentId -> 200 empty list (not 404)", async () => {
  const { app } = lakekeeper({ [`/catalog/v1/${PREFIX}/namespaces`]: () => json({ namespaces: [] }) });
  expect((await get(app, `/api/v1/data-assets?parentId=${CAT}`)).body.data).toEqual([]);
  for (const id of ["asset-schema-analytics", TABLE, "nope", deriveAssetId("catalog", ["other"])]) {
    const r = await get(app, `/api/v1/data-assets?parentId=${id}`);
    expect([r.status, r.body.data]).toEqual([200, []]);
  }
});

test("table detail maps the current schema, partition spec, snapshots; vended credentials never leak", async () => {
  const { app } = lakekeeper();
  const r = await app.request(`/api/v1/data-assets/${TABLE}`);
  const text = await r.text();
  expect(r.status).toBe(200);
  for (const leak of ["AKIA-LEAK", "SECRET-LEAK", "TOKEN-LEAK", "storage-credentials", "metadata-location", SECRET]) expect(text).not.toContain(leak);
  const body = JSON.parse(text);
  expect(body).toMatchObject({
    id: TABLE, name: "analytics.orders", kind: "table", catalog: "beluga_lake", namespace: ["analytics"], parentId: SCHEMA,
    path: ["beluga_lake", "analytics"], format: "Iceberg v2 (parquet)", location: "s3://beluga-lake/warehouse/analytics/orders",
    metadataSummary: { snapshotCount: 2, lastUpdated: "2026-09-28T09:30:00.000Z", partitionSpec: "day(order_date)" },
  });
  expect(body.columns).toEqual([
    { name: "order_id", type: "long", nullable: false, comment: "Order primary key" },
    { name: "order_date", type: "date", nullable: false, isPartition: true },
    { name: "email", type: "string", nullable: true },
    { name: "tags", type: "list<string>", nullable: true },
    { name: "addr", type: "struct<zip: string>", nullable: true },
  ]);
});

test("schema detail / missing table -> 200 / 404; legacy flat id -> 404 without touching upstream", async () => {
  const { app, calls } = lakekeeper();
  expect((await get(app, `/api/v1/data-assets/${SCHEMA}`)).body).toMatchObject({ kind: "schema", childCount: null });
  expect((await get(app, `/api/v1/data-assets/${deriveAssetId("table", ["beluga_lake", "analytics", "missing"])}`)).status).toBe(404);
  const before = calls.length;
  expect((await get(app, "/api/v1/data-assets/asset-table-orders")).status).toBe(404);
  expect(calls.length).toBe(before);
});

test.each([[401], [403], [500], [503]])("upstream %i -> 503 and no partial data or token anywhere", async (status) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const failing: Record<string, Responder> = {
    [`/catalog/v1/${PREFIX}/namespaces`]: () => json({ error: { message: `x ${SECRET}`, type: "T", code: status }, namespaces: [["leak"]] }, status),
    [`/catalog/v1/${PREFIX}/namespaces/analytics/tables/orders`]: () => json(loadTableResult, status),
  };
  const { app } = lakekeeper(failing);
  for (const path of [`/api/v1/data-assets?parentId=${CAT}`, `/api/v1/data-assets/${TABLE}`, `/api/v1/data-assets/${TABLE}/query-context`]) {
    const r = await app.request(path);
    const text = await r.text();
    expect(r.status).toBe(503);
    expect(text).not.toMatch(/leak|AKIA|columns/i);
    expect(text).not.toContain(SECRET);
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
});

test("config 401 (missing/expired credential) degrades the catalog list to 503", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { app } = lakekeeper({ "/catalog/v1/config": () => json({ error: { message: "Missing Authorization Header", type: "MissingAuthorizationHeader", code: 401 } }, 401) });
  const r = await get(app, "/api/v1/data-assets");
  expect([r.status, r.body.error.message]).toEqual([503, expect.stringContaining("did not accept")]);
});

test("malformed bodies (not JSON, wrong shape, namespace not one level below parent, table without schema) -> 503", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const ns = `/catalog/v1/${PREFIX}/namespaces`;
  const cases: Array<[string, Record<string, Responder>]> = [
    [`/api/v1/data-assets?parentId=${CAT}`, { [ns]: () => new Response("<html>", { status: 200 }) }],
    [`/api/v1/data-assets?parentId=${CAT}`, { [ns]: () => json({ namespaces: "x" }) }],
    [`/api/v1/data-assets?parentId=${CAT}`, { [ns]: () => json({ namespaces: [["a", "b"]] }) }],
    [`/api/v1/data-assets`, { "/catalog/v1/config": () => json(["nope"]) }],
    [`/api/v1/data-assets/${TABLE}`, { [`${ns}/analytics/tables/orders`]: () => json({ metadata: { location: "s3://x" } }) }],
  ];
  for (const [path, overrides] of cases) expect((await lakekeeper(overrides).app.request(path)).status).toBe(503);
});

test("timeout -> 503", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { app } = lakekeeper({ "/catalog/v1/config": hangForever }, 20);
  expect((await app.request("/api/v1/data-assets")).status).toBe(503);
});

test("query-context is built from the live asset; multi-level namespaces are not guessed as a Trino schema", async () => {
  const { app } = lakekeeper();
  const ok = await get(app, `/api/v1/data-assets/${TABLE}/query-context`);
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ catalog: "beluga_lake", schema: "analytics", table: "orders", readOnly: true });
  expect(ok.body.sampleSql).toBe('SELECT * FROM "beluga_lake"."analytics"."orders" LIMIT 20');
  const nestedId = deriveAssetId("table", ["beluga_lake", "analytics", "marts", "t"]);
  const nested = lakekeeper({ [`/catalog/v1/${PREFIX}/namespaces/analytics${UNIT}marts/tables/t`]: () => json(loadTableResult) });
  expect((await nested.app.request(`/api/v1/data-assets/${nestedId}/query-context`)).status).toBe(404);
});

test("default app (no source) still serves fixtures with item health warnings and no authz warning", async () => {
  const body = (await (await createApp().request("/api/v1/data-assets?pageSize=100")).json()) as any;
  expect(body.meta.total).toBeGreaterThan(3);
  expect((body.warnings ?? []).some((w: any) => w.code === "NODE_AUTHZ_NOT_ENFORCED")).toBe(false);
});

test("parseAssetId inverts deriveAssetId, including encoded dots, and rejects malformed ids", () => {
  expect(parseAssetId(deriveAssetId("table", ["ice.berg", "a", "b", "orders.v2"]))).toEqual({ kind: "table", segments: ["ice.berg", "a", "b", "orders.v2"] });
  expect(parseAssetId(CAT)).toEqual({ kind: "catalog", segments: ["beluga_lake"] });
  for (const bad of ["asset-table-orders", "asset-schema-analytics", "asset-topic-k.t", "asset-catalog-a.b", "asset-schema-a..b", "x".repeat(300)]) {
    expect(parseAssetId(bad)).toBeUndefined();
  }
});
