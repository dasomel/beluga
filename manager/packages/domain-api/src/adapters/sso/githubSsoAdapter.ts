import yaml from "yaml";
import { z } from "zod";
import { DEFAULT_BASE_DOMAIN } from "../../config.js";
import { resolveSsoFile, type SsoConfig, type SsoGithubSource, type SsoResponse } from "../../schema/sso.js";
import { parseGroupNames, SsoConfigError, type ReadBaseOptions, type SsoAdapter, type SsoBase } from "./ssoAdapter.js";

// D-MSSO-12: the cluster read source. Reads gitops/values/sso.yaml from the public GitHub repo (unauthenticated,
// 60 requests/hour per IP -- the limit that shapes everything below).
//
// Fixed target (server constants, not env): the read source must not be redirectable to another repo or branch by
// configuration. Tests inject a different target through the constructor only.
//
// Consistency: the branch head is resolved to a commit SHA first, then the file is read at *that* SHA, so
// commitSha and blobSha always describe the same tree (no torn read if main moves between two calls).
//
// Rate-limit budget: at most one conditional `commits/main` call per TTL (default 60s = 60/h worst case, and a
// 304 revalidation is documented as free of primary-rate-limit cost for authenticated calls -- for anonymous calls
// that is *not verified*, so the TTL is sized to fit the quota even if it counts). The contents call happens only
// when the head SHA changed. Concurrent callers share one in-flight refresh.
//
// Failure rule (D-MSSO-12a, decided here): a *transport* failure (network, timeout, 403/429 rate limit, 5xx) serves
// the last good value marked `stale: true` for up to staleMaxMs (10 min) since its last confirmation, then 503.
// A *content* failure (YAML/schema violation) is never masked by stale data: it is a real defect on main -> 503.
// The adapter remembers which commit was invalid: while main still points at it (or GitHub cannot say whether it
// moved) the answer stays 503 and the invalid file is not re-downloaded.
//
// Backoff (D-MSSO-12b): after any failed refresh GitHub is not called again until retryAt = now + TTL, or the
// x-ratelimit-reset / Retry-After instant for a rate-limit answer (capped at MAX_BACKOFF_MS). Callers in that
// window get the stale value (if inside the stale window and no invalid commit is known) or 503, without a call.

export const SSO_GITHUB_TARGET = {
  owner: "dasomel",
  repo: "beluga",
  path: "gitops/values/sso.yaml",
  branch: "main",
  apiBase: "https://api.github.com",
} as const;

// D-MSSO-8 invariant 2: the group names come from this file at the same commit as sso.yaml.
export const GROUPS_FILE_PATH = "policies/groups.yaml";

export interface GithubTarget {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  apiBase: string;
}

export interface GithubSsoAdapterOptions {
  target?: GithubTarget; // test injection only
  baseDomain?: string; // D-DOM-3: sso.yaml host labels resolve to <label>.<baseDomain>
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  staleMaxMs?: number;
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_MAX_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BACKOFF_MS = 60 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/;

const contentsSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  path: z.string(),
  sha: z.string().regex(SHA_RE),
  content: z.string(),
});

class TransportError extends Error {
  constructor(
    public readonly reason: string,
    public readonly retryAtMs?: number,
  ) {
    super(reason);
  }
}

interface Snapshot {
  commitSha: string;
  blobSha: string;
  etag: string | undefined;
  config: SsoConfig;
  text: string;
  /** policies/groups.yaml at commitSha; fetched on first write preview of this commit, then kept with the snapshot. */
  groupNames?: string[];
  confirmedAt: number;
}

export class GithubSsoAdapter implements SsoAdapter {
  private readonly target: GithubTarget;
  private readonly baseDomain: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly staleMaxMs: number;
  private readonly timeoutMs: number;
  private snapshot: Snapshot | undefined;
  private inflight: Promise<SsoResponse> | undefined;
  private retryAt = 0;
  private lastFailure = "unavailable";
  private invalid: { commitSha: string; error: SsoConfigError } | undefined;

