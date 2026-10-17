import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileSsoAdapter,
  SsoConfigError,
} from "../src/adapters/sso/ssoAdapter.js";
import { resolveDefaultSsoConfigPath } from "../src/config.js";
import { rawSsoFileSchema, resolveSsoFile, ssoConfigSchema } from "../src/schema/sso.js";
import yaml from "yaml";

const FIXTURE_PATH = path.resolve(__dirname, "fixtures/sso.yaml");
const LABELS_FIXTURE_PATH = path.resolve(__dirname, "fixtures/sso-labels.yaml");

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

  describe("allowedGroups (D-MSSO-14)", () => {
    const base = (endpoint: Record<string, unknown>) => ({
      sso: {
        realm: "beluga",
        issuerHost: "sso.local.beluga.internal",
        issuer: "https://sso.local.beluga.internal/realms/beluga",
        endpoints: [
          {
            name: "flink",
            host: "flink.local.beluga.internal",
            mode: "gateway-oidc",
            clientId: "apisix-gateway",
            protectedPathPrefixes: ["/*"],
            bypassPathPrefixes: [],
            redirectPath: "/.apisix/redirect",
            logoutPath: "/logout",
            ...endpoint,
          },
        ],
      },
    });
    // Semantic rules run on the resolved shape (both file forms), so go through resolveSsoFile.
    const resolve = (raw: unknown) => resolveSsoFile(raw, "local.beluga.internal");
    const messages = (r: ReturnType<typeof resolve>) => (r.ok ? [] : [r.summary]);

    it("accepts a gateway-oidc endpoint with admins included, and without the field", () => {
      expect(resolve(base({ allowedGroups: ["admins", "engineers"] })).ok).toBe(true);
      expect(resolve(base({})).ok).toBe(true);
    });

    it("rejects empty, duplicate, admins-less and badly named lists", () => {
      expect(messages(resolve(base({ allowedGroups: [] })))).toEqual(
        [expect.stringMatching(/must not be empty/)],
      );
      expect(messages(resolve(base({ allowedGroups: ["admins", "admins"] })))).toEqual(
        [expect.stringMatching(/duplicates/)],
      );
      expect(messages(resolve(base({ allowedGroups: ["engineers"] })))).toEqual(
        [expect.stringMatching(/must include "admins"/)],
      );
      expect(resolve(base({ allowedGroups: ["admins", "/engineers"] })).ok).toBe(false);
      expect(resolve(base({ allowedGroups: ["admins", "Engineers"] })).ok).toBe(false);
      expect(resolve(base({ allowedGroups: ["admins", 'x"]=true--'] })).ok).toBe(false);
    });

    it("rejects allowedGroups on non gateway-oidc modes", () => {
      for (const mode of ["app-oidc", "none"]) {
        const r = resolve(base({ mode, allowedGroups: ["admins"] }));
        expect(messages(r)).toEqual([expect.stringMatching(/gateway-oidc only/)]);
      }
    });
  });

  // D-DOM-2/3: two accepted forms, one normalized response.
  describe("legacy FQDN form and label form (D-DOM-2/3)", () => {
    const read = (p: string, baseDomain?: string) => {
      const r = createFileSsoAdapter({ filePath: p, isProduction: false, ...(baseDomain ? { baseDomain } : {}) }).getSsoConfig();
      if (r.status !== "configured") throw new Error("not configured");
      return r.config;
    };

    it("both forms normalize to the same config for the same base domain", () => {
      expect(read(LABELS_FIXTURE_PATH)).toEqual(read(FIXTURE_PATH));
    });

    it("label form follows baseDomain and leaves no other domain behind", () => {
      const cfg = read(LABELS_FIXTURE_PATH, "kakao.beluga.internal");
      expect(cfg.issuerHost).toBe("sso.kakao.beluga.internal");
      expect(cfg.issuer).toBe("https://sso.kakao.beluga.internal/realms/beluga");
      expect(cfg.endpoints.map((e) => e.host)).toEqual([
        "flink.kakao.beluga.internal",
        "argocd.kakao.beluga.internal",
        "s3.kakao.beluga.internal",
      ]);
      expect(JSON.stringify(cfg)).not.toContain("local.beluga.internal");
    });

    it("legacy FQDN form keeps its declared domain whatever baseDomain says", () => {
      const cfg = read(FIXTURE_PATH, "kakao.beluga.internal");
      expect(cfg.issuer).toBe("https://sso.local.beluga.internal/realms/beluga");
      expect(cfg.endpoints[0]?.host).toBe("flink.local.beluga.internal");
    });

    it("label form may still carry an explicit issuer, checked against issuerHost", () => {
      const ok = resolveSsoFile(
        { sso: { realm: "beluga", issuerHost: "sso", issuer: "https://sso.local.beluga.internal/realms/beluga", endpoints: [] } },
        "local.beluga.internal",
      );
      expect(ok.ok).toBe(true);
      const bad = resolveSsoFile(
        { sso: { realm: "beluga", issuerHost: "sso", issuer: "https://other.local.beluga.internal/realms/beluga", endpoints: [] } },
        "local.beluga.internal",
      );
      expect(bad.ok).toBe(false);
    });

    it("rejects an invalid baseDomain", () => {
      for (const bad of ["", "localhost", "bad domain.internal", "-x.internal"]) {
        expect(resolveSsoFile({ sso: { realm: "beluga", issuerHost: "sso", endpoints: [] } }, bad).ok).toBe(false);
      }
    });
  });

  // L2 & M3 Drift guard: verifies that the actual gitops/values/sso.yaml in the repository
  // strictly validates against the manager's Zod schema using a fixed path.
  it("drift guard: real gitops/values/sso.yaml in repo satisfies domain contract via fixed path", () => {
    const realPath = path.resolve(__dirname, "../../../../gitops/values/sso.yaml");
    expect(fs.existsSync(realPath)).toBe(true);

    const content = fs.readFileSync(realPath, "utf-8");
    const raw = yaml.parse(content);
    const parsed = rawSsoFileSchema.parse(raw);

    // Form-agnostic: legacy FQDN file or label file, the served config is the Vagrant domain by default.
    expect(parsed.sso.realm).toBe("beluga");
    expect(parsed.sso.endpoints.length).toBeGreaterThan(0);
    const resolved = resolveSsoFile(raw, "local.beluga.internal");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.issuer).toBe("https://sso.local.beluga.internal/realms/beluga");
      expect(resolved.config.issuerHost).toBe("sso.local.beluga.internal");
      expect(resolved.config.endpoints.every((e) => e.host.endsWith(".local.beluga.internal"))).toBe(true);
    }
    if (!parsed.sso.issuerHost.includes(".")) {
      const kakao = resolveSsoFile(raw, "kakao.beluga.internal");
      expect(kakao.ok && JSON.stringify(kakao.config).includes("local.beluga.internal")).toBe(false);
    }

    // Verify key expected services from gitops/values/sso.yaml
    const names = parsed.sso.endpoints.map((e) => e.name);
    expect(names).toContain("flink");
    expect(names).toContain("argocd");
    expect(names).toContain("catalog-ui");
    expect(names).toContain("catalog-api");
    expect(names).toContain("trino");
    expect(names).toContain("superset");
    expect(names).toContain("airflow");

    // D-MSSO-14 owner decision 2026-10-17: flink and filer admit admins + engineers; catalog-ui stays locked.
    const byName = new Map(parsed.sso.endpoints.map((e) => [e.name, e]));
    expect(byName.get("flink")?.allowedGroups).toEqual(["admins", "engineers"]);
    expect(byName.get("filer")?.allowedGroups).toEqual(["admins", "engineers"]);
    expect(byName.get("catalog-ui")?.allowedGroups).toBeUndefined();
  });
});
