// D-MSSO-6/7: Hono middleware. Trust model: only `Authorization: Bearer <JWT>` on the request itself.
// Cookies and forwarded identity headers (X-Forwarded-User, X-Auth-*, ...) are never read, so there is no
// ambient credential and CSRF does not apply (ADR-0006 section 0).
import type { Context, MiddlewareHandler } from "hono";
import { AuthError, type Principal, type TokenVerifier } from "./oidc.js";

declare module "hono" {
  interface ContextVariableMap {
    principal?: Principal;
  }
}

// Public on purpose (D-MSSO-6 decision record in docs): /health is a probe target (kubelet cannot send a
// bearer) and exposes only status+version; the OpenAPI document and Swagger UI describe the contract and carry
// no platform data. Everything else under /api/v1 requires a valid token.
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/api/v1/health", "/api/v1/openapi.json", "/api/v1/docs"]);

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

function unauthorized(c: Context, message: string, invalidToken: boolean) {
  c.header("WWW-Authenticate", invalidToken ? 'Bearer error="invalid_token"' : "Bearer");
  return c.json({ error: { code: "UNAUTHENTICATED" as const, message } }, 401);
}

export function createAuthMiddleware(verifier: TokenVerifier): MiddlewareHandler {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();

    const header = c.req.header("Authorization");
    if (header === undefined) return unauthorized(c, "Authentication required", false);
    const match = BEARER.exec(header);
    if (!match) return unauthorized(c, "Authorization header must be 'Bearer <token>'", true);

    try {
      c.set("principal", await verifier.verify(match[1] as string));
    } catch (error) {
      if (error instanceof AuthError && error.kind === "invalid") {
        return unauthorized(c, "Invalid or expired token", true);
      }
      // Could not decide (JWKS down, unexpected failure): fail closed with 503, detail only in the server log.
      console.error("[auth] token validation unavailable:", error);
      return c.json(
        { error: { code: "SERVICE_UNAVAILABLE" as const, message: "Authentication service unavailable" } },
        503,
      );
    }
    return next();
  };
}

/**
 * D-MSSO-7: deny-by-default group gate for write routes (none exist yet). Must run after the auth middleware.
 * No principal -> 401; principal without the exact group -> 403. Groups come from the verified token only.
 */
export function requireGroup(group: string): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal === undefined) return unauthorized(c, "Authentication required", false);
    if (!principal.groups.includes(group)) {
      return c.json({ error: { code: "FORBIDDEN" as const, message: `Membership of group '${group}' is required` } }, 403);
    }
    return next();
  };
}
