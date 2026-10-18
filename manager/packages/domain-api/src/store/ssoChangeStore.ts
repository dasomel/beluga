// D-MSSO-9/11: the audit and current-state store of SSO change requests (Postgres, dedicated CNPG cluster).
// The interface is what routes depend on; PgSsoChangeStore is the only production implementation, tests inject a fake.
import fs from "node:fs";
import pg from "pg";
import type { AuditDbConfig } from "../config.js";

export type ChangeStage =
  | "submitted"
  | "pr_open"
  | "unknown_recovering"
  | "merged"
  | "applied"
  | "rejected"
  | "failed";
export type EventStage = ChangeStage | "denied" | "previewed";

export const CHANGE_STAGES: readonly ChangeStage[] = [
  "submitted",
  "pr_open",
  "unknown_recovering",
  "merged",
  "applied",
  "rejected",
  "failed",
];

export interface ChangeRecord {
  id: string;
  stage: ChangeStage;
  filePath: string;
  endpoint: string;
  idempotencyKey: string;
  payloadSha256: string;
  baseBlobSha: string;
  sourceCommitSha: string;
  patch: { allowedGroups: string[] };
  actorSub: string;
  actorUsername: string | null;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewEvent {
  requestId?: string | null;
  stage: EventStage;
  actorSub: string;
  actorUsername?: string | null;
  endpoint?: string | null;
  idempotencyKey?: string | null;
  baseBlobSha?: string | null;
  payloadSha256?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  mergeCommitSha?: string | null;
  reason?: string | null;
  detail?: unknown;
}

export interface SubmitInput {
  filePath: string;
  endpoint: string;
  idempotencyKey: string;
  payloadSha256: string;
  baseBlobSha: string;
  sourceCommitSha: string;
  allowedGroups: string[];
  actorSub: string;
  actorUsername?: string | undefined;
  branch: string;
  reason?: string | undefined;
}

export interface TransitionFields {
  prNumber?: number;
  prUrl?: string;
  mergeCommitSha?: string;
}

/** OPEN_REQUEST_EXISTS -> 409, IDEMPOTENCY_MISMATCH -> 422, UNAVAILABLE -> 503 AUDIT_UNAVAILABLE. */
export class StoreError extends Error {
  constructor(
    public readonly code: "OPEN_REQUEST_EXISTS" | "IDEMPOTENCY_MISMATCH" | "UNAVAILABLE",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export type AuditStoreStatus = "ok" | "unavailable" | "unknown";

export interface SsoChangeStore {
  /** Connection check, cached ~5 s. Never throws. */
  ready(): Promise<boolean>;
  /** Last known state without waiting (probes must not hang on a dead database); kicks a refresh when stale. */
  status(): AuditStoreStatus;
  recordEvent(event: NewEvent): Promise<void>;
  findByKey(idempotencyKey: string): Promise<ChangeRecord | undefined>;
  submit(input: SubmitInput): Promise<{ record: ChangeRecord; replay: boolean }>;
  /** Updates the request and appends the matching event in ONE transaction. */
  transition(id: string, stage: ChangeStage, fields: TransitionFields, event?: { reason?: string; detail?: unknown }): Promise<ChangeRecord>;
  get(id: string): Promise<ChangeRecord | undefined>;
}

// D-MSSO-9: constant key of pg_advisory_xact_lock. Any bigint works as long as every submit path uses the same
// one; it serializes check-and-insert across Manager replicas. It is a literal (not a hash) so an operator can
// find it in pg_locks. Cost: submits are serialized (a few ms each, admin-only traffic). The partial unique
// index is the backstop if this lock were ever skipped.
export const SSO_CHANGE_ADVISORY_LOCK_KEY = "8240170001";

const READY_CACHE_MS = 5000;
const POOL_MAX = 4;
const CONNECT_TIMEOUT_MS = 3000;
const STATEMENT_TIMEOUT_MS = 5000;
const ACTIVE_STAGES = ["submitted", "pr_open", "unknown_recovering"];

interface RequestRow {
  id: string;
  stage: ChangeStage;
  file_path: string;
  endpoint: string;
  idempotency_key: string;
  payload_sha256: string;
  base_blob_sha: string;
  source_commit_sha: string;
  patch: { allowedGroups: string[] };
  actor_sub: string;
  actor_username: string | null;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  merge_commit_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: RequestRow): ChangeRecord {
  return {
    id: row.id,
    stage: row.stage,
    filePath: row.file_path,
    endpoint: row.endpoint,
    idempotencyKey: row.idempotency_key,
    payloadSha256: row.payload_sha256,
    baseBlobSha: row.base_blob_sha,
    sourceCommitSha: row.source_commit_sha,
    patch: row.patch,
    actorSub: row.actor_sub,
    actorUsername: row.actor_username,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    mergeCommitSha: row.merge_commit_sha,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const INSERT_EVENT_SQL = `INSERT INTO sso_change_event
  (request_id, stage, actor_sub, actor_username, endpoint, idempotency_key, base_blob_sha, payload_sha256,
   pr_number, pr_url, merge_commit_sha, reason, detail)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;

function eventParams(e: NewEvent): unknown[] {
  return [
    e.requestId ?? null,
    e.stage,
    e.actorSub,
    e.actorUsername ?? null,
    e.endpoint ?? null,
    e.idempotencyKey ?? null,
    e.baseBlobSha ?? null,
    e.payloadSha256 ?? null,
    e.prNumber ?? null,
    e.prUrl ?? null,
    e.mergeCommitSha ?? null,
    e.reason ?? null,
    e.detail === undefined ? null : JSON.stringify(e.detail),
  ];
}

export class PgSsoChangeStore implements SsoChangeStore {
  private pool: pg.Pool | undefined;
  private readyAt = 0;
  private lastReady = false;
  private known = false;
  private poolFingerprint: string | undefined;
  private probing: Promise<boolean> | undefined;

  /**
   * poolSource may throw (for example the CA file is not mounted yet); it is retried on the next call.
   * trustFingerprint identifies the CA the pool was built with (the CA file mtime): CNPG rotates its CA, so when it
   * changes the pool is rebuilt (the old one ends gracefully) instead of verifying against a stale anchor forever.
   */
  constructor(
    private readonly poolSource: () => pg.Pool,
    private readonly now: () => number = Date.now,
    private readonly trustFingerprint: () => string | undefined = () => undefined,
  ) {}

  private getPool(): pg.Pool {
    try {
      const fingerprint = this.trustFingerprint();
      if (this.pool && fingerprint !== this.poolFingerprint) this.discardPool();
      if (!this.pool) {
        this.pool = this.poolSource();
        this.poolFingerprint = fingerprint;
      }
      return this.pool;
    } catch (error) {
      throw new StoreError("UNAVAILABLE", "audit store pool could not be created", error);
    }
  }

  /** The next call builds a fresh pool (re-reading the CA). In-flight queries finish; end() waits for checked-out clients. */
  private discardPool(): void {
    const old = this.pool;
    this.pool = undefined;
    old?.end().catch(() => undefined);
  }

  private async run<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
    try {
      return await fn(this.getPool());
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (isTlsVerificationError(error)) this.discardPool();
      // Contractual distrust: the driver error may carry connection details; keep it as `cause` for logs only.
      throw new StoreError("UNAVAILABLE", "audit store unavailable", error);
    }
  }

  ready(): Promise<boolean> {
    if (this.known && this.now() - this.readyAt < READY_CACHE_MS) return Promise.resolve(this.lastReady);
    this.probing ??= this.probe().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  status(): AuditStoreStatus {
    if (!this.known || this.now() - this.readyAt >= READY_CACHE_MS) void this.ready();
    return !this.known ? "unknown" : this.lastReady ? "ok" : "unavailable";
  }

  private async probe(): Promise<boolean> {
    let ok = false;
    try {
      await this.getPool().query("SELECT 1");
      ok = true;
    } catch (error) {
      ok = false;
      if (isTlsVerificationError(error)) this.discardPool();
    }
    this.lastReady = ok;
    this.known = true;
    this.readyAt = this.now();
    return ok;
  }

  async recordEvent(event: NewEvent): Promise<void> {
    await this.run((pool) => pool.query(INSERT_EVENT_SQL, eventParams(event)));
  }

  async findByKey(idempotencyKey: string): Promise<ChangeRecord | undefined> {
    const res = await this.run((pool) =>
      pool.query<RequestRow>("SELECT * FROM sso_change_requests WHERE idempotency_key = $1", [idempotencyKey]),
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async get(id: string): Promise<ChangeRecord | undefined> {
    const res = await this.run((pool) => pool.query<RequestRow>("SELECT * FROM sso_change_requests WHERE id = $1", [id]));
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }

  async submit(input: SubmitInput): Promise<{ record: ChangeRecord; replay: boolean }> {
    return this.run(async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [SSO_CHANGE_ADVISORY_LOCK_KEY]);

        const existing = await client.query<RequestRow>("SELECT * FROM sso_change_requests WHERE idempotency_key = $1", [
          input.idempotencyKey,
        ]);
        const found = existing.rows[0];
        if (found) {
          await client.query("ROLLBACK");
          if (found.payload_sha256 !== input.payloadSha256) {
            throw new StoreError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was used with a different payload");
          }
          return { record: toRecord(found), replay: true };
        }

        const active = await client.query("SELECT 1 FROM sso_change_requests WHERE file_path = $1 AND stage = ANY($2) LIMIT 1", [
          input.filePath,
          ACTIVE_STAGES,
        ]);
        if (active.rowCount && active.rowCount > 0) {
          await client.query("ROLLBACK");
          throw new StoreError("OPEN_REQUEST_EXISTS", "An SSO change request is already open");
        }

        const inserted = await client.query<RequestRow>(
          `INSERT INTO sso_change_requests
             (stage, file_path, endpoint, idempotency_key, payload_sha256, base_blob_sha, source_commit_sha, patch,
              actor_sub, actor_username, branch)
           VALUES ('submitted',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            input.filePath,
            input.endpoint,
            input.idempotencyKey,
            input.payloadSha256,
            input.baseBlobSha,
            input.sourceCommitSha,
            JSON.stringify({ allowedGroups: input.allowedGroups }),
            input.actorSub,
            input.actorUsername ?? null,
            input.branch,
          ],
        );
        const row = inserted.rows[0] as RequestRow;
        await client.query(
          INSERT_EVENT_SQL,
          eventParams({
            requestId: row.id,
            stage: "submitted",
            actorSub: input.actorSub,
            actorUsername: input.actorUsername ?? null,
            endpoint: input.endpoint,
            idempotencyKey: input.idempotencyKey,
            baseBlobSha: input.baseBlobSha,
            payloadSha256: input.payloadSha256,
            reason: input.reason ?? null,
            detail: { branch: input.branch, sourceCommitSha: input.sourceCommitSha, allowedGroups: input.allowedGroups },
          }),
        );
        await client.query("COMMIT");
        return { record: toRecord(row), replay: false };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined); // no-op if already rolled back
        // 23505 on the partial unique index = the DB-level backstop of the one-active-request rule.
        if (isPgError(error, "23505") && String((error as { constraint?: string }).constraint).includes("one_active")) {
          throw new StoreError("OPEN_REQUEST_EXISTS", "An SSO change request is already open", error);
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async transition(
    id: string,
    stage: ChangeStage,
    fields: TransitionFields,
    event: { reason?: string; detail?: unknown } = {},
  ): Promise<ChangeRecord> {
    return this.run(async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query<RequestRow>(
          `UPDATE sso_change_requests SET stage = $2,
             pr_number = COALESCE($3, pr_number), pr_url = COALESCE($4, pr_url),
             merge_commit_sha = COALESCE($5, merge_commit_sha), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, stage, fields.prNumber ?? null, fields.prUrl ?? null, fields.mergeCommitSha ?? null],
        );
        const row = updated.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          throw new StoreError("UNAVAILABLE", "change request not found");
        }
        await client.query(
          INSERT_EVENT_SQL,
          eventParams({
            requestId: row.id,
            stage,
            actorSub: row.actor_sub,
            actorUsername: row.actor_username,
            endpoint: row.endpoint,
            idempotencyKey: row.idempotency_key,
            baseBlobSha: row.base_blob_sha,
            payloadSha256: row.payload_sha256,
            prNumber: row.pr_number,
            prUrl: row.pr_url,
            mergeCommitSha: row.merge_commit_sha,
            reason: event.reason ?? null,
            detail: event.detail,
          }),
        );
        await client.query("COMMIT");
        return toRecord(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }
}

const TLS_VERIFICATION_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isTlsVerificationError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && TLS_VERIFICATION_CODES.has(code);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

// D-MSSO-11: TLS verify-full against the CNPG CA (Node checks the certificate chain and, via servername, the host
// name; there is deliberately no switch to disable it). The password is read from the mounted file on every new
// connection so a rotated Secret is picked up without a restart. A missing user, password or CA means "not ready":
// this throws (StoreError UNAVAILABLE upstream) and never falls back to a connection without TLS or a password.
export function createPgPool(config: AuditDbConfig): pg.Pool {
  if (!config.user) throw new Error("MANAGER_DB_USER is not set (Secret manager-db-writer missing?)");
  const readPassword = (): string => {
    const password = fs.readFileSync(config.passwordFile, "utf8").replace(/[\r\n]+$/, "");
    if (password === "") throw new Error("audit DB password file is empty");
    return password;
  };
  readPassword(); // fail now, not at the first connection, when the Secret is not mounted
  const ca = fs.readFileSync(config.sslCaFile, "utf8");
  if (ca.trim() === "") throw new Error("audit DB CA file is empty");
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: async () => readPassword(),
    ssl: { ca, servername: config.host, rejectUnauthorized: true },
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    application_name: "beluga-manager",
  });
  // An idle client dying must not crash the process (pg emits 'error' on the pool).
  pool.on("error", (error) => console.error("[audit-store] idle client error:", error.message));
  return pool;
}

/** CA file mtime; undefined when the file is missing (getPool then fails in createPgPool, i.e. not ready). */
export function caFingerprint(caFile: string): string | undefined {
  try {
    return String(fs.statSync(caFile).mtimeMs);
  } catch {
    return undefined;
  }
}

export function createPgSsoChangeStore(config: AuditDbConfig): PgSsoChangeStore {
  return new PgSsoChangeStore(
    () => createPgPool(config),
    Date.now,
    () => caFingerprint(config.sslCaFile),
  );
}
