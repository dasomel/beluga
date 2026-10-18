// Integration test against a REAL Postgres (D-MSSO-9/11). MANAGER_TEST_DATABASE_URL must point at a superuser
// connection, e.g. postgres://postgres:pw@127.0.0.1:55432/postgres. The chart's migration SQL is applied from its
// repo path (single source of the schema), as manager_owner, twice (idempotency), and everything else runs as
// manager_writer, exactly the privileges the Manager has in the cluster.
// Unset: skipped locally; with CI set the suite FAILS (a silently skipped integration test proves nothing).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSsoChangeStore, StoreError, type SubmitInput } from "../../src/store/ssoChangeStore.js";

const SUPER_URL = process.env["MANAGER_TEST_DATABASE_URL"];
const MIGRATION = path.resolve(__dirname, "../../../../../gitops/charts/beluga-platform/files/manager-db/migrations/0001_sso_change.sql");
const FILE = "gitops/values/sso.yaml";

if (SUPER_URL === undefined && process.env["CI"]) {
  describe("store.pg (real Postgres)", () => {
    it("MANAGER_TEST_DATABASE_URL must be set in CI", () => {
      throw new Error("MANAGER_TEST_DATABASE_URL is not set but CI is: the integration test would be silently skipped");
    });
  });
}

describe.skipIf(SUPER_URL === undefined)("store.pg (real Postgres)", () => {
  const dbName = `m3_${randomBytes(6).toString("hex")}`;
  let superPool: pg.Pool;
  let ownerPool: pg.Pool;
  let writerPool: pg.Pool;
  let store: PgSsoChangeStore;
  let n = 0;

  const urlFor = (user: string, password: string, db: string): string => {
    const u = new URL(SUPER_URL as string);
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };
  const input = (over: Partial<SubmitInput> = {}): SubmitInput => {
    n++;
    return {
      filePath: FILE,
      endpoint: "flink",
      idempotencyKey: n.toString(16).padStart(32, "0"),
      payloadSha256: "p".repeat(64),
      baseBlobSha: "a".repeat(40),
      sourceCommitSha: "b".repeat(40),
      allowedGroups: ["admins", "engineers"],
      actorSub: "u-admin",
      actorUsername: "alice",
      branch: `sso/flink-${n}`,
      ...over,
    };
  };
  const reset = async () => {
    await ownerPool.query("TRUNCATE sso_change_event, sso_change_requests");
  };

  beforeAll(async () => {
    superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 });
    for (const role of ["manager_owner", "manager_writer"]) {
      await superPool.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'pw'; END IF; END $$`,
      );
    }
    await superPool.query(`CREATE DATABASE ${dbName} OWNER manager_owner`);
    ownerPool = new pg.Pool({ connectionString: urlFor("manager_owner", "pw", dbName), max: 2 });
    ownerPool.on("error", () => undefined); // DROP DATABASE ... FORCE at teardown may cut idle clients
    const sql = fs.readFileSync(MIGRATION, "utf8");
    await ownerPool.query(sql);
    await ownerPool.query(sql); // every Job run applies it again
    writerPool = new pg.Pool({ connectionString: urlFor("manager_writer", "pw", dbName), max: 4 });
    writerPool.on("error", () => undefined);
    store = new PgSsoChangeStore(() => writerPool);
  });

  afterAll(async () => {
    await writerPool?.end();
    await ownerPool?.end();
    await superPool?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await superPool?.end();
  });

  it("migration is idempotent and the writer can connect", async () => {
    expect(await store.ready()).toBe(true);
    await ownerPool.query(fs.readFileSync(MIGRATION, "utf8"));
  });

  it("writer cannot UPDATE, DELETE or TRUNCATE the audit table, nor create objects", async () => {
    await reset();
    await store.recordEvent({ stage: "denied", actorSub: "u-x" });
    for (const sql of [
      "UPDATE sso_change_event SET stage = 'failed'",
      "DELETE FROM sso_change_event",
      "TRUNCATE sso_change_event",
      "DELETE FROM sso_change_requests",
      "TRUNCATE sso_change_requests",
      "CREATE TABLE public.evil (x int)",
      "ALTER TABLE sso_change_event ADD COLUMN x int",
      "DROP TABLE sso_change_event",
    ]) {
      await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: "42501" });
    }
    const rows = await writerPool.query("SELECT count(*)::int AS c FROM sso_change_event");
    expect(rows.rows[0].c).toBe(1);
  });

  it("writer cannot forge generated columns or create TEMP tables", async () => {
    for (const sql of [
      "INSERT INTO sso_change_event (id, stage, actor_sub) OVERRIDING SYSTEM VALUE VALUES (999, 'denied', 'u')",
      "INSERT INTO sso_change_event (stage, actor_sub, created_at) VALUES ('denied', 'u', '2000-01-01')",
      "CREATE TEMP TABLE t_evil (x int)",
    ]) {
      await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("applying the migration again converges a drifted writer grant (table-level INSERT is revoked)", async () => {
    await ownerPool.query("GRANT INSERT ON sso_change_event TO manager_writer");
    await ownerPool.query(fs.readFileSync(MIGRATION, "utf8"));
    await expect(
      writerPool.query("INSERT INTO sso_change_event (stage, actor_sub, created_at) VALUES ('denied', 'u', '2000-01-01')"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the stage CHECK rejects unknown stages in both tables", async () => {
    await expect(writerPool.query("INSERT INTO sso_change_event (stage, actor_sub) VALUES ('bogus','u')")).rejects.toMatchObject({ code: "23514" });
    await expect(store.transition("00000000-0000-0000-0000-000000000000", "failed", {})).rejects.toBeInstanceOf(StoreError);
  });

  it("records denied/previewed events without a request id", async () => {
    await reset();
    await store.recordEvent({ stage: "denied", actorSub: "u-x", detail: { method: "POST" } });
    await store.recordEvent({ stage: "previewed", actorSub: "u-admin", endpoint: "flink", detail: { after: ["admins"] } });
    const res = await writerPool.query("SELECT stage, request_id, detail FROM sso_change_event ORDER BY id");
    expect(res.rows.map((r) => r.stage)).toEqual(["denied", "previewed"]);
    expect(res.rows.every((r) => r.request_id === null)).toBe(true);
    expect(res.rows[1].detail).toEqual({ after: ["admins"] });
  });

  it("10 concurrent submits with distinct keys: exactly one wins, the rest get OPEN_REQUEST_EXISTS", async () => {
    await reset();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.submit(input())));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.reason instanceof StoreError && r.reason.code === "OPEN_REQUEST_EXISTS")).toBe(true);
    const counts = await writerPool.query(
      "SELECT (SELECT count(*)::int FROM sso_change_requests) AS r, (SELECT count(*)::int FROM sso_change_event WHERE stage='submitted') AS e",
    );
    expect(counts.rows[0]).toEqual({ r: 1, e: 1 });
  });

  it("10 concurrent submits with the SAME key and payload: one created, nine replays", async () => {
    await reset();
    const same = input();
    const results = await Promise.all(Array.from({ length: 10 }, () => store.submit({ ...same })));
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
  });

  it("replay returns the same record without a new event; another payload is IDEMPOTENCY_MISMATCH", async () => {
    await reset();
    const first = input();
    const created = await store.submit(first);
    expect(created.replay).toBe(false);
    expect(created.record).toMatchObject({ stage: "submitted", endpoint: "flink", patch: { allowedGroups: ["admins", "engineers"] } });
    const again = await store.submit({ ...first });
    expect(again.replay).toBe(true);
    expect(again.record.id).toBe(created.record.id);
    await expect(store.submit({ ...first, payloadSha256: "q".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const events = await writerPool.query("SELECT count(*)::int AS c FROM sso_change_event");
    expect(events.rows[0].c).toBe(1);
    expect((await store.findByKey(first.idempotencyKey))?.id).toBe(created.record.id);
    expect((await store.get(created.record.id))?.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("transition updates the request and appends an event in one transaction; a terminal stage frees the lock", async () => {
    await reset();
    const { record } = await store.submit(input());
    const open = await store.transition(record.id, "pr_open", { prNumber: 7, prUrl: "https://github.com/dasomel/beluga/pull/7" });
    expect(open).toMatchObject({ stage: "pr_open", prNumber: 7 });
    await expect(store.submit(input())).rejects.toMatchObject({ code: "OPEN_REQUEST_EXISTS" });
    await store.transition(record.id, "failed", {}, { reason: "git conflict" });
    expect((await store.get(record.id))?.prNumber).toBe(7); // COALESCE keeps earlier fields
    await expect(store.submit(input())).resolves.toMatchObject({ replay: false });
    const events = await writerPool.query("SELECT stage, pr_number, reason FROM sso_change_event WHERE request_id = $1 ORDER BY id", [record.id]);
    expect(events.rows).toEqual([
      { stage: "submitted", pr_number: null, reason: null },
      { stage: "pr_open", pr_number: 7, reason: null },
      { stage: "failed", pr_number: 7, reason: "git conflict" },
    ]);
  });

  it("the partial unique index is a backstop even without the advisory lock", async () => {
    await reset();
    const insert = (key: string) =>
      writerPool.query(
        `INSERT INTO sso_change_requests (stage, file_path, endpoint, idempotency_key, payload_sha256, base_blob_sha, source_commit_sha, patch, actor_sub, branch)
         VALUES ('submitted', $1, 'flink', $2, 'p', 'b', 'c', '{}', 'u', 'br')`,
        [FILE, key],
      );
    await insert("k1");
    await expect(insert("k2")).rejects.toMatchObject({ code: "23505" });
    await ownerPool.query("UPDATE sso_change_requests SET stage = 'failed'");
    await expect(insert("k3")).resolves.toBeDefined();
  });

  it("ready() is false when the database is unreachable and never throws", async () => {
    const dead = new pg.Pool({ connectionString: urlFor("manager_writer", "pw", dbName).replace(/:\d+\//, ":1/"), connectionTimeoutMillis: 500 });
    const deadStore = new PgSsoChangeStore(() => dead);
    expect(await deadStore.ready()).toBe(false);
    expect(deadStore.status()).toBe("unavailable");
    await expect(deadStore.recordEvent({ stage: "denied", actorSub: "u" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await dead.end();
  });
});
