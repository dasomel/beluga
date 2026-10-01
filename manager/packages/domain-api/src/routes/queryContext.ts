import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { internalErrorResponse } from "../lib/errorResponses.js";
import type { DataAssetDetail } from "../schema/dataAsset.js";
import { errorResponseSchema } from "../schema/envelope.js";
import { queryContextSchema } from "../schema/queryContext.js";
import { dataAssetDetails } from "../stub-data/dataAssets.js";
import { services } from "../stub-data/services.js";

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
    500: internalErrorResponse,
  },
});

export function registerQueryContextRoutes(app: OpenAPIHono, assetDetails: DataAssetDetail[] = dataAssetDetails) {
  app.openapi(route, (c) => {
    const { id } = c.req.valid("param");
    const asset = assetDetails.find((candidate) => candidate.id === id);

    if (!asset) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' was not found` } }, 404);
    }

    // Trino endpoint 미설정(!trino?.endpoint)은 404와 구분되는 상태이지만, 현재는 `services`가
    // 정적 stub이고 svc-trino가 항상 endpoint를 가지므로 이 분기는 도달 불가다. 에러 envelope의
    // errorCodeSchema에도 "unavailable" 코드가 없어 의도적으로 404에 합쳐 둔다. 실제 어댑터
    // (#41/#42)가 서비스 상태를 동적으로 조회하게 되면 503 + 별도 코드로 분리해야 한다.
    // 이름 규칙은 "schema.table" 두 단계(ADR-0004 이전의 flat 모델). 그 모양이 아니면
    // 추측으로 주소를 만들지 않고 질의 불가로 처리한다.
    const parts = asset.name.split(".");
    const trino = services.find((svc) => svc.id === TRINO_SERVICE_ID);
    if (asset.kind !== "table" || parts.length !== 2 || !trino?.endpoint) {
      return c.json(
        { error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' has no Trino query context` } },
        404,
      );
    }

    const [schema, table] = parts as [string, string];
    return c.json(
      queryContextSchema.parse({
        assetId: asset.id,
        catalog: TRINO_CATALOG,
        schema,
        table,
        trinoServiceId: trino.id,
        trinoUiUrl: trino.endpoint,
        sampleSql: `SELECT * FROM ${[TRINO_CATALOG, schema, table].map(quote).join(".")} LIMIT ${SAMPLE_ROW_LIMIT}`,
        readOnly: true,
        rowLimit: SAMPLE_ROW_LIMIT,
      }),
      200,
    );
  });
}
