import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { internalErrorResponse } from "../lib/errorResponses.js";
import type { DataAssetDetail } from "../schema/dataAsset.js";
import { errorResponseSchema } from "../schema/envelope.js";
import { queryContextSchema } from "../schema/queryContext.js";
import { dataAssetDetails } from "../stub-data/dataAssets.js";
import { toDataAssetSource, type DataAssetSource } from "../adapters/dataAssetSource.js";
import { describeUpstreamFailure, isUpstreamError } from "../adapters/upstream/errors.js";
import type { ServiceAdapterRegistry } from "../adapters/registry.js";
import { createStubRegistry } from "../adapters/stubAdapter.js";

// Stub 단계의 Trino catalog 이름 — web의 카탈로그 뷰(beluga_lake)와 일치시킨다. 실제
// Lakekeeper/Trino 어댑터(#41/#42)가 들어오면 upstream 값으로 대체된다.
const TRINO_CATALOG = "beluga_lake";
const SAMPLE_ROW_LIMIT = 20;
const TRINO_SERVICE_ID = "svc-trino";

// 항상 따옴표로 감싸 예약어/특수문자 식별자를 안전하게 처리한다.
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const route = createRoute({
  method: "get",
  path: "/api/v1/data-assets/{id}/query-context",
  tags: ["Data Assets"],
  summary: "Get the Trino query entry context (catalog.schema.table + read-only starter SQL) for a table asset",
  description:
    "Hands a Catalog selection over to Trino. Manager does not execute SQL: the response only carries " +
    "the addressing context and a read-only, row-limited starter statement; execution and authorization " +
    "stay with Trino.",
  request: { params: z.object({ id: z.string().min(1).openapi({ example: "asset-table-orders" }) }) },
  responses: {
    200: {
      description: "Query entry context for the table asset.",
      content: { "application/json": { schema: queryContextSchema } },
    },
    404: {
      description: "No data asset with this id, or the asset is not a queryable table (topic/schema).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    503: {
      description:
        "The asset is queryable but the Trino service is unavailable (adapter failed, timed out, or has no endpoint). " +
        "Also returned when a configured live catalog source fails. Distinct from 404 so clients can retry instead of treating the asset as non-queryable.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

function stripNamespacePrefix(name: string, namespace: string[]): string {
  const prefix = namespace.length > 0 ? `${namespace.join(".")}.` : "";
  return prefix !== "" && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function registerQueryContextRoutes(
  app: OpenAPIHono,
  source: readonly DataAssetDetail[] | DataAssetSource = dataAssetDetails,
  registry: ServiceAdapterRegistry = createStubRegistry(),
) {
  const assets = toDataAssetSource(source);
  app.openapi(route, async (c) => {
    const { id } = c.req.valid("param");
    let asset;
    try {
      asset = await assets.get(id);
    } catch (error) {
      console.error("Data asset source failed", isUpstreamError(error) ? `${error.kind}${error.status ? ` ${error.status}` : ""}` : error);
      return c.json({ error: { code: "SERVICE_UNAVAILABLE" as const, message: describeUpstreamFailure(error, "Data asset catalog") } }, 503);
    }

    if (!asset) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' was not found` } }, 404);
    }

    // 404는 알 수 없는/질의 불가 자산에만 쓴다. Trino가 없거나 endpoint가 없으면(어댑터 실패/타임아웃
    // 포함) 자산 문제가 아니므로 503 SERVICE_UNAVAILABLE로 구분한다.
    // 이름 규칙은 "schema.table" 두 단계(ADR-0004 이전의 flat 모델). 그 모양이 아니면
    // 추측으로 주소를 만들지 않고 질의 불가로 처리한다.
    // 구조화 필드(catalog/namespace, ADR-0004 D2/D8)가 있으면 그것을 우선 쓰고 없을 때만 name을 쪼갠다.
    // namespace가 한 단계가 아니면(다단계 Iceberg namespace) Trino schema로 추측하지 않는다.
    // name은 flat 호환상 "ns.table" 이거나 leaf일 수 있으므로, namespace 접두사만 떼어 낸 나머지 전체가
    // table 이름이다(점이 든 "orders.v2"도 보존).
    const parts = asset.namespace ? [...asset.namespace, stripNamespacePrefix(asset.name, asset.namespace)] : asset.name.split(".");
    if (asset.kind !== "table" || parts.length !== 2) {
      return c.json(
        { error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' has no Trino query context` } },
        404,
      );
    }
    const trino = await registry.getService(TRINO_SERVICE_ID);
    if (!trino?.endpoint) {
      return c.json(
        { error: { code: "SERVICE_UNAVAILABLE" as const, message: "Trino service is currently unavailable" } },
        503,
      );
    }

    const [schema, table] = parts as [string, string];
    const catalog = asset.catalog ?? TRINO_CATALOG;
    return c.json(
      queryContextSchema.parse({
        assetId: asset.id,
        catalog,
        schema,
        table,
        trinoServiceId: trino.id,
        trinoUiUrl: trino.endpoint,
        sampleSql: `SELECT * FROM ${[catalog, schema, table].map(quote).join(".")} LIMIT ${SAMPLE_ROW_LIMIT}`,
        readOnly: true,
        rowLimit: SAMPLE_ROW_LIMIT,
      }),
      200,
    );
  });
}
