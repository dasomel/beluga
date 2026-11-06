import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { createAuthMiddleware } from "../src/auth/middleware.js";
import type { TokenVerifier } from "../src/auth/oidc.js";

test("GET /api/v1/me returns verified identity with normalized groups", async () => {
  const verifier: TokenVerifier = { verify: async () => ({ sub: "user-1", username: "beluga-admin", groups: ["admins", "engineers"] }) };
  const app = createApp(undefined, undefined, undefined, undefined, undefined, verifier);
  const response = await app.request("/api/v1/me", { headers: { Authorization: "Bearer verified-token" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sub: "user-1", name: "beluga-admin", groups: ["admins", "engineers"] });
});

test("GET /api/v1/me requires a bearer token", async () => {
  const verifier: TokenVerifier = { verify: async () => ({ sub: "user-1", groups: [] }) };
  const app = createApp(undefined, undefined, undefined, undefined, undefined, verifier);
  const response = await app.request("/api/v1/me");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
});
