// D-MSSO-6: bearer JWT validation against the realm JWKS (jose). Only a verified token yields a Principal.
// TLS to the issuer is verified by Node's default trust store; an internal CA is added with the process-level
// NODE_EXTRA_CA_CERTS (docs/development.md) -- there is deliberately no option here to disable verification.
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from "jose";
import type { AuthConfig } from "./authConfig.js";

export interface Principal {
  sub: string;
  username?: string;
  /** Normalized group names ('/admins' -> 'admins'), taken only from the verified token. */
  groups: string[];
}

/** "invalid": the credential is bad (401). "unavailable": we could not decide, e.g. JWKS unreachable (503). */
export class AuthError extends Error {
  constructor(public readonly kind: "invalid" | "unavailable", message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export interface OidcVerifierOptions {
  fetchImpl?: typeof fetch;
  /** Minimum time between JWKS refetches triggered by an unknown kid (jose cooldown). Default 30s. */
  jwksCooldownMs?: number;
  jwksTimeoutMs?: number;
}

// D-MSSO-6 (Proposed in ADR-0009): small clock skew.
const CLOCK_TOLERANCE_S = 30;
// Cheap upper bound before any parsing; real Keycloak access tokens are a few KB.
export const MAX_TOKEN_LENGTH = 8192;

// Whitelist: only errors that prove the *token* is bad map to 401. Anything else (JWKS timeout/HTTP error,
// malformed JWKS, network failure, unexpected exceptions) means we could not validate -> 503, never "allow".
function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return false;
  return (
    error.code.startsWith("ERR_JWT_") ||
    error.code.startsWith("ERR_JWS_") ||
    error.code.startsWith("ERR_JWE_") ||
    error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
    error.code === "ERR_JWKS_NO_MATCHING_KEY" ||
    error.code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS"
  );
}

// D-MSSO-7a: the Keycloak "Group Membership" mapper must have `full.path` = true (docs/api-reference.md), so top-level
// groups arrive as '/admins'. Only top-level names are meaningful here: '/admins' and 'admins' both become 'admins';
// a sub-group path ('/x/admins', 'x/admins', '//admins') is dropped, so it can never be mistaken for 'admins'.
// Wrong types -> none.
export function normalizeGroups(claim: unknown): string[] {
  if (!Array.isArray(claim)) return [];
  const out: string[] = [];
  for (const item of claim) {
    if (typeof item !== "string") continue;
    const name = item.startsWith("/") ? item.slice(1) : item;
    if (name === "" || name.includes("/")) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function toPrincipal(payload: JWTPayload): Principal {
  const username = payload["preferred_username"];
  return {
    sub: payload.sub as string, // required via requiredClaims
    ...(typeof username === "string" && username !== "" ? { username } : {}),
    groups: normalizeGroups(payload["groups"]),
  };
}

export function createOidcVerifier(
  config: Extract<AuthConfig, { mode: "oidc" }>,
  options: OidcVerifierOptions = {},
): TokenVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cooldownDuration: options.jwksCooldownMs ?? 30_000,
    timeoutDuration: options.jwksTimeoutMs ?? 5_000,
    [customFetch]: (url, init) => fetchImpl(url, { ...init, redirect: "error" }),
  });

  return {
    async verify(token: string): Promise<Principal> {
      if (token.length > MAX_TOKEN_LENGTH) throw new AuthError("invalid", "token too large");
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ["RS256"], // pinned: rejects none, HS* (key confusion) and anything else
          issuer: config.issuer, // exact match
          audience: config.audience, // aud must contain it
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ["exp", "sub"],
        });
        // D-MSSO-6a: Keycloak marks access tokens `typ: "Bearer"` (ID tokens: "ID", refresh: "Refresh"). Without
        // this an ID token (same iss/sub, aud = client id) would pass as an API credential.
        if (payload["typ"] !== "Bearer") throw new AuthError("invalid", "wrong token type");
        return toPrincipal(payload);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        if (isInvalidTokenError(error)) throw new AuthError("invalid", "token rejected");
        throw new AuthError("unavailable", "unable to validate token");
      }
    },
  };
}
