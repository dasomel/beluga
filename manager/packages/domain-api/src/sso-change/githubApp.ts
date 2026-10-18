import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { GROUPS_FILE_PATH, SSO_GITHUB_TARGET, type GithubTarget } from "../adapters/sso/githubSsoAdapter.js";
import { SSO_FILE_PATH } from "./editEngine.js";
import {
  CREATE_PR_DEADLINE_MS,
  GitWriteError,
  GithubUnavailableError,
  type CompareStatus,
  type CreateChangePrInput,
  type CreatedPr,
  type GitChangeOps,
  type PrInfo,
} from "./gitWriter.js";

// D-MSSO-10/15/19: the GitHub App implementation of the Git write path. Hard guards (enforced in code, not by
// trust in callers): branches must match BRANCH_RE, the written path is the constant gitops/values/sso.yaml, and
// there is NO merge (or ref update/delete) call anywhere in this file.
//
// Credentials: a JWT (RS256, node:crypto, no dependency) is exchanged for an installation token that lives in
// memory only. Neither the key, the JWT nor the token is ever logged, returned or put into an error message.

export const BRANCH_RE = /^sso\/(flink|filer)-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const READABLE_PATHS: readonly string[] = [SSO_FILE_PATH, GROUPS_FILE_PATH];

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
// D-MSSO-15: iat is backdated 60 s for clock skew; exp is 9 min after "now" (GitHub's maximum is 10 min).
const JWT_BACKDATE_S = 60;
const JWT_TTL_S = 540;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// D-MSSO-19c: open-PR listing follows the Link header, but never more than this many pages (100 PRs each).
const MAX_PR_PAGES = 5;

export interface GithubAppOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  target?: GithubTarget; // test injection only
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** D-MSSO-19b: overall budget of one createChangePr; default CREATE_PR_DEADLINE_MS. */
  createDeadlineMs?: number;
}

interface Reply {
  status: number;
  json: unknown;
  link: string | null;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null ? (json as Record<string, unknown>)[key] : undefined;
}

// GitHub puts the useful text either in `message` or in `errors[].message`; callers match on it, never forward it.
function errorText(json: unknown): string {
  const parts: string[] = [];
  const message = field(json, "message");
  if (typeof message === "string") parts.push(message);
  const errors = field(json, "errors");
  if (Array.isArray(errors)) for (const e of errors) parts.push(typeof e === "string" ? e : String(field(e, "message") ?? ""));
  return parts.join(" | ").slice(0, 300);
}

export class GithubAppClient implements GitChangeOps {
  private readonly target: GithubTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly createDeadlineMs: number;
  // D-MSSO-19b: absolute deadline (epoch ms of this.now) of the createChangePr running in this async context.
  private readonly deadline = new AsyncLocalStorage<number>();
  private readonly key: crypto.KeyObject;
  private readonly appId: string;
  private readonly installationId: string;
  private token: { value: string; refreshAt: number } | undefined;
  private tokenInflight: Promise<string> | undefined;
  private retryAt = 0;

  /** Throws when the key is not a usable private key (the wiring turns that into "writer unconfigured"). */
  constructor(options: GithubAppOptions) {
    this.target = options.target ?? SSO_GITHUB_TARGET;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.createDeadlineMs = options.createDeadlineMs ?? CREATE_PR_DEADLINE_MS;
    this.appId = options.appId;
    this.installationId = options.installationId;
    this.key = crypto.createPrivateKey(options.privateKeyPem);
  }

