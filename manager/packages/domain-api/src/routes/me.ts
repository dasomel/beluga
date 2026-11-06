import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { meSchema } from "../schema/me.js";
import { internalErrorResponse, unauthenticatedResponse } from "../lib/errorResponses.js";

const meRoute = createRoute({
  method: "get",
  path: "/api/v1/me",
  tags: ["Authentication"],
  summary: "Get the authenticated user",
  responses: {
    200: { description: "The verified caller identity.", content: { "application/json": { schema: meSchema } } },
    401: unauthenticatedResponse,
    500: internalErrorResponse,
  },
});

export function registerMeRoutes(app: OpenAPIHono) {
  app.openapi(meRoute, (c) => {
    const principal = c.get("principal");
    // Defensive for disabled/test wiring; production requests reach here only after auth middleware.
    if (principal === undefined) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: { code: "UNAUTHENTICATED" as const, message: "Authentication required" } }, 401);
    }
    return c.json({ sub: principal.sub, ...(principal.username ? { name: principal.username } : {}), groups: principal.groups }, 200);
  });
}
