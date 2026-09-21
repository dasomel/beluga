import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope, healthWarning } from "../lib/envelope.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { serviceListQuerySchema } from "../schema/query.js";
import { serviceSchema } from "../schema/service.js";
import { services } from "../stub-data/services.js";

const serviceListResponseSchema = listResponseSchema(serviceSchema, "ServiceListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/services",
  tags: ["Services"],
  summary: "List Beluga's unified view of every integrated OSS service",
  request: { query: serviceListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of services, optionally filtered by type and/or status.",
      content: { "application/json": { schema: serviceListResponseSchema } },
    },
  },
});

const getByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{id}",
  tags: ["Services"],
  summary: "Get a single service by id",
  request: { params: z.object({ id: z.string().min(1).openapi({ example: "svc-trino" }) }) },
  responses: {
    200: {
      description: "The service.",
      content: { "application/json": { schema: serviceSchema } },
    },
    404: {
      description: "No service exists with this id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

export function registerServiceRoutes(app: OpenAPIHono) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, type, status } = c.req.valid("query");
    const filtered = services.filter(
      (svc) => (type === undefined || svc.type === type) && (status === undefined || svc.status === status),
    );
    const { pageItems, total } = paginate(filtered, page, pageSize);
    const warnings = pageItems
      .map((svc) => healthWarning(svc.status, svc.name, svc.id))
      .filter((warning) => warning !== null);

    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, warnings), 200);
  });

  app.openapi(getByIdRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = services.find((svc) => svc.id === id);

    if (!found) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Service '${id}' was not found` } }, 404);
    }

    return c.json(found, 200);
  });
}
