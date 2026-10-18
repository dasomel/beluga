import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { gitBlobSha } from "../src/adapters/sso/ssoAdapter.js";
import { ssoChangePreviewSchema, ssoChangeRecordSchema } from "../src/schema/ssoChange.js";
import { StoreError } from "../src/store/ssoChangeStore.js";
import { FakeAdapter, FakeGitWriter, FakeStore, KEY_A, KEY_B, fakeVerifier } from "./helpers/ssoChange.js";

const URL_ = "/api/v1/sso/change-requests";
const BODY = { endpoint: "flink", allowedGroups: ["admins", "analysts"], reason: "analysts need the Flink UI" };

let store: FakeStore;
let writer: FakeGitWriter;
let adapter: FakeAdapter;

function appWith(opts: { writeEnabled?: boolean; gitWriter?: FakeGitWriter | undefined; store?: FakeStore | undefined } = {}) {
  return createApp(undefined, undefined, undefined, undefined, adapter, fakeVerifier, {
    store: "store" in opts ? opts.store : store,
    gitWriter: "gitWriter" in opts ? opts.gitWriter : writer,
    writeEnabled: opts.writeEnabled ?? true,
  });
}

function call(
  app: ReturnType<typeof appWith>,
  opts: { token?: string | null; dryRun?: boolean; key?: string | null; body?: unknown; method?: string; path?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers["Authorization"] = `Bearer ${opts.token ?? "admin"}`;
  if (opts.key !== null && opts.dryRun !== true) headers["Idempotency-Key"] = opts.key ?? KEY_A;
  const url = (opts.path ?? URL_) + (opts.dryRun ? "?dryRun=true" : "");
  return app.request(url, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.method === "GET" ? {} : { body: JSON.stringify(opts.body ?? BODY) }),
  });
}

async function preview(app = appWith()) {
  const res = await call(app, { dryRun: true });
  expect(res.status).toBe(200);
  return ssoChangePreviewSchema.parse(await res.json());
}
const submitBody = async () => ({ ...BODY, baseBlobSha: (await preview()).baseBlobSha });

beforeEach(() => {
  store = new FakeStore();
  writer = new FakeGitWriter();
  adapter = new FakeAdapter();
});

describe("gates (order: 401 -> 403 -> 503 CONSUMER_NOT_DEPLOYED -> 503 AUDIT_UNAVAILABLE)", () => {
  it("401 without or with a bad token", async () => {
    expect((await call(appWith(), { token: null })).status).toBe(401);
    expect((await call(appWith(), { token: "garbage" })).status).toBe(401);
  });

  it("403 for a non-admin, with an audit row, and still 403 when the store is down", async () => {
    const res = await call(appWith(), { token: "engineer", dryRun: true });
    expect(res.status).toBe(403);
    expect(store.events).toMatchObject([{ stage: "denied", actorSub: "u-eng" }]);

    store.down = true;
    const down = await call(appWith(), { token: "engineer", dryRun: true, body: { nonsense: true } });
    expect(down.status).toBe(403);
    expect(adapter.readCalls).toHaveLength(0);
  });

  it("throttles denied rows per subject", async () => {
    const app = appWith();
    for (let i = 0; i < 5; i++) await call(app, { token: "engineer", dryRun: true });
    expect(store.events.filter((e) => e.stage === "denied")).toHaveLength(1);
  });

  it("503 CONSUMER_NOT_DEPLOYED when the switch is off (no store call, no source read)", async () => {
    const res = await call(appWith({ writeEnabled: false }), { dryRun: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "CONSUMER_NOT_DEPLOYED" } });
    expect(store.writes).toBe(0);
    expect(adapter.readCalls).toHaveLength(0);
  });

  it("503 AUDIT_UNAVAILABLE when the store is down or not configured, with zero git calls", async () => {
    store.down = true;
    for (const dryRun of [true, false]) {
      const res = await call(appWith(), { dryRun, body: { ...BODY, baseBlobSha: "a".repeat(40) } });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
    }
    expect(writer.calls).toHaveLength(0);
    const none = await call(appWith({ store: undefined }), { dryRun: true });
    expect(await none.json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
  });

  it("gates run before body validation (a non-admin with a bad body still gets 403)", async () => {
    const res = await call(appWith(), { token: "engineer", dryRun: true, body: { endpoint: 5 } });
    expect(res.status).toBe(403);
  });
});

