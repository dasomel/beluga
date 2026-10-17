import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAuthMiddleware, requireGroup } from "../src/auth/middleware.js";
import { createOidcVerifier } from "../src/auth/oidc.js";
import { fakeIdp, makeKey, OIDC_CONFIG, signToken } from "./helpers/oidc.js";

// D-MSSO-7: no write route exists yet; the gate is exercised on a throwaway route.
async function setup() {
  const key = await makeKey("k1");
  const idp = fakeIdp([key]);
  const verifier = createOidcVerifier(OIDC_CONFIG, { fetchImpl: idp.fetchImpl, jwksCooldownMs: 0 });
  const app = new Hono();
  app.use("/api/*", createAuthMiddleware(verifier));
  app.post("/api/v1/write", requireGroup("admins"), (c) => c.json({ ok: true, who: c.get("principal")?.sub }));
  const call = async (claims: Record<string, unknown> | undefined, opts: { exp?: number } = {}) =>
    app.request("/api/v1/write", {
      method: "POST",
      headers: claims === undefined ? {} : { Authorization: `Bearer ${await signToken({ key, claims, ...opts })}` },
    });
  return { app, call };
}

describe("requireGroup('admins') (D-MSSO-7)", () => {
  it("allows a token whose groups contain /admins (normalized)", async () => {
    const t = await setup();
    const res = await t.call({ groups: ["/engineers", "/admins"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, who: "user-1" });
  });

  it("allows the bare group name form too", async () => {
    expect((await (await setup()).call({ groups: ["admins"] })).status).toBe(200);
  });

  it("denies (403) a member of other groups", async () => {
    const res = await (await setup()).call({ groups: ["/engineers"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("denies when the groups claim is missing, empty, or of the wrong type", async () => {
    const t = await setup();
    for (const groups of [undefined, [], "admins", { 0: "admins" }, [7], null]) {
      expect((await t.call({ groups })).status, JSON.stringify(groups)).toBe(403);
    }
  });

  it("does not accept look-alike group names", async () => {
    const t = await setup();
    for (const g of ["/admins/sub", "/x/admins", "x/admins", "/Admins", "/admins ", "/admin", "//admins"]) {
      expect((await t.call({ groups: [g] })).status, g).toBe(403);
    }
  });

  it("does not take the group from request headers or body", async () => {
    const t = await setup();
    const res = await t.app.request("/api/v1/write", {
      method: "POST",
      headers: { "X-Groups": "admins", "X-Forwarded-Groups": "admins" },
      body: JSON.stringify({ groups: ["admins"] }),
    });
    expect(res.status).toBe(401);
  });

  it("answers 401 for a tampered or expired token, never 403/200", async () => {
    const t = await setup();
    expect((await t.call({ groups: ["/admins"] }, { exp: -120 })).status).toBe(401);
    const key = await makeKey("k1");
    const forged = await signToken({ key, claims: { groups: ["/admins"] } });
    const res = await t.app.request("/api/v1/write", { method: "POST", headers: { Authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
  });

  it("denies when no principal exists (auth disabled / middleware missing)", async () => {
    const app = new Hono();
    app.post("/w", requireGroup("admins"), (c) => c.json({ ok: true }));
    expect((await app.request("/w", { method: "POST" })).status).toBe(401);
  });
});
