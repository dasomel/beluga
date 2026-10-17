// D-MSSO-6: authentication configuration. Same fail-fast rule as the rest of config.ts: an invalid value throws
// ConfigError at startup instead of surfacing per request. Fail-closed: an unset AUTH_MODE is "oidc" in every
// environment (and then requires OIDC_ISSUER); "disabled" exists only when written explicitly and is refused in
// production.
import { ConfigError } from "../config.js";

export const DEFAULT_OIDC_AUDIENCE = "beluga-manager";

export type AuthConfig =
  | { mode: "disabled" }
  | {
      mode: "oidc";
      /** Exact `iss` value expected in tokens (https, no trailing slash). */
      issuer: string;
      /** Value that must be contained in the token's `aud`. */
      audience: string;
      /** Keycloak realm JWKS endpoint derived from the issuer (no discovery call: one fewer trust hop). */
      jwksUri: string;
    };

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const isProduction = env["NODE_ENV"] === "production";
  const raw = env["AUTH_MODE"]?.trim();
  const mode = raw === undefined || raw === "" ? "oidc" : raw;

  if (mode === "disabled") {
    if (isProduction) {
      throw new ConfigError("AUTH_MODE=disabled is not allowed when NODE_ENV=production");
    }
    return { mode: "disabled" };
  }
  if (mode !== "oidc") throw new ConfigError("AUTH_MODE must be 'oidc' or 'disabled'");

  const issuer = env["OIDC_ISSUER"]?.trim();
  if (issuer === undefined || issuer === "") throw new ConfigError("OIDC_ISSUER is required when AUTH_MODE=oidc");
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new ConfigError("OIDC_ISSUER is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ConfigError("OIDC_ISSUER must use https");
  if (url.username !== "" || url.password !== "") throw new ConfigError("OIDC_ISSUER must not embed credentials");
  if (url.search !== "" || url.hash !== "") throw new ConfigError("OIDC_ISSUER must not have a query or fragment");
  // `iss` is compared as an exact string, so a trailing slash would silently never match real tokens.
  if (issuer.endsWith("/")) throw new ConfigError("OIDC_ISSUER must not end with '/'");

  const audience = env["OIDC_AUDIENCE"]?.trim() || DEFAULT_OIDC_AUDIENCE;
  return { mode: "oidc", issuer, audience, jwksUri: `${issuer}/protocol/openid-connect/certs` };
}
