import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSsoAdapter } from "../src/adapters/sso/ssoAdapter.js";
import { createApp } from "../src/app.js";
import { createOidcVerifier, normalizeGroups } from "../src/auth/oidc.js";
import { errorResponseSchema } from "../src/schema/envelope.js";
import { fakeIdp, hs256Token, makeKey, OIDC_CONFIG, signToken, unsignedToken, ISSUER, AUDIENCE } from "./helpers/oidc.js";

const FIXTURE = path.resolve(__dirname, "fixtures/sso.yaml");

async function setup(options: { cooldownMs?: number } = {}) {
  const key = await makeKey("k1");
  const idp = fakeIdp([key]);
  const verifier = createOidcVerifier(OIDC_CONFIG, { fetchImpl: idp.fetchImpl, jwksCooldownMs: options.cooldownMs ?? 0 });
  const sso = createFileSsoAdapter({ filePath: FIXTURE, isProduction: false });
  const app = createApp(undefined, undefined, undefined, undefined, sso, verifier);
  const get = (p: string, headers: Record<string, string> = {}) => app.request(p, { headers });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  return { key, idp, app, get, bearer };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
}

describe("authentication middleware (D-MSSO-6)", () => {
  it("accepts a valid RS256 token", async () => {
    const t = await setup();
    const res = await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key })));
    expect(res.status).toBe(200);
  });

  it("rejects anonymous requests with 401 and WWW-Authenticate", async () => {
    const t = await setup();
    const res = await t.get("/api/v1/sso");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    await expectError(res, 401, "UNAUTHENTICATED");
  });

  it("protects every non-public /api/v1 route, including unknown paths (deny by default)", async () => {
    const t = await setup();
    for (const p of ["/api/v1/services", "/api/v1/pipelines", "/api/v1/policies", "/api/v1/nope"]) {
      expect((await t.get(p)).status, p).toBe(401);
    }
  });

  it("keeps health, openapi.json and docs public", async () => {
    const t = await setup();
    for (const p of ["/api/v1/health", "/api/v1/openapi.json", "/api/v1/docs"]) {
      expect((await t.get(p)).status, p).toBe(200);
    }
  });

  it("answers CORS preflight without a token", async () => {
    const t = await setup();
    const res = await t.app.request("/api/v1/sso", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5180", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expect(res.status).toBe(204);
  });

  it("ignores cookies and forwarded identity headers (bearer only)", async () => {
    const t = await setup();
    const token = await signToken({ key: t.key });
    const res = await t.get("/api/v1/sso", {
      Cookie: `access_token=${token}; session=${token}`,
      "X-Forwarded-User": "alice",
      "X-Forwarded-Groups": "admins",
      "X-Auth-Request-Access-Token": token,
    });
    await expectError(res, 401, "UNAUTHENTICATED");
  });

  it("rejects non-Bearer schemes and malformed headers", async () => {
    const t = await setup();
    const token = await signToken({ key: t.key });
    for (const h of [`Basic ${token}`, token, "Bearer", "Bearer a b", "Bearer "]) {
      const res = await t.get("/api/v1/sso", { Authorization: h });
      expect(res.status, h).toBe(401);
    }
  });

  it("rejects an expired token but tolerates 30 s of skew", async () => {
    const t = await setup();
    await expectError(await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, exp: -120 }))), 401, "UNAUTHENTICATED");
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, exp: -10 })))).status).toBe(200);
  });

  it("rejects nbf in the future beyond skew, accepts within skew", async () => {
    const t = await setup();
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, nbf: 120 })))).status).toBe(401);
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, nbf: 10 })))).status).toBe(200);
  });

  it("requires exp and sub", async () => {
    const t = await setup();
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, exp: null })))).status).toBe(401);
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, sub: null })))).status).toBe(401);
  });

  it("accepts only access tokens: typ must be 'Bearer' (ID/Refresh/missing rejected)", async () => {
    const t = await setup();
    for (const typ of ["ID", "Refresh", "Offline", "bearer", "", 1, null]) {
      const token = await signToken({ key: t.key, claims: { typ } });
      expect((await t.get("/api/v1/sso", t.bearer(token))).status, String(typ)).toBe(401);
    }
    const noTyp = await signToken({ key: t.key, claims: { typ: undefined } });
    expect((await t.get("/api/v1/sso", t.bearer(noTyp))).status).toBe(401);
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key })))).status).toBe(200);
  });

  it("accepts a lowercase or mixed-case bearer scheme (RFC 7235 is case-insensitive)", async () => {
    const t = await setup();
    const token = await signToken({ key: t.key });
    for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
      expect((await t.get("/api/v1/sso", { Authorization: `${scheme} ${token}` })).status, scheme).toBe(200);
    }
  });

  it("rejects multiple Authorization headers", async () => {
    const t = await setup();
    const token = await signToken({ key: t.key });
    const headers = new Headers();
    headers.append("Authorization", `Bearer ${token}`);
    headers.append("Authorization", `Bearer ${token}`);
    expect((await t.app.request("/api/v1/sso", { headers })).status).toBe(401);
  });

  it("never serves protected data on path-confusion variants without a token", async () => {
    const t = await setup();
    for (const p of ["//api/v1/sso", "/api//v1/sso", "/api/v1//sso", "/api/v1/sso/", "/API/v1/sso", "/api/v1/./sso", "/api/v1/health/../sso", "/api/v1/%73so"]) {
      const res = await t.get(p);
      expect([401, 404, 307], p).toContain(res.status);
      expect(await res.text(), p).not.toContain("realm");
    }
  });

  it("requires an exact issuer", async () => {
    const t = await setup();
    for (const iss of ["https://evil.example/realms/beluga", `${ISSUER}/`, ISSUER.replace("beluga", "other")]) {
      expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, iss })))).status, iss).toBe(401);
    }
  });

  it("requires aud to contain the configured audience (azp alone is not enough)", async () => {
    const t = await setup();
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, aud: "account" })))).status).toBe(401);
    expect(
      (await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, aud: "account", claims: { azp: AUDIENCE } })))).status,
    ).toBe(401);
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key, aud: ["account", AUDIENCE] })))).status).toBe(200);
  });

  it("rejects alg none", async () => {
    const t = await setup();
    await expectError(await t.get("/api/v1/sso", t.bearer(unsignedToken(t.key.kid))), 401, "UNAUTHENTICATED");
  });

  it("rejects HS256 signed with the public key material (key confusion)", async () => {
    const t = await setup();
    await expectError(await t.get("/api/v1/sso", t.bearer(await hs256Token(t.key))), 401, "UNAUTHENTICATED");
  });

  it("rejects a token signed by a different key with the same kid", async () => {
    const t = await setup();
    const rogue = await makeKey("k1");
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: rogue })))).status).toBe(401);
  });

  it("rejects garbage and oversized tokens", async () => {
    const t = await setup();
    expect((await t.get("/api/v1/sso", t.bearer("not.a.jwt"))).status).toBe(401);
    expect((await t.get("/api/v1/sso", t.bearer("a".repeat(9000)))).status).toBe(401);
  });

  it("refetches the JWKS on an unknown kid (key rotation)", async () => {
    const t = await setup();
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key })))).status).toBe(200);
    const rotated = await makeKey("k2");
    t.idp.publish([t.key, rotated]);
    const before = t.idp.calls();
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: rotated })))).status).toBe(200);
    expect(t.idp.calls()).toBe(before + 1);
  });

  it("rate-limits kid-miss refetches (cooldown) and rejects the unknown kid", async () => {
    const t = await setup({ cooldownMs: 60_000 });
    expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key })))).status).toBe(200);
    const unknown = await makeKey("ghost");
    const before = t.idp.calls();
    for (let i = 0; i < 5; i++) {
      expect((await t.get("/api/v1/sso", t.bearer(await signToken({ key: unknown })))).status).toBe(401);
    }
    expect(t.idp.calls()).toBe(before); // within cooldown: no stampede on the IdP
  });

  it("answers 503 (never allow, never 401) when the JWKS is unreachable", async () => {
    const t = await setup();
    t.idp.fail("reject");
    await expectError(await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key }))), 503, "SERVICE_UNAVAILABLE");
  });

  it("answers 503 when the JWKS endpoint returns an HTTP error", async () => {
    const t = await setup();
    t.idp.fail(500);
    await expectError(await t.get("/api/v1/sso", t.bearer(await signToken({ key: t.key }))), 503, "SERVICE_UNAVAILABLE");
  });

  it("gives no oracle: expired, forged and wrong-audience tokens get the identical body", async () => {
    const t = await setup();
    const rogue = await makeKey("k1");
    const bodies = new Set<string>();
    for (const token of [
      await signToken({ key: t.key, exp: -120 }),
      await signToken({ key: rogue }),
      await signToken({ key: t.key, aud: "other" }),
    ]) {
      bodies.add(JSON.stringify(await (await t.get("/api/v1/sso", t.bearer(token))).json()));
    }
    expect(bodies.size).toBe(1);
  });

  it("documents the bearer scheme in OpenAPI and exempts health", async () => {
    const t = await setup();
    const doc = (await (await t.get("/api/v1/openapi.json")).json()) as {
      components: { securitySchemes: Record<string, unknown> };
      security: unknown[];
      paths: Record<string, { get: { security?: unknown[] } }>;
    };
    expect(doc.components.securitySchemes["bearerAuth"]).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/api/v1/health"]?.get.security).toEqual([]);
  });
});

describe("normalizeGroups (D-MSSO-7)", () => {
  it("strips the leading slash and dedupes", () => {
    expect(normalizeGroups(["/admins", "engineers", "/admins"])).toEqual(["admins", "engineers"]);
  });
  it("drops sub-group paths so '/x/admins' can never become 'admins'", () => {
    expect(normalizeGroups(["/x/admins", "x/admins", "//admins", "/admins/"])).toEqual([]);
  });
  it("treats wrong types as no groups", () => {
    for (const bad of [undefined, null, "admins", 7, {}, [1, null, {}], [""], ["/"]]) {
      expect(normalizeGroups(bad)).toEqual([]);
    }
  });
});
