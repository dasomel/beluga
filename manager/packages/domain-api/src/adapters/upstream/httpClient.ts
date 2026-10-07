// Minimal read-only JSON-over-HTTP client for upstream adapters. GET only (no method parameter),
// bounded time and size, redirects refused (a redirect could carry the bearer token to another host),
// every failure classified into UpstreamError. Nothing here logs.
import { UpstreamError } from "./errors.js";
import type { BearerTokenProvider } from "./tokenProvider.js";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 2500; // below the route-level 3000ms race so classification wins
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface UpstreamHttpClientOptions {
  upstream: string; // label used in errors, e.g. "trino"
  baseUrl: string; // origin (+ optional base path), http(s) only
  tokenProvider?: BearerTokenProvider;
  headers?: Readonly<Record<string, string>>; // static non-secret headers, e.g. X-Trino-User
  timeoutMs?: number;
  maxBodyBytes?: number;
  // Sending a bearer token over plain http is refused unless the host is loopback or this is true
  // (in-cluster ClusterIP http is a deployment decision, see docs).
  allowInsecureBearer?: boolean;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class UpstreamHttpClient {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: UpstreamHttpClientOptions) {
    this.base = new URL(options.baseUrl);
    if (this.base.protocol !== "http:" && this.base.protocol !== "https:") {
      throw new Error(`Upstream '${options.upstream}' base URL must be http(s)`);
    }
    if (
      options.tokenProvider &&
      this.base.protocol === "http:" &&
      !LOOPBACK.has(this.base.hostname) &&
      !options.allowInsecureBearer
    ) {
      throw new Error(`Upstream '${options.upstream}': refusing to send a bearer token over plain http (set allowInsecureBearer explicitly)`);
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // `path` is appended to the base path; `query` values are URL-encoded here. `deadlineAt` (epoch ms)
  // bounds a multi-call operation: the per-call timeout is min(timeoutMs, remaining).
  async getJson(path: string, query?: Readonly<Record<string, string | undefined>>, deadlineAt?: number): Promise<unknown> {
    const { upstream } = this.options;
    const budget = deadlineAt === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadlineAt - Date.now());
    if (budget <= 0) throw new UpstreamError("timeout", upstream);

    const url = new URL(this.base.href);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Accept: "application/json", ...this.options.headers };
    if (this.options.tokenProvider) {
      const token = await this.options.tokenProvider.getToken();
      if (!token) throw new UpstreamError("unauthenticated", upstream);
      headers["Authorization"] = `Bearer ${token}`;
    }

    const signal = AbortSignal.timeout(budget);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
    } catch (error) {
      throw new UpstreamError(isAbort(error) ? "timeout" : "unreachable", upstream);
    }

    if (response.status === 401) throw new UpstreamError("unauthenticated", upstream, 401);
    if (response.status === 403) throw new UpstreamError("forbidden", upstream, 403);
    if (response.status === 404) throw new UpstreamError("not_found", upstream, 404);
    if (!response.ok) throw new UpstreamError("upstream_error", upstream, response.status);

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.maxBodyBytes) throw new UpstreamError("malformed", upstream, response.status);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new UpstreamError(isAbort(error) ? "timeout" : "unreachable", upstream);
    }
    if (text.length > this.maxBodyBytes) throw new UpstreamError("malformed", upstream, response.status);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError("malformed", upstream, response.status);
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
