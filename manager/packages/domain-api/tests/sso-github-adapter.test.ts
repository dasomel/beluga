import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GithubSsoAdapter } from "../src/adapters/sso/githubSsoAdapter.js";
import { createSsoAdapterFromEnv, SsoConfigError } from "../src/adapters/sso/ssoAdapter.js";
import { createApp } from "../src/app.js";
import { ConfigError } from "../src/config.js";
import { ssoResponseSchema } from "../src/schema/sso.js";

const YAML_TEXT = fs.readFileSync(path.resolve(__dirname, "fixtures/sso.yaml"), "utf-8");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BLOB_A = "1".repeat(40);
const BLOB_B = "2".repeat(40);
const FILE = "gitops/values/sso.yaml";

interface Request {
  url: URL;
  headers: Record<string, string>;
  init: RequestInit;
}

// Scriptable fake of the two GitHub endpoints the adapter uses. `head`/`file` are replaced between calls.
function fakeGithub() {
  const state = {
    commit: SHA_A,
    blob: BLOB_A,
    yaml: YAML_TEXT,
    etag: '"etag-a"',
    headFailure: null as null | "reject" | { status: number; headers?: Record<string, string> },
    fileFailure: null as null | "reject" | { status: number },
    requests: [] as Request[],
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = { ...(init?.headers as Record<string, string>) };
    state.requests.push({ url, headers, init: init ?? {} });
    if (url.pathname === "/repos/dasomel/beluga/commits/main") {
      if (state.headFailure === "reject") throw new TypeError("fetch failed");
      if (state.headFailure) return new Response("x", state.headFailure);
      if (headers["If-None-Match"] === state.etag) return new Response(null, { status: 304 });
      return new Response(state.commit, { status: 200, headers: { etag: state.etag } });
    }
    if (url.pathname === `/repos/dasomel/beluga/contents/${FILE}`) {
      if (state.fileFailure === "reject") throw new TypeError("fetch failed");
      if (state.fileFailure) return new Response("x", state.fileFailure);
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          path: FILE,
          sha: state.blob,
          content: Buffer.from(state.yaml).toString("base64").replace(/(.{60})/g, "$1\n"),
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const paths = () => state.requests.map((r) => r.url.pathname.replace("/repos/dasomel/beluga", ""));
  return { state, fetchImpl, paths };
}

function setup(opts: { ttlMs?: number; staleMaxMs?: number } = {}) {
  const gh = fakeGithub();
  let now = Date.parse("2026-10-17T00:00:00Z");
  const adapter = new GithubSsoAdapter({ fetchImpl: gh.fetchImpl, now: () => now, ttlMs: 60_000, staleMaxMs: 600_000, ...opts });
  return { gh, adapter, advance: (ms: number) => (now += ms), now: () => now };
}

describe("GithubSsoAdapter (D-MSSO-12)", () => {
  it("reads the blob and commit SHA of main and reports the source", async () => {
    const t = setup();
    const res = ssoResponseSchema.parse(await t.adapter.getSsoConfig());
    expect(res.status).toBe("configured");
    if (res.status !== "configured") return;
    expect(res.source).toEqual({
      kind: "github",
      repo: "dasomel/beluga",
      path: FILE,
      ref: "main",
      commitSha: SHA_A,
      blobSha: BLOB_A,
      fetchedAt: "2026-10-17T00:00:00.000Z",
      loadedAt: "2026-10-17T00:00:00.000Z",
      stale: false,
    });
    expect(res.config.realm).toBe("beluga");
    expect(res.config.endpoints.length).toBe(3);
  });

  it("reads the file at the resolved commit SHA (no torn read) and sends no credentials", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    expect(t.gh.paths()).toEqual(["/commits/main", `/contents/${FILE}`]);
    const contents = t.gh.state.requests[1]!;
    expect(contents.url.searchParams.get("ref")).toBe(SHA_A);
    for (const r of t.gh.state.requests) {
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(r.init.redirect).toBe("error");
      expect(r.init.method).toBe("GET");
      expect(r.url.origin).toBe("https://api.github.com");
    }
  });

  it("serves from cache within the TTL without calling GitHub", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.advance(59_000);
    await t.adapter.getSsoConfig();
    expect(t.gh.state.requests.length).toBe(2);
  });

  it("revalidates with If-None-Match after the TTL and reuses the cached value on 304", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.advance(61_000);
    const res = await t.adapter.getSsoConfig();
    expect(t.gh.paths()).toEqual(["/commits/main", `/contents/${FILE}`, "/commits/main"]);
    expect(t.gh.state.requests[2]!.headers["If-None-Match"]).toBe('"etag-a"');
    expect(res).toMatchObject({ source: { commitSha: SHA_A, blobSha: BLOB_A, stale: false, fetchedAt: "2026-10-17T00:01:01.000Z" } });
  });

  it("re-reads the file when main moved", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.commit = SHA_B;
    t.gh.state.blob = BLOB_B;
    t.gh.state.etag = '"etag-b"';
    t.advance(61_000);
    const res = await t.adapter.getSsoConfig();
    expect(res).toMatchObject({ source: { commitSha: SHA_B, blobSha: BLOB_B, stale: false } });
    expect(t.gh.state.requests[3]!.url.searchParams.get("ref")).toBe(SHA_B);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    const t = setup();
    await Promise.all([t.adapter.getSsoConfig(), t.adapter.getSsoConfig(), t.adapter.getSsoConfig()]);
    expect(t.gh.state.requests.length).toBe(2);
  });

  it("rate limit (403 + remaining 0) without a previous value -> SsoConfigError", async () => {
    const t = setup();
    t.gh.state.headFailure = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/rate-limited/);
    await expect(t.adapter.getSsoConfig()).rejects.toBeInstanceOf(SsoConfigError);
  });

  it("rate limit with a previous value -> last good value marked stale", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.headFailure = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    t.advance(61_000);
    const res = ssoResponseSchema.parse(await t.adapter.getSsoConfig());
    expect(res).toMatchObject({ source: { commitSha: SHA_A, stale: true, staleReason: "rate-limited", fetchedAt: "2026-10-17T00:00:00.000Z" } });
  });

  it("serves stale only inside the bounded window, then 503-class error", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.headFailure = "reject";
    t.advance(300_000);
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: true, staleReason: "unreachable" } });
    t.advance(301_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/unavailable/);
  });

  it("recovers (stale -> fresh) once GitHub answers again", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.headFailure = { status: 502 };
    t.advance(61_000);
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: true, staleReason: "http-502" } });
    t.gh.state.headFailure = null;
    t.advance(1_000);
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: true } }); // still backing off
    t.advance(60_000);
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: false } });
  });

  it("treats a 403 without exhausted quota as a generic failure, not rate-limit", async () => {
    const t = setup();
    t.gh.state.headFailure = { status: 403 };
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/http-403/);
  });

  it("network failure on the contents call -> error (no previous value)", async () => {
    const t = setup();
    t.gh.state.fileFailure = "reject";
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/unreachable/);
  });

  it("schema violation on main is a 503-class error even with a previous good value (never masked as stale)", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.commit = SHA_B;
    t.gh.state.etag = '"etag-b"';
    t.gh.state.yaml = YAML_TEXT.replace('mode: "gateway-oidc"', 'mode: "bogus"');
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/);
  });

  it("malformed YAML and non-object content are SsoConfigError", async () => {
    const t = setup();
    t.gh.state.yaml = "sso: [unclosed";
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Malformed YAML/);
  });

  it("rejects a malformed commit SHA and an unexpected contents shape", async () => {
    const a = setup();
    a.gh.state.commit = "main";
    await expect(a.adapter.getSsoConfig()).rejects.toThrow(/malformed commit SHA/);

    const b = setup();
    const inner = b.gh.fetchImpl;
    const adapter = new GithubSsoAdapter({
      now: b.now,
      fetchImpl: (async (input, init) => {
        const res = await inner(input, init);
        return String(input).includes("/contents/")
          ? new Response(JSON.stringify({ type: "dir", entries: [] }), { status: 200 })
          : res;
      }) as typeof fetch,
    });
    await expect(adapter.getSsoConfig()).rejects.toThrow(/not the expected file/);
  });

  it("times out a hanging GitHub call", async () => {
    const adapter = new GithubSsoAdapter({
      timeoutMs: 20,
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch,
    });
    await expect(adapter.getSsoConfig()).rejects.toThrow(/timeout/);
  });

  it("refuses an oversized response body", async () => {
    const adapter = new GithubSsoAdapter({
      fetchImpl: (async () => new Response("a".repeat(2 * 1024 * 1024), { status: 200 })) as typeof fetch,
    });
    await expect(adapter.getSsoConfig()).rejects.toThrow(/too large/);
  });
});

