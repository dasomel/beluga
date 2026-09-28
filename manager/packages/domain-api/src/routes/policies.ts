import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import {
  policyListQuerySchema,
  policyProjectionSchema,
  type PolicyProjection,
} from "../schema/policy.js";
import { policies } from "../stub-data/policies.js";

const policyListResponseSchema = listResponseSchema(policyProjectionSchema, "PolicyListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/policies",
  tags: ["Policies"],
  summary: "List read-only policy summary projections",
  request: { query: policyListQuerySchema },
  responses: {
    200: {
      description: "Paginated policy summary projections, optionally filtered by role.",
      content: { "application/json": { schema: policyListResponseSchema } },
    },
    400: {
      description: "Query validation failed.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/api/v1/policies/{id}",
  tags: ["Policies"],
  summary: "Get a policy summary projection by id",
  request: { params: z.object({ id: z.string().min(1).openapi({ example: "beluga-platform-policy" }) }) },
  responses: {
    200: {
      description: "The policy summary projection.",
      content: { "application/json": { schema: policyProjectionSchema } },
    },
    404: {
      description: "No policy exists with this id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerPolicyRoutes(app: OpenAPIHono, records: PolicyProjection[] = policies) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, role } = c.req.valid("query");
    const filtered = records.filter(
      (record) => role === undefined || record.roles.some((r) => r.name === role),
    );
    const { pageItems, total } = paginate(filtered, page, pageSize);
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
  });

  app.openapi(detailRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = records.find((record) => record.id === id);
    if (!found) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Policy '${id}' was not found` } }, 404);
    }
    return c.json(found, 200);
  });
}