describe("preview (dryRun=true)", () => {
  it("returns the semantic preview and writes a previewed event before answering", async () => {
    const p = await preview();
    expect(p).toMatchObject({
      endpoint: "flink",
      before: ["admins", "engineers"],
      after: ["admins", "analysts"],
      sourceCommitSha: adapter.commitSha,
    });
    expect(p.baseBlobSha).toBe(gitBlobSha(adapter.text));
    expect(p.diff).toContain('+        - "analysts"');
    expect(store.events).toMatchObject([{ stage: "previewed", actorSub: "u-admin", endpoint: "flink", baseBlobSha: p.baseBlobSha }]);
    expect(adapter.readCalls).toEqual([{ fresh: false }]);
  });

  it("503 AUDIT_UNAVAILABLE when the previewed row cannot be written", async () => {
    store.recordEvent = async () => {
      throw new StoreError("UNAVAILABLE", "x");
    };
    const res = await call(appWith(), { dryRun: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
  });

  it("422 NO_EFFECTIVE_CHANGE, PATCH_REJECTED and 400 for a malformed body", async () => {
    const same = await call(appWith(), { dryRun: true, body: { endpoint: "flink", allowedGroups: ["engineers", "admins"] } });
    expect(same.status).toBe(422);
    expect(await same.json()).toMatchObject({ error: { code: "NO_EFFECTIVE_CHANGE" } });
    const bad = await call(appWith(), { dryRun: true, body: { endpoint: "argocd", allowedGroups: ["admins"] } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: { code: "PATCH_REJECTED" } });
    const shape = await call(appWith(), { dryRun: true, body: { endpoint: "flink" } });
    expect(shape.status).toBe(400);
    const extra = await call(appWith(), { dryRun: true, body: { ...BODY, path: "x" } });
    expect(extra.status).toBe(400);
    expect(store.events).toHaveLength(0);
  });
});

describe("submit", () => {
  it("opens a PR through the writer, records submitted then pr_open, and returns the record", async () => {
    const res = await call(appWith(), { body: await submitBody() });
    expect(res.status).toBe(201);
    const rec = ssoChangeRecordSchema.parse(await res.json());
    expect(rec).toMatchObject({
      stage: "pr_open",
      endpoint: "flink",
      branch: "sso/flink-3f9a1c7e5b2d",
      pr: { number: 42 },
      patch: { allowedGroups: ["admins", "analysts"] },
    });
    expect(rec.diff).toContain("analysts");
    expect(adapter.readCalls.at(-1)).toEqual({ fresh: true });
    expect(writer.calls).toHaveLength(1);
    const sent = writer.calls[0]!;
    expect(sent).toMatchObject({ branch: "sso/flink-3f9a1c7e5b2d", baseCommitSha: adapter.commitSha, path: "gitops/values/sso.yaml" });
    expect(sent.content).toContain('- "analysts"');
    expect(sent.body).toContain("Requested-by: alice (u\\-admin)");
    expect(store.events.map((e) => e.stage)).toEqual(["previewed", "submitted", "pr_open"]);
  });

  it("escapes the reason in the PR body", async () => {
    const body = { ...(await submitBody()), reason: "[click](http://evil) @everyone\n# heading `x`" };
    expect((await call(appWith(), { body })).status).toBe(201);
    const text = writer.calls[0]!.body;
    expect(text).not.toContain("[click](");
    expect(text).toContain("\\[click\\]\\(http");
    expect(text).toContain("\\@everyone \\# heading");
  });

  it("503 GIT_WRITER_UNCONFIGURED with zero database writes", async () => {
    const res = await call(appWith({ gitWriter: undefined }), { body: { ...BODY, baseBlobSha: gitBlobSha(adapter.text) } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "GIT_WRITER_UNCONFIGURED" } });
    expect(store.writes).toBe(0);
    expect(store.requests.size).toBe(0);
  });

  it("400 for a missing or malformed Idempotency-Key and for a missing baseBlobSha", async () => {
    const body = await submitBody();
    expect((await call(appWith(), { body, key: null })).status).toBe(400);
    expect((await call(appWith(), { body, key: "NOT-HEX" })).status).toBe(400);
    expect((await call(appWith(), { body: BODY })).status).toBe(400);
    expect(writer.calls).toHaveLength(0);
  });

  it("409 STALE_BASE when sso.yaml changed after the preview, with no database row", async () => {
    const body = await submitBody();
    adapter.setText(adapter.text.replace("# Header comment", "# Header comment (edited)"));
    store.writes = 0;
    const res = await call(appWith(), { body });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "STALE_BASE" } });
    expect(store.writes).toBe(0);
    expect(writer.calls).toHaveLength(0);
  });

  it("replays the same key and payload without a second PR or event", async () => {
    const body = await submitBody();
    const first = ssoChangeRecordSchema.parse(await (await call(appWith(), { body })).json());
    const eventsAfterFirst = store.events.length;
    const res = await call(appWith(), { body });
    expect(res.status).toBe(200);
    expect(ssoChangeRecordSchema.parse(await res.json()).id).toBe(first.id);
    expect(writer.calls).toHaveLength(1);
    expect(store.events).toHaveLength(eventsAfterFirst);
  });

  it("replay still answers after main moved on (the PR may be merged by now)", async () => {
    const body = await submitBody();
    const first = ssoChangeRecordSchema.parse(await (await call(appWith(), { body })).json());
    adapter.setText(adapter.text.replace('- "engineers"', '- "analysts"'));
    const res = await call(appWith(), { body });
    expect(res.status).toBe(200);
    expect(ssoChangeRecordSchema.parse(await res.json()).id).toBe(first.id);
  });

  it("422 IDEMPOTENCY_MISMATCH for the same key with another payload", async () => {
    const body = await submitBody();
    await call(appWith(), { body });
    const res = await call(appWith(), { body: { ...body, allowedGroups: ["admins", "engineers", "analysts"] } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "IDEMPOTENCY_MISMATCH" } });
  });

  it("409 OPEN_REQUEST_EXISTS for a second key while one request is active", async () => {
    const body = await submitBody();
    expect((await call(appWith(), { body })).status).toBe(201);
    const res = await call(appWith(), { body, key: KEY_B });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "OPEN_REQUEST_EXISTS" } });
    expect(writer.calls).toHaveLength(1);
  });

  it("git conflict -> failed + 409; rejected -> failed + 502; unknown/throw -> unknown_recovering + 502", async () => {
    const cases = [
      ["conflict", 409, "STALE_BASE", "failed"],
      ["rejected", 502, "GIT_WRITE_FAILED", "failed"],
      ["unknown", 502, "GIT_WRITE_UNKNOWN", "unknown_recovering"],
      ["throw", 502, "GIT_WRITE_UNKNOWN", "unknown_recovering"],
    ] as const;
    for (const [outcome, status, code, stage] of cases) {
      store = new FakeStore();
      writer = new FakeGitWriter();
      writer.outcome = outcome;
      const res = await call(appWith(), { body: await submitBody() });
      expect(res.status, outcome).toBe(status);
      expect(await res.json()).toMatchObject({ error: { code } });
      expect([...store.requests.values()][0]?.stage, outcome).toBe(stage);
    }
  });

  it("a failed request releases the lock for the next key", async () => {
    writer.outcome = "rejected";
    const body = await submitBody();
    expect((await call(appWith(), { body })).status).toBe(502);
    writer.outcome = "ok";
    expect((await call(appWith(), { body, key: KEY_B })).status).toBe(201);
  });
});