describe("GET /api/v1/sso with the GitHub adapter", () => {
  it("returns 200 with the github source", async () => {
    const t = setup();
    const app = createApp(undefined, undefined, undefined, undefined, t.adapter);
    const res = await app.request("/api/v1/sso");
    expect(res.status).toBe(200);
    expect(ssoResponseSchema.parse(await res.json())).toMatchObject({ source: { kind: "github", commitSha: SHA_A } });
  });

  it("returns 503 when GitHub is unavailable and nothing is cached", async () => {
    const t = setup();
    t.gh.state.headFailure = "reject";
    const app = createApp(undefined, undefined, undefined, undefined, t.adapter);
    const res = await app.request("/api/v1/sso");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });
});

describe("createSsoAdapterFromEnv (SSO_SOURCE)", () => {
  it("defaults to the file adapter outside production", () => {
    expect(createSsoAdapterFromEnv({}).constructor.name).toBe("FileSsoAdapter");
  });

  it("selects github", () => {
    expect(createSsoAdapterFromEnv({ SSO_SOURCE: "github" }).constructor.name).toBe("GithubSsoAdapter");
  });

  it("has no default in production (no silent fallback to the file adapter)", () => {
    expect(() => createSsoAdapterFromEnv({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(createSsoAdapterFromEnv({ NODE_ENV: "production", SSO_SOURCE: "file", SSO_CONFIG_FILE: "/x" }).constructor.name).toBe("FileSsoAdapter");
  });

  it("rejects unknown values", () => {
    expect(() => createSsoAdapterFromEnv({ SSO_SOURCE: "s3" })).toThrow(ConfigError);
  });

  it("cannot be redirected to another repo or branch through the environment", async () => {
    const calls: string[] = [];
    const adapter = createSsoAdapterFromEnv(
      { SSO_SOURCE: "github", SSO_GITHUB_REPO: "evil/repo", SSO_GITHUB_BRANCH: "evil", SSO_GITHUB_API: "https://evil.example" },
      (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("x", { status: 500 });
      }) as typeof fetch,
    );
    await expect(adapter.getSsoConfig()).rejects.toThrow();
    expect(calls).toEqual(["https://api.github.com/repos/dasomel/beluga/commits/main"]);
  });
});

describe("GithubSsoAdapter backoff and invalid-commit memory (D-MSSO-12b)", () => {
  const HEAD = "/commits/main";

  it("does not call GitHub again after a failure until the TTL has passed", async () => {
    const t = setup();
    t.gh.state.headFailure = { status: 502 };
    for (let i = 0; i < 5; i++) await expect(t.adapter.getSsoConfig()).rejects.toThrow(/http-502/);
    expect(t.gh.state.requests.length).toBe(1);
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow();
    expect(t.gh.state.requests.length).toBe(2);
  });

  it("serves stale during backoff with no GitHub call", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.headFailure = "reject";
    t.advance(61_000);
    for (let i = 0; i < 4; i++) {
      expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: true, staleReason: "unreachable" } });
    }
    expect(t.gh.paths().filter((p) => p === HEAD).length).toBe(2); // initial + one failed refresh
  });

  it("waits for x-ratelimit-reset on a rate-limit answer (longer than the TTL)", async () => {
    const t = setup();
    const resetS = Math.floor(t.now() / 1000) + 1800;
    t.gh.state.headFailure = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetS) } };
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/rate-limited/);
    t.advance(600_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/rate-limited/);
    expect(t.gh.state.requests.length).toBe(1);
    t.advance(1_201_000); // past reset
    t.gh.state.headFailure = null;
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { stale: false } });
  });

  it("ignores a nonsensical x-ratelimit-reset (falls back to the TTL)", async () => {
    const t = setup();
    t.gh.state.headFailure = { status: 429, headers: { "x-ratelimit-reset": "abc", "retry-after": "-5" } };
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/rate-limited/);
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/rate-limited/);
    expect(t.gh.state.requests.length).toBe(2);
  });

  it("keeps answering 503 for a schema-invalid commit without re-downloading it", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.commit = SHA_B;
    t.gh.state.etag = '"etag-b"';
    t.gh.state.yaml = YAML_TEXT.replace('mode: "gateway-oidc"', 'mode: "bogus"');
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/);
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/);
    expect(t.gh.paths().filter((p) => p.startsWith("/contents")).length).toBe(2); // good + invalid once
  });

  it("does not hide an invalid commit behind stale data while rate-limited", async () => {
    const t = setup();
    await t.adapter.getSsoConfig();
    t.gh.state.commit = SHA_B;
    t.gh.state.etag = '"etag-b"';
    t.gh.state.yaml = YAML_TEXT.replace('mode: "gateway-oidc"', 'mode: "bogus"');
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/);
    t.gh.state.headFailure = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    t.advance(61_000);
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/); // not stale-A
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Invalid SSO configuration/); // during backoff too
  });

  it("recovers when main moves past the invalid commit", async () => {
    const t = setup();
    t.gh.state.yaml = "sso: [unclosed";
    await expect(t.adapter.getSsoConfig()).rejects.toThrow(/Malformed YAML/);
    t.gh.state.commit = SHA_B;
    t.gh.state.etag = '"etag-b"';
    t.gh.state.yaml = YAML_TEXT;
    t.advance(61_000);
    expect(await t.adapter.getSsoConfig()).toMatchObject({ source: { commitSha: SHA_B, stale: false } });
  });
});
