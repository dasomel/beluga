import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { decisionListQuerySchema, decisionRecordSchema, type DecisionRecord } from "../schema/decision.js";
import { decisions } from "../stub-data/decisions.js";

const decisionListResponseSchema = listResponseSchema(decisionRecordSchema, "DecisionListResponse");
const listRoute = createRoute({
  method: "get", path: "/api/v1/decisions", tags: ["Decisions"],
  summary: "List read-only System-1 decision projections",
  request: { query: decisionListQuerySchema },
  responses: {
    200: { description: "Paginated decision projections, optionally filtered by decision.", content: { "application/json": { schema: decisionListResponseSchema } } },
    400: { description: "Query validation failed.", content: { "application/json": { schema: errorResponseSchema } } },
    500: internalErrorResponse,
  },
});
const detailRoute = createRoute({
  method: "get", path: "/api/v1/decisions/{id}", tags: ["Decisions"], summary: "Get a decision projection by id",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "The decision projection.", content: { "application/json": { schema: decisionRecordSchema } } },
    404: { description: "No decision exists with this id.", content: { "application/json": { schema: errorResponseSchema } } },
    500: internalErrorResponse,
  },
});

export function registerDecisionRoutes(app: OpenAPIHono, records: DecisionRecord[] = decisions) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, decision } = c.req.valid("query");
    const filtered = records.filter((record) => decision === undefined || record.result.decision === decision);
    const { pageItems, total } = paginate(filtered, page, pageSize);
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
  });
  app.openapi(detailRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = records.find((record) => record.id === id);
    if (!found) return c.json({ error: { code: "NOT_FOUND" as const, message: `Decision '${id}' was not found` } }, 404);
    return c.json(found, 200);
  });
}
