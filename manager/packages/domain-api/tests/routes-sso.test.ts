import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSsoAdapter, SsoConfigError, type SsoAdapter } from "../src/adapters/sso/ssoAdapter.js";
import { createApp } from "../src/app.js";
import { errorResponseSchema } from "../src/schema/envelope.js";
import { ssoResponseSchema } from "../src/schema/sso.js";

const FIXTURE_PATH = path.resolve(__dirname, "fixtures/sso.yaml");

describe("SSO Routes (GET /api/v1/sso)", () => {
  it("returns 200 with configured response when SSO configuration is valid", async () => {
    const ssoAdapter = createFileSsoAdapter({
      filePath: FIXTURE_PATH,
      isProduction: false,
    });
    const app = createApp(undefined, undefined, undefined, undefined, ssoAdapter);

    const res = await app.request("/api/v1/sso");
    expect(res.status).toBe(200);

    const json = await res.json();
    const parsed = ssoResponseSchema.parse(json);
    expect(parsed.status).toBe("configured");
    expect(parsed.configured).toBe(true);

    if (parsed.status === "configured") {
      expect(parsed.config.realm).toBe("beluga");
      expect(parsed.config.endpoints.length).toBe(3);
    }
  });

  it("returns 200 with not-configured state when configuration is absent", async () => {
    const ssoAdapter = createFileSsoAdapter({
      filePath: undefined,
      isProduction: true,
    });
    const app = createApp(undefined, undefined, undefined, undefined, ssoAdapter);

    const res = await app.request("/api/v1/sso");
    expect(res.status).toBe(200);

    const json = await res.json();
    const parsed = ssoResponseSchema.parse(json);
    expect(parsed.status).toBe("not-configured");
    expect(parsed.configured).toBe(false);
  });

  it("returns 503 Service Unavailable when configuration is malformed", async () => {
    const mockErrorAdapter: SsoAdapter = {
      getSsoConfig() {
        throw new SsoConfigError("Invalid SSO configuration: invalid-mode");
      },
    };
    const app = createApp(undefined, undefined, undefined, undefined, mockErrorAdapter);

    const res = await app.request("/api/v1/sso");
    expect(res.status).toBe(503);

    const json = await res.json();
    const parsed = errorResponseSchema.parse(json);
    expect(parsed.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(parsed.error.message).toContain("Invalid SSO configuration");
  });

  it("redirects /api/v1/sso/config alias to /api/v1/sso", async () => {
    const ssoAdapter = createFileSsoAdapter({
      filePath: FIXTURE_PATH,
      isProduction: false,
    });
    const app = createApp(undefined, undefined, undefined, undefined, ssoAdapter);

    const res = await app.request("/api/v1/sso/config");
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/api/v1/sso");
  });
});
