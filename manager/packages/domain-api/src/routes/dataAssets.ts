import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { toDataAssetSource, withRouteDeadline, type DataAssetSource } from "../adapters/dataAssetSource.js";
import { describeUpstreamFailure, isUpstreamError } from "../adapters/upstream/errors.js";
import { buildListEnvelope, healthWarning } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { dataAssetDetailSchema, dataAssetSchema, toDataAsset, type DataAssetDetail } from "../schema/dataAsset.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { dataAssetListQuerySchema } from "../schema/query.js";
import { dataAssetDetails } from "../stub-data/dataAssets.js";

const dataAssetListResponseSchema = listResponseSchema(dataAssetSchema, "DataAssetListResponse");

const unavailableResponse = {
  description:
    "A live catalog source is configured but failed (unreachable, timeout, 401/403 from upstream, 5xx, malformed). " +
    "No partial data is returned. Never produced by the default fixture source.",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/data-assets",
  tags: ["Data Assets"],
  summary: "List Beluga data assets (catalogs, schemas, tables, topics) across services",
  description:
    "Supports `status`, `kind` (catalog/schema/table/topic) and `parentId` filters. `parentId` returns " +
    "the direct children of that asset (catalog -> schemas -> tables); an unknown `parentId` yields an " +
    "empty list. Omitting it keeps the flat all-assets list; use `kind=catalog` for top-level catalogs. `meta.total` reflects the " +
    "filtered count (before pagination) -- callers that need an exact count of a kind across " +
    "all pages (e.g. a KPI) must read `meta.total`, not `data.length`, since `data` is only the " +
    "current page. With the optional live Lakekeeper source (env-enabled, default off) omitting `parentId` " +
    "returns the configured top-level catalogs only, `status` is `unknown`, and every response carries a " +
    "`NODE_AUTHZ_NOT_ENFORCED` warning (ADR-0004 D7).",
  request: { query: dataAssetListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of data assets, optionally filtered by status and/or kind.",
      content: { "application/json": { schema: dataAssetListResponseSchema } },
    },
    // services.ts와 동일한 이유 (issue #43 finding #2).
    400: {
      description: "Query validation failed (e.g. page < 1, pageSize > 100, unknown status/kind).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    503: unavailableResponse,
    500: internalErrorResponse,
  },
});

const getByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/data-assets/{id}",
  tags: ["Data Assets"],
  summary: "Get a single data asset by id with table details if applicable",
  request: { params: z.object({ id: z.string().min(1).openapi({ example: "asset-table-orders" }) }) },
  responses: {
    200: {
      description: "The data asset detail.",
      content: { "application/json": { schema: dataAssetDetailSchema } },
    },
    404: {
      description: "No data asset exists with this id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    503: unavailableResponse,
    500: internalErrorResponse,
  },
});

export function registerDataAssetRoutes(
  app: OpenAPIHono,
  source: readonly DataAssetDetail[] | DataAssetSource = dataAssetDetails,
) {
  const assets = toDataAssetSource(source);

  app.openapi(listRoute, async (c) => {
    const { page, pageSize, status, kind, parentId } = c.req.valid("query");
    let result;
    try {
      result = await withRouteDeadline(assets.list(parentId === undefined ? {} : { parentId }));
    } catch (error) {
      console.error("Data asset source failed", isUpstreamError(error) ? `${error.kind}${error.status ? ` ${error.status}` : ""}` : error);
      return c.json({ error: { code: "SERVICE_UNAVAILABLE" as const, message: describeUpstreamFailure(error, "Data asset catalog") } }, 503);
    }
    // parentId가 알 수 없는 id면 404가 아니라 빈 목록이다(ADR-0004 test plan).
    const filtered = result.assets.filter(
      (asset) => (status === undefined || asset.status === status) && (kind === undefined || asset.kind === kind),
    );
    const { pageItems, total } = paginate(filtered, page, pageSize);
    const itemWarnings = assets.emitsItemHealthWarnings
      ? pageItems.map((asset) => healthWarning(asset.status, asset.name, asset.serviceId)).filter((warning) => warning !== null)
      : [];

    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, [...result.warnings, ...itemWarnings]), 200);
  });

  app.openapi(getByIdRoute, async (c) => {
    const { id } = c.req.valid("param");
    let found;
    try {
      found = await withRouteDeadline(assets.get(id));
    } catch (error) {
      console.error("Data asset source failed", isUpstreamError(error) ? `${error.kind}${error.status ? ` ${error.status}` : ""}` : error);
      return c.json({ error: { code: "SERVICE_UNAVAILABLE" as const, message: describeUpstreamFailure(error, "Data asset catalog") } }, 503);
    }

    if (!found) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' was not found` } }, 404);
    }

    return c.json(found, 200);
  });
}
