import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class KubeError extends Error {}
export interface KubeClientOptions {
  apiUrl: string;
  tokenFile: string;
  caFile: string;
  requester?: KubeRequester;
  timeoutMs?: number;
}
export interface KubeReadPort {
  getJson<T>(path: string): Promise<T>;
  getText(path: string): Promise<string>;
}

export interface KubeRequest {
  url: URL;
  headers: Record<string, string>;
  ca: string;
  timeoutMs: number;
  signal: AbortSignal;
}
export type KubeRequester = (request: KubeRequest) => Promise<{ status: number; body: string }>;

// node:https instead of fetch because the cluster CA must be trusted for this one origin only (global fetch has no
// per-request CA and undici is not a dependency of this package). http: is accepted for tests; the config
// loader only allows https.
export const defaultKubeRequester: KubeRequester = ({ url, headers, ca, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "GET", headers, signal, timeout: timeoutMs, ...(url.protocol === "https:" ? { ca } : {}) }, (res) => {
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

// D-LIVE-1: scope CA trust to this client and reread rotating credentials per request.
// Cost: small file reads; escape hatch: unset KUBE_API_* to restore fixture mode.
export class KubeClient implements KubeReadPort {
  constructor(private readonly options: KubeClientOptions) {}

  async getText(path: string): Promise<string> {
    const url = new URL(path, this.options.apiUrl);
    if (!path.startsWith("/") || url.origin !== new URL(this.options.apiUrl).origin) throw new KubeError("invalid API path");
    let token: string;
    let ca: string;
    try {
      token = fs.readFileSync(this.options.tokenFile, "utf8").trim();
      ca = fs.readFileSync(this.options.caFile, "utf8");
    } catch {
      throw new KubeError("service account files are not readable");
    }
    if (!token) throw new KubeError("service account token is empty");
    const timeoutMs = this.options.timeoutMs ?? 2500;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        (this.options.requester ?? defaultKubeRequester)({ url, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, ca, timeoutMs, signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          // D-LIVE-6: destroy slow-drip sockets at the wall deadline; cost: no late reply; retry on next poll.
          reject(new Error("timeout"));
          controller.abort();
        }, timeoutMs); }),
      ]).catch((error: unknown) => { throw new KubeError(error instanceof Error && error.message === "timeout" ? "timeout" : "unreachable"); });
      if (reply.status !== 200) throw new KubeError(`http-${reply.status}`);
      return reply.body;
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson<T>(path: string): Promise<T> {
    const body = await this.getText(path);
    try { return JSON.parse(body) as T; } catch { throw new KubeError("malformed response"); }
  }
}
