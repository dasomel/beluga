import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cachedOverview, type OverviewSource } from "../adapters/overviewSource.js";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { decisionListQuerySchema, decisionRecordSchema, type DecisionRecord } from "../schema/decision.js";
import { decisions } from "../stub-data/decisions.js";
import { requireGroup } from "../auth/middleware.js";

const decisionListResponseSchema = listResponseSchema(decisionRecordSchema, "DecisionListResponse");
const listRoute = (auditBacked: boolean) => createRoute({
  method: "get", path: "/api/v1/decisions", tags: ["Decisions"],
  summary: "List read-only System-1 decision projections",
  ...(auditBacked ? { description: "Audit-backed records are restricted to the admins group." } : {}),
  ...(auditBacked ? { middleware: [requireGroup("admins")] } : {}),
  request: { query: decisionListQuerySchema },
  responses: {
    200: { description: "Paginated decision projections, optionally filtered by decision.", content: { "application/json": { schema: decisionListResponseSchema } } },
    400: { description: "Query validation failed.", content: { "application/json": { schema: errorResponseSchema } } },
    ...(auditBacked ? { 401: { description: "Authentication required.", content: { "application/json": { schema: errorResponseSchema } } }, 403: { description: "Not a member of group admins.", content: { "application/json": { schema: errorResponseSchema } } } } : {}),
    500: internalErrorResponse,
  },
});
const detailRoute = (auditBacked: boolean) => createRoute({
  method: "get", path: "/api/v1/decisions/{id}", tags: ["Decisions"], summary: "Get a decision projection by id",
  ...(auditBacked ? { description: "Audit-backed records are restricted to the admins group." } : {}),
  ...(auditBacked ? { middleware: [requireGroup("admins")] } : {}),
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    200: { description: "The decision projection.", content: { "application/json": { schema: decisionRecordSchema } } },
    404: { description: "No decision exists with this id.", content: { "application/json": { schema: errorResponseSchema } } },
    ...(auditBacked ? { 401: { description: "Authentication required.", content: { "application/json": { schema: errorResponseSchema } } }, 403: { description: "Not a member of group admins.", content: { "application/json": { schema: errorResponseSchema } } } } : {}),
    500: internalErrorResponse,
  },
});

export function registerDecisionRoutes(app: OpenAPIHono, records: DecisionRecord[] | OverviewSource<DecisionRecord> = decisions, auditBacked = false) {
  const securedListRoute = listRoute(auditBacked);
  const securedDetailRoute = detailRoute(auditBacked);
  const read = cachedOverview(records);
  app.openapi(securedListRoute, async (c) => {
    const { page, pageSize, decision } = c.req.valid("query");
    const batch = await read();
    const filtered = batch.items.filter((record) => decision === undefined || record.result.decision === decision);
    const { pageItems, total } = paginate(filtered, page, pageSize);
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, batch.warnings), 200);
  });
  app.openapi(securedDetailRoute, async (c) => {
    const { id } = c.req.valid("param");
    const batch = await read();
    const found = batch.items.find((record) => record.id === id);
    // D365-6: a bounded audit sample cannot prove absence. Cost: 500 for older IDs;
    // escape hatch: add a dedicated parameterized lookup when full-history navigation is needed.
    if (!found && batch.inventoryComplete === false) throw new Error("decision inventory incomplete");
    if (!found) return c.json({ error: { code: "NOT_FOUND" as const, message: `Decision '${id}' was not found` } }, 404);
    return c.json(found, 200);
  });
}