  constructor(options: GithubSsoAdapterOptions = {}) {
    this.target = options.target ?? SSO_GITHUB_TARGET;
    this.baseDomain = options.baseDomain ?? DEFAULT_BASE_DOMAIN;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.staleMaxMs = options.staleMaxMs ?? DEFAULT_STALE_MAX_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getSsoConfig(): Promise<SsoResponse> {
    const snap = this.snapshot;
    if (snap !== undefined && this.now() - snap.confirmedAt < this.ttlMs) {
      return Promise.resolve(this.render(snap, undefined));
    }
    if (this.now() < this.retryAt) return this.degraded(this.lastFailure);
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  // D-MSSO-9/12: the base of a preview (cached read) or a submit (fresh = current main now). A write must never
  // be based on a stale or degraded answer, so a degraded response is refused instead of served.
  async readBase(options: ReadBaseOptions = {}): Promise<SsoBase> {
    let response: SsoResponse;
    if (options.fresh === true) {
      if (this.now() < this.retryAt) return Promise.reject(new SsoConfigError(`GitHub SSO source unavailable (${this.lastFailure})`));
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = undefined;
      });
      response = await this.inflight;
    } else {
      response = await this.getSsoConfig();
    }
    if (response.status !== "configured" || response.source.kind !== "github" || response.source.stale) {
      throw new SsoConfigError("GitHub SSO source is stale or unavailable; refusing to base a change on it");
    }
    const snap = this.snapshot;
    if (snap === undefined || snap.commitSha !== response.source.commitSha) {
      throw new SsoConfigError("GitHub SSO source moved during the read; retry");
    }
    if (snap.groupNames === undefined) {
      // Same error translation and backoff as the sso.yaml read: a 429 here is a 503 that honours Retry-After /
      // x-ratelimit-reset, never a leaked TransportError (500) and never a retry inside the window.
      if (this.now() < this.retryAt) throw new SsoConfigError(`GitHub SSO source unavailable (${this.lastFailure})`);
      try {
        const groups = await this.fetchContents(GROUPS_FILE_PATH, snap.commitSha);
        snap.groupNames = parseGroupNames(groups.text, `${GROUPS_FILE_PATH} at ${snap.commitSha}`);
      } catch (error) {
        const now = this.now();
        if (error instanceof TransportError) {
          this.lastFailure = error.reason;
          this.retryAt = Math.min(Math.max(error.retryAtMs ?? 0, now + this.ttlMs), now + MAX_BACKOFF_MS);
          throw new SsoConfigError(`GitHub SSO source unavailable (${error.reason})`);
        }
        if (error instanceof SsoConfigError) {
          this.lastFailure = "invalid-source";
          this.retryAt = now + this.ttlMs;
        }
        throw error;
      }
    }
    return {
      commitSha: snap.commitSha,
      blobSha: snap.blobSha,
      text: snap.text,
      baseDomain: this.baseDomain,
      config: snap.config,
      groupNames: snap.groupNames,
    };
  }

  private async refresh(): Promise<SsoResponse> {
    try {
      const head = await this.fetchHead();
      if (this.invalid !== undefined) {
        if (this.invalid.commitSha === head.commitSha) throw this.invalid.error;
        this.invalid = undefined; // main moved past the invalid commit
      }
      this.retryAt = 0;
      const previous = this.snapshot;
      if (previous !== undefined && head.commitSha === previous.commitSha) {
        previous.confirmedAt = this.now();
        previous.etag = head.etag ?? previous.etag;
        return this.render(previous, undefined);
      }
      let file: Awaited<ReturnType<GithubSsoAdapter["fetchFile"]>>;
      try {
        file = await this.fetchFile(head.commitSha);
      } catch (error) {
        if (error instanceof SsoConfigError) this.invalid = { commitSha: head.commitSha, error };
        throw error;
      }
      const snapshot: Snapshot = {
        commitSha: head.commitSha,
        blobSha: file.blobSha,
        etag: head.etag,
        config: file.config,
        text: file.text,
        confirmedAt: this.now(),
      };
      this.snapshot = snapshot;
      return this.render(snapshot, undefined);
    } catch (error) {
      if (error instanceof SsoConfigError) {
        this.lastFailure = "invalid-source";
        this.retryAt = this.now() + this.ttlMs; // no per-request hammering while the source is bad
        throw error;
      }
      const reason = error instanceof TransportError ? error.reason : "unexpected-error";
      const until = error instanceof TransportError ? error.retryAtMs : undefined;
      const now = this.now();
      this.lastFailure = reason;
      this.retryAt = Math.min(Math.max(until ?? 0, now + this.ttlMs), now + MAX_BACKOFF_MS);
      return this.degraded(reason);
    }
  }

