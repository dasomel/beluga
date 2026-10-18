import fs from "node:fs";
import http from "node:http";
import https from "node:https";

// D-MSSO-16/17: read-only view of the two ArgoCD Applications through the Kubernetes API (the Manager's own
// ServiceAccount, Role: get on applications beluga-platform and beluga-data only). No ArgoCD account is involved.
// The projected ServiceAccount token rotates (1 h), so the token file is re-read on EVERY call; the cluster CA
// is read per call as well (small file, avoids a stale trust anchor). The token is never logged or returned.

export const ARGOCD_NAMESPACE = "argocd";
export const ARGOCD_APPS = ["beluga-platform", "beluga-data"] as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ArgocdAppStatus {
  name: string;
  /** status.sync.status, e.g. "Synced" / "OutOfSync". */
  syncStatus: string;
  /** status.sync.revision: the commit the Application was last synced to. */
  revision: string | undefined;
}

export interface ArgocdPort {
  getApplication(name: string): Promise<ArgocdAppStatus>;
}

export class ArgocdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgocdError";
  }
}

export interface KubeRequest {
  url: URL;
  headers: Record<string, string>;
  ca: string;
  timeoutMs: number;
}
export type KubeRequester = (request: KubeRequest) => Promise<{ status: number; body: string }>;

// node:https instead of fetch because the cluster CA must be trusted for this one origin only (global fetch has no
// per-request CA and undici is not a dependency of this package). http: is accepted for tests; the config
// loader only allows https.
export const defaultKubeRequester: KubeRequester = ({ url, headers, ca, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "GET", headers, timeout: timeoutMs, ...(url.protocol === "https:" ? { ca } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error("response too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

export interface ArgocdReaderOptions {
  apiUrl: string;
  tokenFile: string;
  caFile: string;
  requester?: KubeRequester;
  timeoutMs?: number;
}

export class ArgocdReader implements ArgocdPort {
  private readonly requester: KubeRequester;
  private readonly timeoutMs: number;

  constructor(private readonly options: ArgocdReaderOptions) {
    this.requester = options.requester ?? defaultKubeRequester;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getApplication(name: string): Promise<ArgocdAppStatus> {
    if (!(ARGOCD_APPS as readonly string[]).includes(name)) throw new ArgocdError("application is not readable");
    let token: string;
    let ca: string;
    try {
      token = fs.readFileSync(this.options.tokenFile, "utf8").trim();
      ca = fs.readFileSync(this.options.caFile, "utf8");
    } catch {
      throw new ArgocdError("service account files are not readable");
    }
    if (token === "") throw new ArgocdError("service account token is empty");

    const url = new URL(`/apis/argoproj.io/v1alpha1/namespaces/${ARGOCD_NAMESPACE}/applications/${encodeURIComponent(name)}`, this.options.apiUrl);
    let reply: { status: number; body: string };
    try {
      reply = await this.requester({ url, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, ca, timeoutMs: this.timeoutMs });
    } catch (error) {
      throw new ArgocdError(error instanceof Error && error.message === "timeout" ? "timeout" : "unreachable");
    }
    if (reply.status !== 200) throw new ArgocdError(`http-${reply.status}`);
    let json: unknown;
    try {
      json = JSON.parse(reply.body);
    } catch {
      throw new ArgocdError("malformed response");
    }
    const sync = (json as { status?: { sync?: { status?: unknown; revision?: unknown } } } | null)?.status?.sync;
    if (typeof sync?.status !== "string") throw new ArgocdError("application has no sync status");
    return { name, syncStatus: sync.status, revision: typeof sync.revision === "string" ? sync.revision : undefined };
  }
}
