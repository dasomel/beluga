import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { resourceSchema, type Resource } from "../schema/resource.js";
import { resourceListQuerySchema } from "../schema/query.js";
import { resources } from "../stub-data/resources.js";

const resourceListResponseSchema = listResponseSchema(resourceSchema, "ResourceListResponse");
const listRoute = createRoute({ method: "get", path: "/api/v1/resources", tags: ["Resources"], summary: "List Kubernetes resources", request: { query: resourceListQuerySchema }, responses: {
  200: { description: "Paginated resources, optionally filtered by namespace and kind.", content: { "application/json": { schema: resourceListResponseSchema } } },
  400: { description: "Query validation failed.", content: { "application/json": { schema: errorResponseSchema } } },
  500: internalErrorResponse,
} });
const getByIdRoute = createRoute({ method: "get", path: "/api/v1/resources/{id}", tags: ["Resources"], summary: "Get a resource by id", request: { params: z.object({ id: z.string().min(1).openapi({ example: "k8s-pod-flink-jobmanager" }) }) }, responses: {
  200: { description: "The resource.", content: { "application/json": { schema: resourceSchema } } },
  404: { description: "No resource exists with this id.", content: { "application/json": { schema: errorResponseSchema } } },
  500: internalErrorResponse,
} });

export function registerResourceRoutes(app: OpenAPIHono, resourceData: Resource[] = resources) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, namespace, kind } = c.req.valid("query");
    const filtered = resourceData.filter((resource) => (namespace === undefined || resource.namespace === namespace) && (kind === undefined || resource.kind === kind));
    const { pageItems, total } = paginate(filtered, page, pageSize);
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
  });
  app.openapi(getByIdRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = resourceData.find((resource) => resource.id === id);
    if (!found) return c.json({ error: { code: "NOT_FOUND" as const, message: `Resource '${id}' was not found` } }, 404);
    return c.json(found, 200);
  });
}
