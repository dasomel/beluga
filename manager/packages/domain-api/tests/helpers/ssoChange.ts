// Fakes for the SSO change-request routes: in-memory store (with a "down" switch), fake git writer, fake verifier
// and a file-backed SsoBase. Everything records its calls so tests can assert "zero DB writes / zero git calls".
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "yaml";
import { gitBlobSha, parseGroupNames, type SsoAdapter, type SsoBase } from "../../src/adapters/sso/ssoAdapter.js";
import { AuthError, type Principal, type TokenVerifier } from "../../src/auth/oidc.js";
import { resolveSsoFile } from "../../src/schema/sso.js";
import {
  GitWriteError,
  GithubUnavailableError,
  type CompareStatus,
  type CreateChangePrInput,
  type GitChangeOps,
  type PrInfo,
} from "../../src/sso-change/gitWriter.js";
import {
  StoreError,
  type AuditStoreStatus,
  type ChangeRecord,
  type NewEvent,
  type SsoChangeStore,
  type SubmitInput,
  type TransitionEvent,
  type TransitionFields,
} from "../../src/store/ssoChangeStore.js";

export const FIXTURES = path.resolve(__dirname, "../fixtures");
export const KEY_A = "3f9a1c7e5b2d4a8f9c0e1d2b3a4f5e6d";
export const KEY_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export class FakeStore implements SsoChangeStore {
  down = false;
  events: NewEvent[] = [];
  requests = new Map<string, ChangeRecord>();
  writes = 0; // every call that would write to the database
  async ready() {
    return !this.down;
  }
  status(): AuditStoreStatus {
    return this.down ? "unavailable" : "ok";
  }
  private guard() {
    if (this.down) throw new StoreError("UNAVAILABLE", "down");
  }
  /** Makes recordEvent throw for events whose detail has this `cancel` value (a dead audit DB at that moment). */
  failEventsWhere: ((event: NewEvent) => boolean) | undefined;
  async recordEvent(event: NewEvent) {
    this.writes++;
    this.guard();
    if (this.failEventsWhere?.(event)) throw new StoreError("UNAVAILABLE", "down");
    this.events.push(event);
  }
  async findByKey(key: string) {
    this.guard();
    return [...this.requests.values()].find((r) => r.idempotencyKey === key);
  }
  async get(id: string) {
    this.guard();
    return this.requests.get(id);
  }
  async submit(input: SubmitInput) {
    this.writes++;
    this.guard();
    const existing = await this.findByKey(input.idempotencyKey);
    if (existing) {
      if (existing.payloadSha256 !== input.payloadSha256) throw new StoreError("IDEMPOTENCY_MISMATCH", "mismatch");
      return { record: existing, replay: true };
    }
    if ([...this.requests.values()].some((r) => ["submitted", "pr_open", "unknown_recovering"].includes(r.stage))) {
      throw new StoreError("OPEN_REQUEST_EXISTS", "open");
    }
    if ([...this.requests.values()].some((r) => r.branch === input.branch)) throw new StoreError("IDEMPOTENCY_KEY_COLLISION", "collision");
    const now = new Date().toISOString();
    const record: ChangeRecord = {
      id: randomUUID(),
      stage: "submitted",
      filePath: input.filePath,
      endpoint: input.endpoint,
      idempotencyKey: input.idempotencyKey,
      payloadSha256: input.payloadSha256,
      baseBlobSha: input.baseBlobSha,
      sourceCommitSha: input.sourceCommitSha,
      patch: { allowedGroups: input.allowedGroups },
      actorSub: input.actorSub,
      actorUsername: input.actorUsername ?? null,
      branch: input.branch,
      prNumber: null,
      prUrl: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      version: randomUUID(),
    };
    this.requests.set(record.id, record);
    this.events.push({ stage: "submitted", requestId: record.id, actorSub: input.actorSub, reason: input.reason ?? null });
    return { record, replay: false };
  }
  /** D-MSSO-18b: another replica holds the reconciler lease. */
  leaseHeldElsewhere = false;
  leaseRuns = 0;
  async withReconcilerLease(fn: () => Promise<void>) {
    this.guard();
    if (this.leaseHeldElsewhere) return false;
    this.leaseRuns++;
    await fn();
    return true;
  }
  /** Set to make the next transition calls throw (a dead database after GitHub answered). */
  failTransitions = false;
  async transition(id: string, expectedStage: ChangeRecord["stage"], stage: ChangeRecord["stage"], fields: TransitionFields, event?: TransitionEvent, expectedVersion?: string) {
    this.writes++;
    this.guard();
    if (this.failTransitions) throw new StoreError("UNAVAILABLE", "down");
    const current = this.requests.get(id);
    if (!current || current.stage !== expectedStage) return undefined; // lost CAS: no update, no event
    if (expectedVersion !== undefined && current.version !== expectedVersion) return undefined;
    const next = {
      ...current,
      stage,
      prNumber: fields.prNumber ?? current.prNumber,
      prUrl: fields.prUrl ?? current.prUrl,
      mergeCommitSha: fields.mergeCommitSha ?? current.mergeCommitSha,
      updatedAt: new Date().toISOString(),
      version: randomUUID(),
    };
    this.requests.set(id, next);
    this.events.push({
      stage,
      requestId: id,
      actorSub: event?.actorSub ?? current.actorSub,
      reason: event?.reason ?? null,
      detail: event?.detail,
    });
    return next;
  }
  async findByBranch(branch: string) {
    this.guard();
    return [...this.requests.values()].find((r) => r.branch === branch);
  }
  async listRecentTerminal(sinceMs: number, limit: number) {
    this.guard();
    return [...this.requests.values()]
      .filter((r) => (r.stage === "failed" || r.stage === "rejected") && Date.parse(r.updatedAt) >= sinceMs)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
  async listOpen(limit: number) {
    this.guard();
    const open = ["submitted", "pr_open", "unknown_recovering", "merged"];
    return [...this.requests.values()]
      .filter((r) => open.includes(r.stage))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

export const PR_URL = "https://github.com/dasomel/beluga/pull/42";

/** Programmable GitChangeOps: createChangePr outcome plus an in-memory view of branches/PRs for the other methods. */
export class FakeGitWriter implements GitChangeOps {
  calls: CreateChangePrInput[] = [];
  outcome: "ok" | GitWriteError["kind"] | "throw" = "ok";
  branches = new Set<string>();
  prs = new Map<string, PrInfo>(); // by branch
  files = new Map<string, { blobSha: string; text: string }>(); // key: `${path}@${ref}`
  compareResults = new Map<string, CompareStatus>(); // key: `${base}...${head}`
  openSsoPrs: { number: number; branch: string }[] = [];
  closed: number[] = [];
  /** Any of these makes the corresponding call throw GithubUnavailableError. */
  failing = new Set<"findPrByBranch" | "findBranch" | "getPr" | "closePr" | "compare" | "listOpenSsoPrs" | "readFile">();
  /** Names of every read/close method called, so tests can assert "no GitHub call happened". */
  touched: string[] = [];
  private guard(name: string) {
    this.touched.push(name);
    if ((this.failing as Set<string>).has(name)) throw new GithubUnavailableError("http-503");
  }
  async createChangePr(input: CreateChangePrInput) {
    this.calls.push(input);
    if (this.outcome === "ok") return { prNumber: 42, prUrl: PR_URL };
    if (this.outcome === "throw") throw new Error("socket hang up");
    throw new GitWriteError(this.outcome, "boom");
  }
  async findBranch(branch: string) {
    this.guard("findBranch");
    return this.branches.has(branch) ? { sha: "d".repeat(40) } : undefined;
  }
  /** Every notBefore the code passed, so tests can assert D-MSSO-19a is applied on each lookup. */
  notBefores: (number | undefined)[] = [];
  async findPrByBranch(branch: string, notBefore?: number) {
    this.guard("findPrByBranch");
    this.notBefores.push(notBefore);
    const pr = this.prs.get(branch);
    // Same contract as the real client: a PR without created_at, or older than notBefore, is not returned.
    if (pr !== undefined && notBefore !== undefined && !(Date.parse(pr.createdAt ?? "") >= notBefore)) return undefined;
    return pr;
  }
  async getPr(number: number) {
    this.guard("getPr");
    return [...this.prs.values()].find((p) => p.number === number);
  }
  async closePr(number: number) {
    this.guard("closePr");
    this.closed.push(number);
    const pr = [...this.prs.values()].find((p) => p.number === number);
    if (!pr) throw new GithubUnavailableError("close-404");
    pr.state = "closed";
    return pr;
  }
  async compare(base: string, head: string) {
    this.guard("compare");
    return this.compareResults.get(`${base}...${head}`) ?? "diverged";
  }
  async listOpenSsoPrs() {
    this.guard("listOpenSsoPrs");
    return this.openSsoPrs;
  }
  async readFile(path: string, ref: string) {
    this.guard("readFile");
    const file = this.files.get(`${path}@${ref}`);
    if (!file) throw new GithubUnavailableError("contents-404");
    return file;
  }
}

export const TOKENS = {
  admin: { sub: "u-admin", username: "alice", groups: ["admins"] },
  engineer: { sub: "u-eng", username: "bob", groups: ["engineers"] },
} satisfies Record<string, Principal>;

export const fakeVerifier: TokenVerifier = {
  async verify(token) {
    const p = (TOKENS as Record<string, Principal>)[token];
    if (!p) throw new AuthError("invalid", "bad token");
    return p;
  },
};

export class FakeAdapter implements SsoAdapter {
  text = fs.readFileSync(path.join(FIXTURES, "sso-change.yaml"), "utf8");
  groupsText = fs.readFileSync(path.join(FIXTURES, "groups.yaml"), "utf8");
  commitSha = "b".repeat(40);
  readCalls: { fresh: boolean | undefined }[] = [];
  getSsoConfig(): never {
    throw new Error("not used");
  }
  /** Simulates main moving: a different file content gets a different blob SHA. */
  setText(text: string) {
    this.text = text;
    this.commitSha = "c".repeat(40);
  }
  async readBase(options: { fresh?: boolean } = {}): Promise<SsoBase> {
    this.readCalls.push({ fresh: options.fresh });
    const resolved = resolveSsoFile(yaml.parse(this.text), "local.beluga.internal");
    if (!resolved.ok) throw new Error(resolved.summary);
    return {
      commitSha: this.commitSha,
      blobSha: gitBlobSha(this.text),
      text: this.text,
      baseDomain: "local.beluga.internal",
      config: resolved.config,
      groupNames: parseGroupNames(this.groupsText, "groups.yaml"),
    };
  }
}