  /** D-MSSO-15: RS256 JWT, iat = now-60, exp = now+540, iss = app id. Exposed for tests only. */
  signJwt(): string {
    const nowS = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_TTL_S, iss: this.appId }));
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), this.key);
    return `${head}.${payload}.${b64url(signature)}`;
  }

  // ---- transport -----------------------------------------------------------------------------------------

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repo)}${suffix}`;
  }

  private async send(method: string, pathAndQuery: string, bearer: string, body?: unknown): Promise<Reply> {
    if (this.now() < this.retryAt) throw new GithubUnavailableError("rate-limited");
    // Inside createChangePr every request is capped by what is left of the overall deadline.
    const deadline = this.deadline.getStore();
    const remaining = deadline === undefined ? Infinity : deadline - this.now();
    if (remaining <= 0) throw new GithubUnavailableError("deadline-exceeded");
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(`${this.target.apiBase}${pathAndQuery}`), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, remaining)),
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "beluga-manager",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new GithubUnavailableError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable");
    }
    const text = await this.readBody(res);
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      // Header values come from the network: ignore anything that is not a finite number.
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Number.isFinite(retryAfter) && retryAfter > 0 ? this.now() + retryAfter * 1000 : 0;
      const now = this.now();
      this.retryAt = Math.min(Math.max(until, now + DEFAULT_BACKOFF_MS), now + MAX_BACKOFF_MS);
      throw new GithubUnavailableError("rate-limited");
    }
    if (res.status >= 500) throw new GithubUnavailableError(`http-${res.status}`);
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, link: res.headers.get("link") };
  }

  private async readBody(res: Response): Promise<string> {
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      await res.body?.cancel();
      throw new GithubUnavailableError("response-too-large");
    }
    try {
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new GithubUnavailableError("response-too-large");
      return text;
    } catch (error) {
      if (error instanceof GithubUnavailableError) throw error;
      throw new GithubUnavailableError("unreachable");
    }
  }

  private installationToken(): Promise<string> {
    if (this.token !== undefined && this.now() < this.token.refreshAt) return Promise.resolve(this.token.value);
    this.tokenInflight ??= this.mintToken().finally(() => {
      this.tokenInflight = undefined;
    });
    return this.tokenInflight;
  }

  private async mintToken(): Promise<string> {
    const res = await this.send("POST", `/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`, this.signJwt(), {});
    const token = field(res.json, "token");
    const expiresAt = Date.parse(String(field(res.json, "expires_at")));
    if (res.status !== 201 || typeof token !== "string" || token === "" || !Number.isFinite(expiresAt)) {
      throw new GithubUnavailableError(`installation-token-${res.status}`);
    }
    this.token = { value: token, refreshAt: expiresAt - TOKEN_REFRESH_MARGIN_MS };
    return token;
  }

  /** Installation-token call; a 401 means the cached token was revoked or expired early: mint a new one once. */
  private async api(method: string, suffix: string, body?: unknown): Promise<Reply> {
    const path = this.repoPath(suffix);
    let reply = await this.send(method, path, await this.installationToken(), body);
    if (reply.status === 401) {
      this.token = undefined;
      reply = await this.send(method, path, await this.installationToken(), body);
    }
    return reply;
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  private refPath(branch: string): string {
    return branch.split("/").map(encodeURIComponent).join("/");
  }

  private guardBranch(branch: string): void {
    if (!BRANCH_RE.test(branch)) throw new GitWriteError("rejected", "branch name is not an allowed sso/* branch");
  }

  async findBranch(branch: string): Promise<{ sha: string } | undefined> {
    this.guardBranch(branch);
    const res = await this.api("GET", `/git/ref/heads/${this.refPath(branch)}`);
    if (res.status === 404) return undefined;
    const sha = field(field(res.json, "object"), "sha");
    if (res.status !== 200 || typeof sha !== "string" || !SHA_RE.test(sha)) throw new GithubUnavailableError(`ref-${res.status}`);
    return { sha };
  }

  private toPr(json: unknown): PrInfo | undefined {
    const number = field(json, "number");
    const url = field(json, "html_url");
    const state = field(json, "state");
    if (typeof number !== "number" || typeof url !== "string" || (state !== "open" && state !== "closed")) return undefined;
    const mergedAt = field(json, "merged_at");
    const merge = field(json, "merge_commit_sha");
    const merged = typeof mergedAt === "string" || field(json, "merged") === true;
    const created = field(json, "created_at");
    return { number, url, createdAt: typeof created === "string" ? created : undefined, state, merged, mergeCommitSha: merged && typeof merge === "string" && SHA_RE.test(merge) ? merge : null };
  }

  async findPrByBranch(branch: string, notBefore?: number): Promise<PrInfo | undefined> {
    this.guardBranch(branch);
    const head = encodeURIComponent(`${this.target.owner}:${branch}`);
    const res = await this.api("GET", `/pulls?head=${head}&state=all&per_page=5`);
    if (res.status !== 200 || !Array.isArray(res.json)) throw new GithubUnavailableError(`pulls-${res.status}`);
    // Prefer an open PR; the newest closed one otherwise (GitHub lists newest first).
    // D-MSSO-19a: a PR older than the request belongs to an earlier request that used the same branch name.
    const prs = res.json
      .map((p) => this.toPr(p))
      .filter((p): p is PrInfo => p !== undefined)
      .filter((p) => notBefore === undefined || Date.parse(p.createdAt ?? "") >= notBefore);
    return prs.find((p) => p.state === "open") ?? prs[0];
  }

  async getPr(number: number): Promise<PrInfo | undefined> {
    if (!Number.isInteger(number) || number <= 0) throw new GithubUnavailableError("invalid-pr-number");
    const res = await this.api("GET", `/pulls/${number}`);
    if (res.status === 404) return undefined;
    const pr = res.status === 200 ? this.toPr(res.json) : undefined;
    if (pr === undefined) throw new GithubUnavailableError(`pull-${res.status}`);
    return pr;
  }

  async compare(base: string, head: string): Promise<CompareStatus> {
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new GithubUnavailableError("invalid-sha");
    const res = await this.api("GET", `/compare/${base}...${head}?per_page=1`);
    const status = field(res.json, "status");
    if (res.status !== 200 || (status !== "identical" && status !== "ahead" && status !== "behind" && status !== "diverged")) {
      throw new GithubUnavailableError(`compare-${res.status}`);
    }
    return status;
  }

  async listOpenSsoPrs(): Promise<{ number: number; branch: string }[]> {
    const out: { number: number; branch: string }[] = [];
    for (let page = 1; page <= MAX_PR_PAGES; page++) {
      const res = await this.api("GET", `/pulls?state=open&per_page=100&page=${page}`);
      if (res.status !== 200 || !Array.isArray(res.json)) throw new GithubUnavailableError(`pulls-${res.status}`);
      for (const p of res.json) {
        const ref = field(field(p, "head"), "ref");
        const number = field(p, "number");
        if (typeof ref === "string" && ref.startsWith("sso/") && typeof number === "number") out.push({ number, branch: ref });
      }
      // We build the next URL ourselves; the header is only a "there is more" signal (never followed as given).
      if (res.link === null || !/rel="next"/.test(res.link)) break;
    }
    return out;
  }

  async readFile(path: string, ref: string): Promise<{ blobSha: string; text: string }> {
    if (!READABLE_PATHS.includes(path)) throw new GithubUnavailableError("path-not-readable");
    const file = await this.readContents(path, ref);
    if (file === undefined) throw new GithubUnavailableError("contents-404");
    return file;
  }

  /** undefined = 404. `ref` is a commit SHA or a branch name. */
  private async readContents(path: string, ref: string): Promise<{ blobSha: string; text: string } | undefined> {
    const res = await this.api("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return undefined;
    const sha = field(res.json, "sha");
    const content = field(res.json, "content");
    if (res.status !== 200 || field(res.json, "path") !== path || typeof sha !== "string" || !SHA_RE.test(sha) || typeof content !== "string") {
      throw new GithubUnavailableError(`contents-${res.status}`);
    }
    return { blobSha: sha, text: Buffer.from(content, "base64").toString("utf8") };
  }

  // ---- writes ---------------------------------------------------------------------------------------------

  async closePr(number: number): Promise<PrInfo> {
    if (!Number.isInteger(number) || number <= 0) throw new GithubUnavailableError("invalid-pr-number");
    const res = await this.api("PATCH", `/pulls/${number}`, { state: "closed" });
    const pr = res.status === 200 ? this.toPr(res.json) : undefined;
    if (pr === undefined) throw new GithubUnavailableError(`close-${res.status}`);
    return pr;
  }

  /**
   * D-MSSO-19: idempotent by branch. Safe to call again after any partial failure (ref made, file written, PR made).
   * Error mapping: 409/422 on the file write -> conflict; other 4xx -> rejected; timeout/5xx/transport -> unknown.
   */
  async createChangePr(input: CreateChangePrInput): Promise<CreatedPr> {
    try {
      return await this.deadline.run(this.now() + this.createDeadlineMs, () => this.createChangePrUnguarded(input));
    } catch (error) {
      if (error instanceof GitWriteError) throw error;
      throw new GitWriteError("unknown", error instanceof GithubUnavailableError ? error.message : "unexpected error");
    }
  }

  private async createChangePrUnguarded(input: CreateChangePrInput): Promise<CreatedPr> {
    this.guardBranch(input.branch);
    if (input.path !== SSO_FILE_PATH) throw new GitWriteError("rejected", "path is not the allowed sso.yaml");
    if (!SHA_RE.test(input.baseCommitSha) || !SHA_RE.test(input.baseBlobSha)) throw new GitWriteError("rejected", "malformed base SHA");

    // 1. branch. 422 "Reference already exists" is fine when the branch is really there (an earlier attempt).
    const ref = await this.api("POST", "/git/refs", { ref: `refs/heads/${input.branch}`, sha: input.baseCommitSha });
    if (ref.status !== 201) {
      const exists = ref.status === 422 && /reference already exists/i.test(errorText(ref.json));
      if (!exists || (await this.findBranch(input.branch)) === undefined) this.refuse(ref, "branch");
    }

    // 2. file. Compare against what is ON THE BRANCH: equal -> skip (replay); the sha of the PUT is the branch blob.
    const onBranch = await this.readContents(input.path, input.branch);
    if (onBranch === undefined) throw new GitWriteError("rejected", "sso.yaml is missing on the branch");
    if (onBranch.text !== input.content) {
      // The branch holds neither the base nor the target: somebody else touched it. Never overwrite that.
      if (onBranch.blobSha !== input.baseBlobSha) throw new GitWriteError("conflict", "branch content changed outside this request");
      const put = await this.api("PUT", `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`, {
        message: input.commitMessage,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        sha: onBranch.blobSha,
        branch: input.branch,
      });
      if (put.status !== 200 && put.status !== 201) {
        if (put.status === 409 || put.status === 422) {
          // D-MSSO-19d: another instance (reconciler on a second replica) may have written the very same content
          // between our read and our PUT. Re-read: equal to the target = the writes converged, carry on.
          const now = await this.readContents(input.path, input.branch);
          if (now?.text !== input.content) throw new GitWriteError("conflict", `content write refused (${put.status})`);
        } else {
          this.refuse(put, "content write");
        }
      }
    }

    // 3. pull request. 422 "A pull request already exists" -> look it up by head and return it.
    const created = await this.api("POST", "/pulls", {
      title: input.title,
      head: input.branch,
      base: this.target.branch,
      body: input.body,
      maintainer_can_modify: false,
    });
    if (created.status === 201) {
      const pr = this.toPr(created.json);
      if (pr === undefined) throw new GithubUnavailableError("pull-malformed");
      return { prNumber: pr.number, prUrl: pr.url };
    }
    if (created.status === 422 && /pull request already exists/i.test(errorText(created.json))) {
      const existing = await this.findPrByBranch(input.branch);
      if (existing !== undefined) return { prNumber: existing.number, prUrl: existing.url };
    }
    return this.refuse(created, "pull request");
  }

  private refuse(reply: Reply, step: string): never {
    const kind = reply.status === 409 ? "conflict" : "rejected";
    throw new GitWriteError(kind, `${step} refused (${reply.status})`);
  }
}
