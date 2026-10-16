import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileSsoAdapter,
  SsoConfigError,
} from "../src/adapters/sso/ssoAdapter.js";
import { resolveDefaultSsoConfigPath } from "../src/config.js";
import { rawSsoFileSchema, ssoConfigSchema } from "../src/schema/sso.js";
import yaml from "yaml";

const FIXTURE_PATH = path.resolve(__dirname, "fixtures/sso.yaml");

describe("SsoAdapter", () => {
  it("happy path: reads and validates fixture sso.yaml", () => {
    const adapter = createFileSsoAdapter({
      filePath: FIXTURE_PATH,
      isProduction: false,
    });
    const result = adapter.getSsoConfig();

    expect(result.status).toBe("configured");
    expect(result.configured).toBe(true);
    if (result.status === "configured") {
      expect(result.source.kind).toBe("git-file");
      expect(result.source.path).toBe(FIXTURE_PATH);
      expect(result.config.realm).toBe("beluga");
      expect(result.config.issuerHost).toBe("sso.local.beluga.internal");
      expect(result.config.issuer).toBe("https://sso.local.beluga.internal/realms/beluga");
      expect(result.config.endpoints).toHaveLength(3);

      const flink = result.config.endpoints.find((e) => e.name === "flink");
      expect(flink).toBeDefined();
      expect(flink?.mode).toBe("gateway-oidc");
      expect(flink?.clientId).toBe("apisix-gateway");
      expect(flink?.redirectPath).toBe("/.apisix/redirect");
      expect(flink?.logoutPath).toBe("/logout");
    }
  });

  it("mtime cache: returns cached result on unchanged mtime", () => {
    const adapter = createFileSsoAdapter({
      filePath: FIXTURE_PATH,
      isProduction: false,
    });
    const result1 = adapter.getSsoConfig();
    const result2 = adapter.getSsoConfig();
    expect(result1).toBe(result2); // Exact same object reference from cache
  });

  it("rejects unknown mode with SsoConfigError", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-invalid-mode.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "custom-auth-mode"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-https issuer with SsoConfigError", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-insecure-issuer.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "http://sso.local.beluga.internal/realms/beluga"
  endpoints: []
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects host that is not a valid DNS name", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-bad-host.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "bad_host_with_underscores"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects paths not starting with /", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-bad-path.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["relative/path"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("missing file returns typed not-configured state", () => {
    const adapter = createFileSsoAdapter({
      filePath: "/non/existent/path/sso.yaml",
      isProduction: false,
    });
    const result = adapter.getSsoConfig();
    expect(result.status).toBe("not-configured");
    expect(result.configured).toBe(false);
    if (result.status === "not-configured") {
      expect(result.message).toContain("not found");
    }
  });

  it("production with no file set returns typed not-configured state", () => {
    const adapter = createFileSsoAdapter({
      filePath: undefined,
      isProduction: true,
    });
    const result = adapter.getSsoConfig();
    expect(result.status).toBe("not-configured");
    expect(result.configured).toBe(false);
    if (result.status === "not-configured") {
      expect(result.message).toContain("unset in production");
    }
  });

  it("malformed YAML throws SsoConfigError", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-malformed.yaml");
    fs.writeFileSync(tmpFile, "sso:\n  realm: [unclosed array\n   bad: ::::");

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // L1: Requires 'sso:' wrapper
  it("rejects YAML missing top-level sso wrapper with SsoConfigError", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-unwrapped.yaml");
    fs.writeFileSync(
      tmpFile,
      `
realm: "beluga"
issuerHost: "sso.local.beluga.internal"
issuer: "https://sso.local.beluga.internal/realms/beluga"
endpoints: []
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(SsoConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // M2: Cross-validation tests
  it("rejects gateway-oidc with empty clientId", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-empty-clientid.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "   "
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
      logoutPath: "/logout"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/must have a non-empty clientId/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects app-oidc with empty clientId", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-app-empty-clientid.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: argocd
      host: "argocd.local.beluga.internal"
      mode: "app-oidc"
      clientId: ""
      protectedPathPrefixes: ["/"]
      bypassPathPrefixes: []
      redirectPath: "/auth/callback"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/must have a non-empty clientId/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects gateway-oidc with empty protectedPathPrefixes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-empty-prefixes.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: []
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
      logoutPath: "/logout"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/must have non-empty protectedPathPrefixes/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects gateway-oidc with missing or empty redirectPath", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-empty-redirect.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: ""
      logoutPath: "/logout"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/must have a non-empty redirectPath/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects gateway-oidc with missing or empty logoutPath", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-empty-logout.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/must have a non-empty logoutPath/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects issuer host mismatch with issuerHost", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-issuer-host-mismatch.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://other.local.beluga.internal/realms/beluga"
  endpoints: []
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/does not match issuerHost/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects issuer path that does not match /realms/<realm>", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-issuer-path-mismatch.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/auth/realms/other-realm"
  endpoints: []
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/does not match expected path/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate endpoint names", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-duplicate-name.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: flink
      host: "flink.local.beluga.internal"
      mode: "none"
      clientId: ""
      protectedPathPrefixes: []
      bypassPathPrefixes: []
      redirectPath: ""
    - name: flink
      host: "flink-alt.local.beluga.internal"
      mode: "none"
      clientId: ""
      protectedPathPrefixes: []
      bypassPathPrefixes: []
      redirectPath: ""
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      expect(() => adapter.getSsoConfig()).toThrow(/Duplicate endpoint name "flink"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows same host with distinct endpoint names without warning or error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
    const tmpFile = path.join(tmpDir, "sso-shared-host.yaml");
    fs.writeFileSync(
      tmpFile,
      `
sso:
  realm: "beluga"
  issuerHost: "sso.local.beluga.internal"
  issuer: "https://sso.local.beluga.internal/realms/beluga"
  endpoints:
    - name: catalog-ui
      host: "catalog.local.beluga.internal"
      mode: "gateway-oidc"
      clientId: "apisix-gateway"
      protectedPathPrefixes: ["/*"]
      bypassPathPrefixes: []
      redirectPath: "/.apisix/redirect"
      logoutPath: "/logout"
    - name: catalog-api
      host: "catalog.local.beluga.internal"
      mode: "none"
      clientId: ""
      protectedPathPrefixes: []
      bypassPathPrefixes: ["/v1/*"]
      redirectPath: ""
`,
    );

    try {
      const adapter = createFileSsoAdapter({ filePath: tmpFile, isProduction: false });
      const result = adapter.getSsoConfig();
      expect(result.status).toBe("configured");
      if (result.status === "configured") {
        expect(result.config.endpoints).toHaveLength(2);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // M3: strict() rejects unknown keys
  it("strict mode: rejects unknown keys at top level, in sso, and in endpoints", () => {
    const rawWithExtraRoot = {
      sso: {
        realm: "beluga",
        issuerHost: "sso.local.beluga.internal",
        issuer: "https://sso.local.beluga.internal/realms/beluga",
        endpoints: [],
      },
      unknownRootKey: "unexpected",
    };
    expect(rawSsoFileSchema.safeParse(rawWithExtraRoot).success).toBe(false);

    const rawWithExtraSsoKey = {
      sso: {
        realm: "beluga",
        issuerHost: "sso.local.beluga.internal",
        issuer: "https://sso.local.beluga.internal/realms/beluga",
        endpoints: [],
        unknownSsoKey: "unexpected",
      },
    };
    expect(rawSsoFileSchema.safeParse(rawWithExtraSsoKey).success).toBe(false);

    const rawWithExtraEndpointKey = {
      sso: {
        realm: "beluga",
        issuerHost: "sso.local.beluga.internal",
        issuer: "https://sso.local.beluga.internal/realms/beluga",
        endpoints: [
          {
            name: "flink",
            host: "flink.local.beluga.internal",
            mode: "none",
            clientId: "",
            protectedPathPrefixes: [],
            bypassPathPrefixes: [],
            redirectPath: "",
            extraField: 123,
          },
        ],
      },
    };
    expect(rawSsoFileSchema.safeParse(rawWithExtraEndpointKey).success).toBe(false);
  });

  // L2 & M3 Drift guard: verifies that the actual gitops/values/sso.yaml in the repository
  // strictly validates against the manager's Zod schema using a fixed path.
  it("drift guard: real gitops/values/sso.yaml in repo satisfies domain contract via fixed path", () => {
    const realPath = path.resolve(__dirname, "../../../../gitops/values/sso.yaml");
    expect(fs.existsSync(realPath)).toBe(true);

    const content = fs.readFileSync(realPath, "utf-8");
    const raw = yaml.parse(content);
    const parsed = rawSsoFileSchema.parse(raw);

    expect(parsed.sso.realm).toBe("beluga");
    expect(parsed.sso.issuer).toBe("https://sso.local.beluga.internal/realms/beluga");
    expect(parsed.sso.issuerHost).toBe("sso.local.beluga.internal");
    expect(parsed.sso.endpoints.length).toBeGreaterThan(0);

    // Verify key expected services from gitops/values/sso.yaml
    const names = parsed.sso.endpoints.map((e) => e.name);
    expect(names).toContain("flink");
    expect(names).toContain("argocd");
    expect(names).toContain("catalog-ui");
    expect(names).toContain("catalog-api");
    expect(names).toContain("trino");
    expect(names).toContain("superset");
    expect(names).toContain("airflow");
  });
});
