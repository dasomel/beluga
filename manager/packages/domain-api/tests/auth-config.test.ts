import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "../src/auth/authConfig.js";
import { ConfigError } from "../src/config.js";
import { createAppFromEnv } from "../src/wiring.js";
import { fakeIdp, ISSUER, makeKey, signToken } from "./helpers/oidc.js";

describe("loadAuthConfig (fail-closed)", () => {
  it("disabled only when written explicitly outside production", () => {
    expect(loadAuthConfig({ AUTH_MODE: "disabled" })).toEqual({ mode: "disabled" });
    expect(loadAuthConfig({ NODE_ENV: "development", AUTH_MODE: "disabled" })).toEqual({ mode: "disabled" });
  });

  it("an unset AUTH_MODE is oidc even when NODE_ENV is unset or non-production", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      expect(() => loadAuthConfig(env)).toThrow(/OIDC_ISSUER is required/);
    }
  });

  it("refuses AUTH_MODE=disabled in production", () => {
    expect(() => loadAuthConfig({ NODE_ENV: "production", AUTH_MODE: "disabled" })).toThrow(ConfigError);
  });

  it("treats an unset AUTH_MODE in production as oidc and then requires the issuer", () => {
    expect(() => loadAuthConfig({ NODE_ENV: "production" })).toThrow(/OIDC_ISSUER is required/);
  });

  it("derives JWKS uri and defaults the audience", () => {
    expect(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER })).toEqual({
      mode: "oidc",
      issuer: ISSUER,
      audience: "beluga-manager",
      jwksUri: `${ISSUER}/protocol/openid-connect/certs`,
    });
    expect(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: "x" })).toMatchObject({ audience: "x" });
  });

  it.each([
    ["bogus mode", { AUTH_MODE: "none" }],
    ["http issuer", { AUTH_MODE: "oidc", OIDC_ISSUER: "http://sso/realms/beluga" }],
    ["trailing slash", { AUTH_MODE: "oidc", OIDC_ISSUER: `${ISSUER}/` }],
    ["credentials", { AUTH_MODE: "oidc", OIDC_ISSUER: "https://u:p@sso/realms/beluga" }],
    ["query", { AUTH_MODE: "oidc", OIDC_ISSUER: `${ISSUER}?x=1` }],
    ["not a url", { AUTH_MODE: "oidc", OIDC_ISSUER: "sso" }],
  ])("rejects %s", (_name, env) => {
    expect(() => loadAuthConfig(env)).toThrow(ConfigError);
  });
});

describe("createAppFromEnv authentication wiring", () => {
  it("refuses to start in production with AUTH_MODE=disabled", () => {
    expect(() => createAppFromEnv({ NODE_ENV: "production", AUTH_MODE: "disabled", SSO_SOURCE: "github" })).toThrow(ConfigError);
  });

  it("refuses to start in production without any auth configuration", () => {
    expect(() => createAppFromEnv({ NODE_ENV: "production", SSO_SOURCE: "github" })).toThrow(ConfigError);
  });

  it("serves unauthenticated requests only with an explicit AUTH_MODE=disabled", async () => {
    expect(() => createAppFromEnv({})).toThrow(ConfigError);
    const { app, authMode } = createAppFromEnv({ AUTH_MODE: "disabled" });
    expect(authMode).toBe("disabled");
    expect((await app.request("/api/v1/services")).status).toBe(200);
  });

  it("enforces oidc end to end when configured", async () => {
    const key = await makeKey("k1");
    const idp = fakeIdp([key]);
    const { app, authMode } = createAppFromEnv({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER }, idp.fetchImpl);
    expect(authMode).toBe("oidc");
    expect((await app.request("/api/v1/services")).status).toBe(401);
    const token = await signToken({ key });
    expect((await app.request("/api/v1/services", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
