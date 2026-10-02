import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope, healthWarning } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { dataAssetDetailSchema, dataAssetSchema, toDataAsset, type DataAssetDetail } from "../schema/dataAsset.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { dataAssetListQuerySchema } from "../schema/query.js";
import { dataAssetDetails } from "../stub-data/dataAssets.js";

const dataAssetListResponseSchema = listResponseSchema(dataAssetSchema, "DataAssetListResponse");

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
    "current page.",
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
    500: internalErrorResponse,
  },
});

export function registerDataAssetRoutes(
  app: OpenAPIHono,
  assetDetails: DataAssetDetail[] = dataAssetDetails,
) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, status, kind, parentId } = c.req.valid("query");
    const listItems = assetDetails.map(toDataAsset);
    // parentId가 알 수 없는 id면 404가 아니라 빈 목록이다(ADR-0004 test plan).
    const filtered = listItems.filter(
      (asset) =>
        (status === undefined || asset.status === status) &&
        (kind === undefined || asset.kind === kind) &&
        (parentId === undefined || asset.parentId === parentId),
    );
    const { pageItems, total } = paginate(filtered, page, pageSize);
    const warnings = pageItems
      .map((asset) => healthWarning(asset.status, asset.name, asset.serviceId))
      .filter((warning) => warning !== null);

    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, warnings), 200);
  });

  app.openapi(getByIdRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = assetDetails.find((asset) => asset.id === id);

    if (!found) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Data asset '${id}' was not found` } }, 404);
    }

    return c.json(found, 200);
  });
}
