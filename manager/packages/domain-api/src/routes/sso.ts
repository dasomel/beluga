import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { internalErrorResponse, unauthenticatedResponse } from "../lib/errorResponses.js";
import { errorResponseSchema } from "../schema/envelope.js";
import { ssoResponseSchema } from "../schema/sso.js";
import {
  createSsoAdapterFromEnv,
  SsoConfigError,
  type SsoAdapter,
} from "../adapters/sso/ssoAdapter.js";

// D-MSSO-1: GET /api/v1/sso reads declared Git configuration from gitops/values/sso.yaml.
// D-MSSO-2: Read-only endpoint. Mutations (Stage 3) will be handled via GitOps pull requests.
// D-MSSO-3: 503 Service Unavailable returned on invalid/malformed configuration files.

export const ssoRoute = createRoute({
  method: "get",
  path: "/api/v1/sso",
  tags: ["SSO"],
  summary: "Get read-only declared GitOps SSO configuration",
  responses: {
    200: {
      description: "Declared GitOps SSO configuration or typed not-configured state.",
      content: { "application/json": { schema: ssoResponseSchema } },
    },
    401: unauthenticatedResponse,
    503: {
      description: "SSO source is malformed, violates domain validation rules, or is unavailable (GitHub unreachable beyond the stale window).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerSsoRoutes(
  app: OpenAPIHono,
  ssoAdapter: SsoAdapter = createSsoAdapterFromEnv(process.env),
): void {
  app.openapi(ssoRoute, async (c) => {
    try {
      const response = await ssoAdapter.getSsoConfig();
      return c.json(response, 200);
    } catch (error) {
      if (error instanceof SsoConfigError) {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE" as const,
              message: error.message,
            },
          },
          503,
        );
      }
      throw error;
    }
  });

  // Alias endpoint for convenience (/sso/config)
  app.get("/api/v1/sso/config", (c) => c.redirect("/api/v1/sso", 307));
}