  // Transport trouble: stale value inside the bounded window, otherwise 503. A remembered invalid commit wins over
  // stale data -- we cannot show the old good value while main may still be broken.
  private degraded(reason: string): Promise<SsoResponse> {
    if (this.invalid !== undefined) return Promise.reject(this.invalid.error);
    const previous = this.snapshot;
    if (previous !== undefined && this.now() - previous.confirmedAt <= this.staleMaxMs) {
      return Promise.resolve(this.render(previous, reason));
    }
    return Promise.reject(new SsoConfigError(`GitHub SSO source unavailable (${reason})`));
  }

  private render(snap: Snapshot, staleReason: string | undefined): SsoResponse {
    const fetchedAt = new Date(snap.confirmedAt).toISOString();
    const source: SsoGithubSource = {
      kind: "github",
      repo: `${this.target.owner}/${this.target.repo}`,
      path: this.target.path,
      ref: "main",
      commitSha: snap.commitSha,
      blobSha: snap.blobSha,
      fetchedAt,
      loadedAt: fetchedAt,
      stale: staleReason !== undefined,
      ...(staleReason !== undefined ? { staleReason } : {}),
    };
    return { status: "configured", configured: true, source, config: snap.config };
  }

  private repoUrl(suffix: string): URL {
    const { apiBase, owner, repo } = this.target;
    return new URL(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`);
  }

  private async get(url: URL, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "User-Agent": "beluga-manager", "X-GitHub-Api-Version": "2022-11-28", ...headers },
      });
    } catch (error) {
      throw new TransportError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable");
    }
  }

  private async fetchHead(): Promise<{ commitSha: string; etag: string | undefined }> {
    const url = this.repoUrl(`/commits/${encodeURIComponent(this.target.branch)}`);
    const headers: Record<string, string> = { Accept: "application/vnd.github.sha" };
    const previous = this.snapshot;
    if (previous?.etag !== undefined) headers["If-None-Match"] = previous.etag;

    const res = await this.get(url, headers);
    if (res.status === 304 && previous !== undefined) {
      await res.body?.cancel();
      return { commitSha: previous.commitSha, etag: previous.etag };
    }
    const text = await this.readOk(res);
    const commitSha = text.trim();
    if (!SHA_RE.test(commitSha)) throw new SsoConfigError("GitHub returned a malformed commit SHA");
    return { commitSha, etag: res.headers.get("etag") ?? undefined };
  }

  private async fetchContents(filePath: string, commitSha: string): Promise<{ blobSha: string; text: string }> {
    const url = this.repoUrl(`/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`);
    url.searchParams.set("ref", commitSha);
    const res = await this.get(url, { Accept: "application/vnd.github+json" });
    const body = await this.readOk(res);

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new SsoConfigError("GitHub contents response is not JSON");
    }
    const parsed = contentsSchema.safeParse(json);
    if (!parsed.success || parsed.data.path !== filePath) {
      throw new SsoConfigError("GitHub contents response is not the expected file");
    }
    return { blobSha: parsed.data.sha, text: Buffer.from(parsed.data.content, "base64").toString("utf8") };
  }

  private async fetchFile(commitSha: string): Promise<{ blobSha: string; config: SsoConfig; text: string }> {
    const { blobSha, text: yamlText } = await this.fetchContents(this.target.path, commitSha);

    let raw: unknown;
    try {
      raw = yaml.parse(yamlText);
    } catch {
      throw new SsoConfigError(`Malformed YAML in ${this.target.path} at ${commitSha}`);
    }
    const result = resolveSsoFile(raw, this.baseDomain);
    if (!result.ok) {
      throw new SsoConfigError(`Invalid SSO configuration in ${this.target.path} at ${commitSha}: ${result.summary}`);
    }
    return { blobSha, config: result.config, text: yamlText };
  }

  // 200 -> bounded body text. Everything else is a transport-class failure (stale-eligible).
  private async readOk(res: Response): Promise<string> {
    if (res.status !== 200) {
      await res.body?.cancel();
      const rateLimited =
        res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (!rateLimited) throw new TransportError(`http-${res.status}`);
      // Header values come from the network: ignore anything that is not a finite number.
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Number.isFinite(retryAfter) && retryAfter > 0 ? this.now() + retryAfter * 1000 : undefined;
      throw new TransportError("rate-limited", until);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      await res.body?.cancel();
      throw new SsoConfigError("GitHub response too large");
    }
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new SsoConfigError("GitHub response too large");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof SsoConfigError) throw error;
      throw new TransportError("unreachable");
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
