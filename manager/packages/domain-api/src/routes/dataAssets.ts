import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { buildListEnvelope, healthWarning } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { dataAssetSchema } from "../schema/dataAsset.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { statusFilterableListQuerySchema } from "../schema/query.js";
import { dataAssets } from "../stub-data/dataAssets.js";

const dataAssetListResponseSchema = listResponseSchema(dataAssetSchema, "DataAssetListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/data-assets",
  tags: ["Data Assets"],
  summary: "List Beluga data assets (tables, topics, schemas) across services",
  request: { query: statusFilterableListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of data assets, optionally filtered by status.",
      content: { "application/json": { schema: dataAssetListResponseSchema } },
    },
    // services.ts와 동일한 이유 (issue #43 finding #2).
    400: {
      description: "Query validation failed (e.g. page < 1, pageSize > 100, unknown status).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerDataAssetRoutes(app: OpenAPIHono) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, status } = c.req.valid("query");
    const filtered = dataAssets.filter((asset) => status === undefined || asset.status === status);
    const { pageItems, total } = paginate(filtered, page, pageSize);
    const warnings = pageItems
      .map((asset) => healthWarning(asset.status, asset.name, asset.serviceId))
      .filter((warning) => warning !== null);

    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, warnings), 200);
  });
}
