// Minimal read-only JSON-over-HTTP client for upstream adapters. GET only (no method parameter),
// bounded time and size, redirects refused (a redirect could carry the bearer token to another host),
// every failure classified into UpstreamError. Nothing here logs.
import { UpstreamError } from "./errors.js";
import type { BearerTokenProvider } from "./tokenProvider.js";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 2500; // below the route-level 3000ms race so classification wins
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 8; // simultaneous in-flight upstream requests per client
export const DEFAULT_MAX_QUEUED = 64; // callers waiting for a slot; beyond this requests are shed ("overloaded")

export interface UpstreamHttpClientOptions {
  upstream: string; // label used in errors, e.g. "trino"
  baseUrl: string; // origin (+ optional base path), http(s) only
  tokenProvider?: BearerTokenProvider;
  headers?: Readonly<Record<string, string>>; // static non-secret headers, e.g. X-Trino-User
  timeoutMs?: number;
  maxBodyBytes?: number; // enforced in bytes while streaming, not after buffering
  maxConcurrent?: number;
  maxQueued?: number;
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
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

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
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.maxQueued = Math.max(0, options.maxQueued ?? DEFAULT_MAX_QUEUED);
  }

  // Global (per upstream) concurrency cap. Waiting counts against the caller's budget; a full queue sheds load.
  private async acquire(budgetMs: number): Promise<void> {
    const { upstream } = this.options;
    if (this.inFlight < this.maxConcurrent) { this.inFlight++; return; }
    if (this.waiters.length >= this.maxQueued) throw new UpstreamError("overloaded", upstream);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new UpstreamError("timeout", upstream));
      }, budgetMs);
      const grant = () => { clearTimeout(timer); resolve(); }; // slot ownership is handed over (inFlight unchanged)
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.inFlight--;
  }

  // `path` is appended to the base path; `query` values are URL-encoded here. `deadlineAt` (epoch ms)
  // bounds a multi-call operation: the per-call timeout is min(timeoutMs, remaining).
  async getJson(path: string, query?: Readonly<Record<string, string | undefined>>, deadlineAt?: number): Promise<unknown> {
    const { upstream } = this.options;
    const budget = deadlineAt === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadlineAt - Date.now());
    if (budget <= 0) throw new UpstreamError("timeout", upstream);

    const url = new URL(this.base.href);
    const expectedPath = `${url.pathname.replace(/\/+$/, "")}${path}`;
    url.pathname = expectedPath;
    // Defense in depth: the WHATWG parser collapses `.`/`..`/`%2e%2e` segments. If normalization changed the
    // path, a caller-supplied segment escaped its position (path traversal) -> refuse to send.
    if (url.pathname !== expectedPath) throw new UpstreamError("malformed", upstream);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Accept: "application/json", ...this.options.headers };
    if (this.options.tokenProvider) {
      const token = await this.options.tokenProvider.getToken();
      if (!token) throw new UpstreamError("unauthenticated", upstream);
      headers["Authorization"] = `Bearer ${token}`;
    }

    const started = Date.now();
    await this.acquire(budget);
    try {
      return await this.send(url, headers, Math.max(1, budget - (Date.now() - started)));
    } finally {
      this.release();
    }
  }

  private async send(url: URL, headers: Record<string, string>, budgetMs: number): Promise<unknown> {
    const { upstream } = this.options;
    const signal = AbortSignal.timeout(budgetMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
    } catch (error) {
      throw new UpstreamError(isAbort(error) ? "timeout" : "unreachable", upstream);
    }

    // Every path that does not consume the body must release it, otherwise the socket stays open
    // (an endless 5xx body would pin one connection per call).
    if (response.status === 401) { await discard(response); throw new UpstreamError("unauthenticated", upstream, 401); }
    if (response.status === 403) { await discard(response); throw new UpstreamError("forbidden", upstream, 403); }
    if (response.status === 404) { await discard(response); throw new UpstreamError("not_found", upstream, 404); }
    if (!response.ok) { await discard(response); throw new UpstreamError("upstream_error", upstream, response.status); }

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.maxBodyBytes) { await discard(response); throw new UpstreamError("malformed", upstream, response.status); }
    let text: string;
    try {
      text = await readCapped(response, this.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) throw new UpstreamError("malformed", upstream, response.status);
      throw new UpstreamError(isAbort(error) ? "timeout" : "unreachable", upstream);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError("malformed", upstream, response.status);
    }
  }
}

class BodyTooLarge extends Error {}

// Cancel an unread body (frees the connection); never throws.
// Bounded: a stalled cancel() must not hold the caller (and its concurrency slot) hostage. The timer is always cleared.
const DISCARD_TIMEOUT_MS = 1000;
async function boundedCancel(cancel: () => Promise<unknown> | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCARD_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function discard(response: Response): Promise<void> {
  await boundedCancel(() => response.body?.cancel());
}

// Reads at most `max` BYTES, cancelling the stream on overflow (chunked bodies have no content-length).
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new BodyTooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await boundedCancel(() => reader.cancel()); // overflow, abort/timeout or stream error: release the socket
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
