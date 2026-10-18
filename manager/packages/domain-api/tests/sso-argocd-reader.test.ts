import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArgocdError, ArgocdReader, type KubeRequest, type KubeRequester } from "../src/sso-change/argocdReader.js";
import { ConfigError, loadGithubAppConfig, loadKubeApiConfig, loadReconcileIntervalMs } from "../src/config.js";

let dir: string;
let tokenFile: string;
let caFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argocd-reader-"));
  tokenFile = path.join(dir, "token");
  caFile = path.join(dir, "ca.crt");
  fs.writeFileSync(tokenFile, "tok-1\n");
  fs.writeFileSync(caFile, "CA-PEM");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = (sync: unknown) => JSON.stringify({ status: { sync } });
function reader(requester: KubeRequester) {
  return new ArgocdReader({ apiUrl: "https://kubernetes.default.svc", tokenFile, caFile, requester });
}

describe("ArgocdReader (D-MSSO-16)", () => {
  it("GETs the Application through the Kubernetes API with the SA token and the cluster CA", async () => {
    let seen: KubeRequest | undefined;
    const r = reader(async (req) => {
      seen = req;
      return { status: 200, body: app({ status: "Synced", revision: "abc" }) };
    });
    expect(await r.getApplication("beluga-platform")).toEqual({ name: "beluga-platform", syncStatus: "Synced", revision: "abc" });
    expect(seen!.url.href).toBe("https://kubernetes.default.svc/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/beluga-platform");
    expect(seen!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(seen!.ca).toBe("CA-PEM");
  });

  it("re-reads the token file on every call (projected tokens rotate)", async () => {
    const tokens: string[] = [];
    const r = reader(async (req) => {
      tokens.push(req.headers["Authorization"]!);
      return { status: 200, body: app({ status: "Synced" }) };
    });
    await r.getApplication("beluga-data");
    fs.writeFileSync(tokenFile, "tok-2\n");
    await r.getApplication("beluga-data");
    expect(tokens).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("refuses any Application other than the two it may read, without a request", async () => {
    let calls = 0;
    const r = reader(async () => {
      calls++;
      return { status: 200, body: "{}" };
    });
    await expect(r.getApplication("argocd-self")).rejects.toBeInstanceOf(ArgocdError);
    await expect(r.getApplication("../secrets")).rejects.toBeInstanceOf(ArgocdError);
    expect(calls).toBe(0);
  });

  it("errors (never a verdict) for missing files, non-200, malformed JSON, missing sync status, transport and timeout", async () => {
    const ok = async () => ({ status: 200, body: app({ status: "Synced" }) });
    fs.rmSync(tokenFile);
    await expect(reader(ok).getApplication("beluga-data")).rejects.toThrow("not readable");
    fs.writeFileSync(tokenFile, "tok");
    await expect(reader(async () => ({ status: 403, body: "{}" })).getApplication("beluga-data")).rejects.toThrow("http-403");
    await expect(reader(async () => ({ status: 200, body: "<html>" })).getApplication("beluga-data")).rejects.toThrow("malformed");
    await expect(reader(async () => ({ status: 200, body: "{}" })).getApplication("beluga-data")).rejects.toThrow("no sync status");
    await expect(
      reader(async () => {
        throw new Error("ECONNREFUSED 10.0.0.1");
      }).getApplication("beluga-data"),
    ).rejects.toThrow(/^unreachable$/);
    await expect(
      reader(async () => {
        throw new Error("timeout");
      }).getApplication("beluga-data"),
    ).rejects.toThrow(/^timeout$/);
  });

  it("the default requester speaks HTTP, sends the headers and times out", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url!.endsWith("/beluga-data")) return; // hang
      res.setHeader("content-type", "application/json");
      res.end(app({ status: "OutOfSync", revision: "r1" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const r = new ArgocdReader({ apiUrl: `http://127.0.0.1:${port}`, tokenFile, caFile, timeoutMs: 200 });
      expect(await r.getApplication("beluga-platform")).toEqual({ name: "beluga-platform", syncStatus: "OutOfSync", revision: "r1" });
      expect(seen[0]!["authorization"]).toBe("Bearer tok-1");
      await expect(r.getApplication("beluga-data")).rejects.toThrow("timeout");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("config loaders (D-MSSO-15/16/18)", () => {
  it("GitHub App: wired only with two digit ids and a key path; values are never an error", () => {
    expect(loadGithubAppConfig({})).toBeUndefined();
    expect(loadGithubAppConfig({ GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "34" })).toBeUndefined();
    expect(loadGithubAppConfig({ GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "x4", GITHUB_APP_PRIVATE_KEY_FILE: "/k" })).toBeUndefined();
    expect(loadGithubAppConfig({ GITHUB_APP_ID: "", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: "/k" })).toBeUndefined();
    expect(loadGithubAppConfig({ GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: "/k" })).toEqual({
      appId: "12",
      installationId: "34",
      privateKeyFile: "/k",
    });
  });

  it("Kube API: all three or none; https bare origin only", () => {
    expect(loadKubeApiConfig({})).toBeUndefined();
    expect(loadKubeApiConfig({ KUBE_API_URL: "https://kubernetes.default.svc", KUBE_API_TOKEN_FILE: "/t" })).toBeUndefined();
    const full = { KUBE_API_TOKEN_FILE: "/t", KUBE_API_CA_FILE: "/c" };
    expect(loadKubeApiConfig({ ...full, KUBE_API_URL: "https://kubernetes.default.svc" })).toEqual({
      apiUrl: "https://kubernetes.default.svc",
      tokenFile: "/t",
      caFile: "/c",
    });
    for (const bad of ["http://kubernetes.default.svc", "https://u:p@kubernetes.default.svc", "https://k/api", "nonsense"]) {
      expect(() => loadKubeApiConfig({ ...full, KUBE_API_URL: bad }), bad).toThrow(ConfigError);
    }
  });

  it("reconcile interval: default 30 s, minimum 5 s", () => {
    expect(loadReconcileIntervalMs({})).toBe(30_000);
    expect(loadReconcileIntervalMs({ SSO_RECONCILE_INTERVAL_MS: "5000" })).toBe(5000);
    expect(() => loadReconcileIntervalMs({ SSO_RECONCILE_INTERVAL_MS: "4999" })).toThrow(ConfigError);
    expect(() => loadReconcileIntervalMs({ SSO_RECONCILE_INTERVAL_MS: "abc" })).toThrow(ConfigError);
  });
});