describe("GET /sso/change-requests/{id}", () => {
  it("returns the record to admins, 404 for unknown ids, 400 for a bad id, 403 for others", async () => {
    const created = ssoChangeRecordSchema.parse(await (await call(appWith(), { body: await submitBody() })).json());
    const get = (id: string, token = "admin") => call(appWith(), { method: "GET", path: `${URL_}/${id}`, token });
    expect((await get(created.id)).status).toBe(200);
    expect((await get("0b6f6f0e-2a3c-4a53-9f1d-0d0c2f4e9a11")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(400);
    expect((await get(created.id, "engineer")).status).toBe(403);
    store.down = true;
    expect((await get(created.id)).status).toBe(503);
  });

  it("is not blocked by SSO_WRITE_ENABLED=false (read of an existing record)", async () => {
    const created = ssoChangeRecordSchema.parse(await (await call(appWith(), { body: await submitBody() })).json());
    const res = await call(appWith({ writeEnabled: false }), { method: "GET", path: `${URL_}/${created.id}` });
    expect(res.status).toBe(200);
  });
});

describe("health", () => {
  it("reports the audit store as a component and never fails the probe", async () => {
    expect(await (await appWith().request("/api/v1/health")).json()).toMatchObject({ status: "healthy", components: { auditStore: "ok" } });
    store.down = true;
    const res = await appWith().request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "healthy", components: { auditStore: "unavailable" } });
    expect(await (await appWith({ store: undefined }).request("/api/v1/health")).json()).toMatchObject({
      components: { auditStore: "not-configured" },
    });
  });

  it("GET /sso keeps working with the store down", async () => {
    store.down = true;
    adapter.getSsoConfig = (() => ({ status: "not-configured", configured: false, message: "x" })) as never;
    const res = await call(appWith(), { method: "GET", path: "/api/v1/sso" });
    expect(res.status).toBe(200);
  });
});
