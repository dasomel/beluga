// Test IdP: real RSA keys generated with jose, a JWKS served through an injected fetch (no sockets), and a signer.
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import type { AuthConfig } from "../../src/auth/authConfig.js";

export const ISSUER = "https://sso.local.beluga.internal/realms/beluga";
export const AUDIENCE = "beluga-manager";
export const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
export const OIDC_CONFIG: Extract<AuthConfig, { mode: "oidc" }> = {
  mode: "oidc",
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: JWKS_URI,
};

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export interface FakeIdp {
  fetchImpl: typeof fetch;
  calls: () => number;
  /** Replace the published key set (key rotation). */
  publish: (keys: TestKey[]) => void;
  /** Make the JWKS endpoint fail: "reject" = network error, number = HTTP status. */
  fail: (mode: "reject" | number | null) => void;
}

export function fakeIdp(initial: TestKey[]): FakeIdp {
  let keys = initial;
  let failure: "reject" | number | null = null;
  let count = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url !== JWKS_URI) return new Response("not found", { status: 404 });
    count++;
    if (failure === "reject") throw new TypeError("fetch failed");
    if (typeof failure === "number") return new Response("boom", { status: failure });
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls: () => count,
    publish: (next) => {
      keys = next;
    },
    fail: (mode) => {
      failure = mode;
    },
  };
}

export interface TokenOptions {
  key: TestKey;
  iss?: string;
  aud?: string | string[];
  sub?: string | null;
  /** seconds relative to now; null = omit */
  exp?: number | null;
  nbf?: number;
  claims?: Record<string, unknown>;
}

export async function signToken(o: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ typ: "Bearer", preferred_username: "alice", groups: ["/admins"], ...o.claims })
    .setProtectedHeader({ alg: "RS256", kid: o.key.kid })
    .setIssuedAt(now)
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE);
  if (o.sub !== null) jwt.setSubject(o.sub ?? "user-1");
  if (o.exp !== null) jwt.setExpirationTime(now + (o.exp ?? 300));
  if (o.nbf !== undefined) jwt.setNotBefore(now + o.nbf);
  return jwt.sign(o.key.privateKey);
}

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function unsignedToken(kid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, aud: AUDIENCE, sub: "user-1", exp: now + 300, groups: ["/admins"] };
  return `${b64url(JSON.stringify({ alg: "none", kid }))}.${b64url(JSON.stringify(payload))}.`;
}

/** Classic key-confusion attempt: HS256 MAC keyed with the (public) JWK material. */
export async function hs256Token(key: TestKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "Bearer", groups: ["/admins"] })
    .setProtectedHeader({ alg: "HS256", kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user-1")
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(String(key.jwk.n)));
}
