// Fakes for the SSO change-request routes: in-memory store (with a "down" switch), fake git writer, fake verifier
// and a file-backed SsoBase. Everything records its calls so tests can assert "zero DB writes / zero git calls".
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "yaml";
import { gitBlobSha, parseGroupNames, type SsoAdapter, type SsoBase } from "../../src/adapters/sso/ssoAdapter.js";
import { AuthError, type Principal, type TokenVerifier } from "../../src/auth/oidc.js";
import { resolveSsoFile } from "../../src/schema/sso.js";
import { GitWriteError, type CreateChangePrInput, type GitWriter } from "../../src/sso-change/gitWriter.js";
import {
  StoreError,
  type AuditStoreStatus,
  type ChangeRecord,
  type NewEvent,
  type SsoChangeStore,
  type SubmitInput,
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
  async recordEvent(event: NewEvent) {
    this.writes++;
    this.guard();
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
    };
    this.requests.set(record.id, record);
    this.events.push({ stage: "submitted", requestId: record.id, actorSub: input.actorSub, reason: input.reason ?? null });
    return { record, replay: false };
  }
  async transition(id: string, stage: ChangeRecord["stage"], fields: { prNumber?: number; prUrl?: string }, event?: { reason?: string }) {
    this.writes++;
    this.guard();
    const current = this.requests.get(id);
    if (!current) throw new StoreError("UNAVAILABLE", "missing");
    const next = { ...current, stage, prNumber: fields.prNumber ?? current.prNumber, prUrl: fields.prUrl ?? current.prUrl };
    this.requests.set(id, next);
    this.events.push({ stage, requestId: id, actorSub: current.actorSub, reason: event?.reason ?? null });
    return next;
  }
}

export class FakeGitWriter implements GitWriter {
  calls: CreateChangePrInput[] = [];
  outcome: "ok" | GitWriteError["kind"] | "throw" = "ok";
  async createChangePr(input: CreateChangePrInput) {
    this.calls.push(input);
    if (this.outcome === "ok") return { prNumber: 42, prUrl: "https://github.com/dasomel/beluga/pull/42" };
    if (this.outcome === "throw") throw new Error("socket hang up");
    throw new GitWriteError(this.outcome, "boom");
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
