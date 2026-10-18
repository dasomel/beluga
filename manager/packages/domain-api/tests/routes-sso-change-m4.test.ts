// Rollout 4 routes: contract, list open, cancel, health components, and the wiring that leaves the writer undefined
// when the GitHub App Secret is absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { SUBMITTED_GRACE_MS } from "../src/sso-change/reconciler.js";
import { ssoChangeContractSchema, ssoChangeListSchema, ssoChangeRecordSchema } from "../src/schema/ssoChange.js";
import { gitBlobSha } from "../src/adapters/sso/ssoAdapter.js";
import { createAppFromEnv } from "../src/wiring.js";
import { FakeAdapter, FakeGitWriter, FakeStore, KEY_A, KEY_B, PR_URL, fakeVerifier } from "./helpers/ssoChange.js";
import { testKeyPem } from "./helpers/githubMock.js";

const URL_ = "/api/v1/sso/change-requests";
const BRANCH = "sso/flink-3f9a1c7e5b2d";
const BODY = { endpoint: "flink", allowedGroups: ["admins", "analysts"] };

let store: FakeStore;
let writer: FakeGitWriter;
let adapter: FakeAdapter;

function appWith(opts: { writeEnabled?: boolean; gitWriter?: FakeGitWriter | undefined; store?: FakeStore | undefined; argocd?: boolean } = {}) {
  return createApp(undefined, undefined, undefined, undefined, adapter, fakeVerifier, {
    store: "store" in opts ? opts.store : store,
    gitWriter: "gitWriter" in opts ? opts.gitWriter : writer,
    argocdReader: opts.argocd ? { getApplication: async () => ({ name: "x", syncStatus: "Synced", revision: undefined }) } : undefined,
    writeEnabled: opts.writeEnabled ?? true,
  });
}
function req(app: ReturnType<typeof appWith>, method: string, p: string, opts: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers["Authorization"] = `Bearer ${opts.token ?? "admin"}`;
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  return app.request(p, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : opts.raw !== undefined ? { body: opts.raw } : {}) });
}
async function submit(key = KEY_A) {
  const app = appWith();
  const pre = await app.request(`${URL_}?dryRun=true`, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
  const { baseBlobSha } = (await pre.json()) as { baseBlobSha: string };
  const res = await app.request(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer admin", "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ ...BODY, baseBlobSha }),
  });
  expect(res.status).toBe(201);
  return ssoChangeRecordSchema.parse(await res.json());
}

beforeEach(() => {
  store = new FakeStore();
  writer = new FakeGitWriter();
  adapter = new FakeAdapter();
});

describe("GET /sso/change-requests/contract", () => {
  it("returns the edit contract from main without writing an audit row", async () => {
    const res = await req(appWith(), "GET", `${URL_}/contract`);
    expect(res.status).toBe(200);
    const body = ssoChangeContractSchema.parse(await res.json());
    expect(body).toEqual({
      editableEndpoints: ["flink", "filer"],
      field: "allowedGroups",
      requiredGroups: ["admins"],
      availableGroups: expect.arrayContaining(["admins", "engineers", "analysts"]),
      current: { flink: ["admins", "engineers"], filer: null },
      sourceCommitSha: adapter.commitSha,
      baseBlobSha: gitBlobSha(adapter.text),
      gitWriterConfigured: true,
    });
    expect(store.events).toHaveLength(0);
    expect(store.writes).toBe(0);
    expect(adapter.readCalls).toEqual([{ fresh: undefined }]);
  });

  it("reports gitWriterConfigured=false without a writer", async () => {
    const body = (await (await req(appWith({ gitWriter: undefined }), "GET", `${URL_}/contract`)).json()) as { gitWriterConfigured: boolean };
    expect(body.gitWriterConfigured).toBe(false);
  });

  it("gates: 401, 403 (with a denied row), 503 CONSUMER_NOT_DEPLOYED, 503 AUDIT_UNAVAILABLE", async () => {
    expect((await req(appWith(), "GET", `${URL_}/contract`, { token: null })).status).toBe(401);
    expect((await req(appWith(), "GET", `${URL_}/contract`, { token: "engineer" })).status).toBe(403);
    expect(store.events).toMatchObject([{ stage: "denied" }]);
    const off = await req(appWith({ writeEnabled: false }), "GET", `${URL_}/contract`);
    expect(await off.json()).toMatchObject({ error: { code: "CONSUMER_NOT_DEPLOYED" } });
    store.down = true;
    const down = await req(appWith(), "GET", `${URL_}/contract`);
    expect(await down.json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
  });

  it("503 SERVICE_UNAVAILABLE when the SSO source cannot back change requests", async () => {
    const noBase = { getSsoConfig: () => { throw new Error("x"); } } as never;
    const app = createApp(undefined, undefined, undefined, undefined, noBase, fakeVerifier, { store, gitWriter: writer, writeEnabled: true });
    const res = await req(app, "GET", `${URL_}/contract`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("is not shadowed by /{id}: 'contract' is never parsed as an id", async () => {
    expect((await req(appWith(), "GET", `${URL_}/contract`)).status).toBe(200);
    expect((await req(appWith(), "GET", `${URL_}/not-a-uuid`)).status).toBe(400);
  });
});

describe("GET /sso/change-requests?status=open", () => {
  it("lists active and merged requests only, newest first, at most 20", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "merged" });
    // 25 more terminal + open rows around it
    for (let i = 0; i < 25; i++) {
      const base = store.requests.get(rec.id)!;
      store.requests.set(`id-${i}`, { ...base, id: `id-${i}`, idempotencyKey: `k${i}`, stage: i < 22 ? "pr_open" : "failed", createdAt: new Date(Date.now() + i * 1000).toISOString() });
    }
    const res = await req(appWith(), "GET", `${URL_}?status=open`);
    expect(res.status).toBe(200);
    const body = ssoChangeListSchema.safeParse(await res.json());
    // ids like "id-0" are not UUIDs, so check the raw shape instead of the strict schema for the oversized case
    const raw = (await (await req(appWith(), "GET", `${URL_}?status=open`)).json()) as { items: { id: string; stage: string }[] };
    expect(body.success).toBe(false);
    expect(raw.items).toHaveLength(20);
    expect(raw.items.every((i) => ["submitted", "pr_open", "unknown_recovering", "merged"].includes(i.stage))).toBe(true);
    expect(raw.items[0]!.id).toBe("id-21");
  });

  it("returns the typed list for real records", async () => {
    const rec = await submit();
    const res = await req(appWith(), "GET", `${URL_}?status=open`);
    const body = ssoChangeListSchema.parse(await res.json());
    expect(body.items).toMatchObject([{ id: rec.id, stage: "pr_open", pr: { number: 42 } }]);
  });

  it("400 for a missing or unsupported status", async () => {
    for (const q of ["", "?status=all", "?status=", "?status=OPEN"]) {
      const res = await req(appWith(), "GET", `${URL_}${q}`);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("gates: 401, 403, 503 x2", async () => {
    expect((await req(appWith(), "GET", `${URL_}?status=open`, { token: null })).status).toBe(401);
    expect((await req(appWith(), "GET", `${URL_}?status=open`, { token: "engineer" })).status).toBe(403);
    expect((await req(appWith({ writeEnabled: false }), "GET", `${URL_}?status=open`)).status).toBe(503);
    store.down = true;
    expect((await req(appWith(), "GET", `${URL_}?status=open`)).status).toBe(503);
  });
});

describe("POST /sso/change-requests/{id}/cancel", () => {
  const cancel = (app: ReturnType<typeof appWith>, id: string, extra: { token?: string | null; body?: unknown; raw?: string } = {}) =>
    req(app, "POST", `${URL_}/${id}/cancel`, extra);
  const UNKNOWN = "0b6f6f0e-2a3c-4a53-9f1d-0d0c2f4e9a11";

  it("closes the open PR (by number), moves to failed with the admin as actor, keeps the branch, and frees the lock", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    store.events.length = 0;
    const res = await cancel(appWith(), rec.id, { body: { reason: "wrong group" } });
    expect(res.status).toBe(200);
    expect(ssoChangeRecordSchema.parse(await res.json())).toMatchObject({ id: rec.id, stage: "failed" });
    expect(writer.closed).toEqual([42]);
    expect(store.events).toMatchObject([
      { stage: "pr_open", actorSub: "u-admin", detail: { cancel: "requested", by: "u-admin" } },
      { stage: "failed", actorSub: "u-admin", reason: "wrong group", detail: { cancelledBy: "u-admin" } },
    ]);
    // lock released: a new key can submit
    expect((await submit(KEY_B)).stage).toBe("pr_open");
  });

  it("works without a body and defaults the reason", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    const res = await cancel(appWith(), rec.id);
    expect(res.status).toBe(200);
    expect(store.events.at(-1)).toMatchObject({ stage: "failed", reason: "cancelled by admin" });
  });

  it("finds the PR by branch when the record has no number (unknown_recovering)", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "unknown_recovering", prNumber: null, prUrl: null });
    writer.prs.set(BRANCH, { number: 77, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    expect((await cancel(appWith(), rec.id)).status).toBe(200);
    expect(writer.closed).toEqual([77]);
  });

  it("a request whose PR was never created (or is already closed) is cancelled without closing anything", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "unknown_recovering", prNumber: null, prUrl: null });
    expect((await cancel(appWith(), rec.id)).status).toBe(200);
    expect(writer.closed).toEqual([]);
  });

  it("404 for an unknown id, 400 for a malformed id or body", async () => {
    expect((await cancel(appWith(), UNKNOWN)).status).toBe(404);
    expect((await cancel(appWith(), "nope")).status).toBe(400);
    const rec = await submit();
    expect((await cancel(appWith(), rec.id, { body: { reason: "x".repeat(501) } })).status).toBe(400);
    expect((await cancel(appWith(), rec.id, { body: { extra: 1 } })).status).toBe(400);
    expect((await cancel(appWith(), rec.id, { raw: "{" })).status).toBe(400);
  });

  it("409 REQUEST_NOT_ACTIVE for merged/applied/rejected/failed requests; nothing is closed or written", async () => {
    const rec = await submit();
    for (const stage of ["merged", "applied", "rejected", "failed"] as const) {
      store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage });
      store.events.length = 0;
      const res = await cancel(appWith(), rec.id);
      expect(res.status, stage).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "REQUEST_NOT_ACTIVE" } });
      expect(store.events).toHaveLength(0);
    }
    expect(writer.closed).toEqual([]);
  });

  it("409 REQUEST_NOT_ACTIVE when the PR was merged in the meantime (the reconciler will record it)", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "closed", merged: true, mergeCommitSha: "e".repeat(40) });
    store.events.length = 0;
    const res = await cancel(appWith(), rec.id);
    expect(res.status).toBe(409);
    expect(store.requests.get(rec.id)!.stage).toBe("pr_open");
    expect(store.events).toMatchObject([{ detail: { cancel: "requested" } }]); // only the audited intent, no transition
  });

  it("409 when the CAS is lost to a racing transition", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    const closePr = writer.closePr.bind(writer);
    writer.closePr = async (n: number) => {
      const pr = await closePr(n);
      store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "rejected" }); // the reconciler saw the closed PR first
      return pr;
    };
    store.events.length = 0;
    const res = await cancel(appWith(), rec.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "REQUEST_NOT_ACTIVE" } });
    expect(store.events).toMatchObject([{ detail: { cancel: "requested" } }]);
  });

  it("503 GIT_WRITER_UNCONFIGURED without a writer, before any lookup", async () => {
    const rec = await submit();
    store.writes = 0;
    const res = await cancel(appWith({ gitWriter: undefined }), rec.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "GIT_WRITER_UNCONFIGURED" } });
    expect(store.writes).toBe(0);
  });

  it("502 GITHUB_UNAVAILABLE when closing fails: lock kept, no transition, an audit event with the CURRENT stage", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    writer.failing.add("closePr");
    store.events.length = 0;
    const res = await cancel(appWith(), rec.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "GITHUB_UNAVAILABLE" } });
    expect(store.requests.get(rec.id)!.stage).toBe("pr_open");
    expect(store.events).toMatchObject([
      { stage: "pr_open", requestId: rec.id, detail: { cancel: "requested" } },
      { stage: "pr_open", requestId: rec.id, actorSub: "u-admin", detail: { cancel: "close_failed", error: expect.any(String) } },
    ]);
    // lock still held
    const again = await appWith().request(URL_, {
      method: "POST",
      headers: { Authorization: "Bearer admin", "content-type": "application/json", "Idempotency-Key": KEY_B },
      body: JSON.stringify({ ...BODY, baseBlobSha: gitBlobSha(adapter.text) }),
    });
    expect(again.status).toBe(409);
  });

  it("502 as well when the PR lookup fails", async () => {
    const rec = await submit();
    writer.failing.add("getPr");
    expect((await cancel(appWith(), rec.id)).status).toBe(502);
    expect(store.requests.get(rec.id)!.stage).toBe("pr_open");
  });

  it("gates: 401, 403, 503 CONSUMER_NOT_DEPLOYED, 503 AUDIT_UNAVAILABLE", async () => {
    const rec = await submit();
    expect((await cancel(appWith(), rec.id, { token: null })).status).toBe(401);
    expect((await cancel(appWith(), rec.id, { token: "engineer" })).status).toBe(403);
    expect(writer.closed).toEqual([]);
    expect(await (await cancel(appWith({ writeEnabled: false }), rec.id)).json()).toMatchObject({ error: { code: "CONSUMER_NOT_DEPLOYED" } });
    store.down = true;
    expect(await (await cancel(appWith(), rec.id)).json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
  });

  it("503 AUDIT_UNAVAILABLE when the database dies after the PR was closed (the reconciler records `rejected` later)", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, { number: 42, url: PR_URL, createdAt: new Date().toISOString(), state: "open", merged: false, mergeCommitSha: null });
    store.failTransitions = true;
    const res = await cancel(appWith(), rec.id);
    expect(res.status).toBe(503);
    expect(writer.closed).toEqual([42]);
  });
});

describe("OpenAPI", () => {
  it("documents contract, list and cancel with their error codes", async () => {
    const doc = (await (await appWith().request("/api/v1/openapi.json")).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { schemas: { ErrorCode: { enum: string[] } } };
    };
    expect(Object.keys(doc.paths[`${URL_}/contract`]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths[`${URL_}`]!)).toEqual(["post", "get"]);
    expect(Object.keys(doc.paths[`${URL_}/{id}/cancel`]!.post!.responses).sort()).toEqual(["200", "400", "401", "403", "404", "409", "500", "502", "503"]);
    expect(doc.components.schemas.ErrorCode.enum).toEqual(expect.arrayContaining(["REQUEST_NOT_ACTIVE", "GITHUB_UNAVAILABLE"]));
  });
});

describe("health components", () => {
  it("reports gitWriter and argocdReader as configured/unconfigured without a live call", async () => {
    const off = await (await appWith({ gitWriter: undefined }).request("/api/v1/health")).json();
    expect(off).toMatchObject({ components: { gitWriter: "unconfigured", argocdReader: "unconfigured" } });
    const on = await (await appWith({ argocd: true }).request("/api/v1/health")).json();
    expect(on).toMatchObject({ status: "healthy", components: { gitWriter: "configured", argocdReader: "configured" } });
    expect(writer.calls).toHaveLength(0);
  });
});

describe("wiring (D-MSSO-15/16/18)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-wiring-"));
  });
  const base = () => ({
    AUTH_MODE: "disabled",
    MANAGER_DB_HOST: "manager-db-rw.platform-system.svc",
    MANAGER_DB_NAME: "manager",
    MANAGER_DB_PASSWORD_FILE: path.join(dir, "pw"),
    MANAGER_DB_SSL_CA_FILE: path.join(dir, "ca"),
    SSO_SOURCE: "file",
  });

  it("no GitHub App env: writer undefined, no reconciler, one diagnostic line without values", () => {
    const wired = createAppFromEnv(base());
    expect(wired.reconciler).toBeUndefined();
    expect(wired.diagnostics.filter((l) => l.includes("GitHub App writer not configured"))).toHaveLength(1);
  });

  it("ids set but the key file is missing, empty or garbage: writer undefined", () => {
    const keyFile = path.join(dir, "private-key.pem");
    const env = { ...base(), GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: keyFile };
    for (const content of [undefined, "", "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n"]) {
      if (content === undefined) fs.rmSync(keyFile, { force: true });
      else fs.writeFileSync(keyFile, content);
      const wired = createAppFromEnv(env);
      expect(wired.reconciler, String(content)).toBeUndefined();
      expect(wired.diagnostics.join("\n")).not.toContain("-----");
    }
  });

  it("non-numeric ids: writer undefined even with a valid key", () => {
    const keyFile = path.join(dir, "k.pem");
    fs.writeFileSync(keyFile, testKeyPem);
    const wired = createAppFromEnv({ ...base(), GITHUB_APP_ID: "abc", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
    expect(wired.reconciler).toBeUndefined();
  });

  it("ids + valid key + audit store: writer wired and a reconciler is created (health says configured)", async () => {
    const keyFile = path.join(dir, "k.pem");
    fs.writeFileSync(keyFile, testKeyPem);
    const wired = createAppFromEnv({ ...base(), GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
    expect(wired.reconciler).toBeDefined();
    expect(wired.diagnostics.join("\n")).not.toContain("GitHub App writer not configured");
    const health = (await (await wired.app.request("/api/v1/health")).json()) as { components: Record<string, string> };
    expect(health.components).toMatchObject({ gitWriter: "configured", argocdReader: "unconfigured" });
  });

  it("a writer without an audit store gets no reconciler", () => {
    const keyFile = path.join(dir, "k.pem");
    fs.writeFileSync(keyFile, testKeyPem);
    const wired = createAppFromEnv({ AUTH_MODE: "disabled", SSO_SOURCE: "file", GITHUB_APP_ID: "12", GITHUB_APP_INSTALLATION_ID: "34", GITHUB_APP_PRIVATE_KEY_FILE: keyFile });
    expect(wired.reconciler).toBeUndefined();
  });

  it("ArgoCD reader: configured only with readable token and CA files; an invalid URL stops startup", () => {
    const token = path.join(dir, "token");
    const ca = path.join(dir, "ca.crt");
    const env = { ...base(), KUBE_API_URL: "https://kubernetes.default.svc", KUBE_API_TOKEN_FILE: token, KUBE_API_CA_FILE: ca };
    expect(createAppFromEnv(env).diagnostics.join("\n")).toContain("ArgoCD reader not configured (service account token or CA file is not readable)");
    fs.writeFileSync(token, "t");
    fs.writeFileSync(ca, "c");
    expect(createAppFromEnv(env).diagnostics.join("\n")).not.toContain("ArgoCD reader not configured");
    expect(() => createAppFromEnv({ ...env, KUBE_API_URL: "http://kubernetes.default.svc" })).toThrow();
  });
});

describe("review fixes (routes)", () => {
  const post = async (key: string) => {
    const app = appWith();
    const pre = await app.request(`${URL_}?dryRun=true`, {
      method: "POST",
      headers: { Authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    const { baseBlobSha } = (await pre.json()) as { baseBlobSha: string };
    return app.request(URL_, {
      method: "POST",
      headers: { Authorization: "Bearer admin", "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ ...BODY, baseBlobSha }),
    });
  };
  const cancel = (id: string) => req(appWith(), "POST", `${URL_}/${id}/cancel`);
  const openPr = (number = 42) => ({ number, url: PR_URL, createdAt: new Date().toISOString(), state: "open" as const, merged: false, mergeCommitSha: null });

  // F1: cancel must not race a submit that is still inside its GitHub call.
  it("cancel of a young `submitted` row is 409 REQUEST_IN_FLIGHT: no audit row, no GitHub call", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "submitted", prNumber: null, prUrl: null, updatedAt: new Date().toISOString() });
    store.events.length = 0;
    writer.touched.length = 0;
    const res = await cancel(rec.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "REQUEST_IN_FLIGHT" } });
    expect(store.events).toHaveLength(0);
    expect(writer.touched).toEqual([]);
    expect(store.requests.get(rec.id)!.stage).toBe("submitted");
  });

  it("an old `submitted` row (submitter presumed dead) can be cancelled", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "submitted", prNumber: null, prUrl: null, updatedAt: new Date(Date.now() - SUBMITTED_GRACE_MS - 1000).toISOString() });
    expect((await cancel(rec.id)).status).toBe(200);
  });

  it("submit whose pr_open CAS loses to a terminal stage closes the PR it just made and audits the compensation", async () => {
    writer.prs.set(BRANCH, openPr());
    const original = writer.createChangePr.bind(writer);
    writer.createChangePr = async (input) => {
      const created = await original(input);
      // Controlled ordering: the request is failed (cancelled) after GitHub answered, before our CAS.
      const [id] = [...store.requests.keys()];
      store.requests.set(id!, { ...store.requests.get(id!)!, stage: "failed" });
      return created;
    };
    const res = await post(KEY_A);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "REQUEST_NOT_ACTIVE" } });
    expect(writer.closed).toEqual([42]);
    expect(store.events.at(-1)).toMatchObject({ stage: "failed", detail: { compensation: "closed_orphan_pr", prNumber: 42 } });
  });

  it("a failed compensation close is logged and audited as such, and the answer is still 409", async () => {
    writer.prs.set(BRANCH, openPr());
    writer.failing.add("closePr");
    const original = writer.createChangePr.bind(writer);
    writer.createChangePr = async (input) => {
      const created = await original(input);
      const [id] = [...store.requests.keys()];
      store.requests.set(id!, { ...store.requests.get(id!)!, stage: "rejected" });
      return created;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post(KEY_A);
    expect(res.status).toBe(409);
    expect(spy.mock.calls.flat().join(" ")).toContain("could not close orphan pull request #42");
    expect(store.events.at(-1)).toMatchObject({ stage: "rejected", detail: { compensation: "close_orphan_pr_failed", prNumber: 42 } });
    spy.mockRestore();
  });

  // F4
  it("a NEW key whose branch equals an earlier row's branch is 409 IDEMPOTENCY_KEY_COLLISION and writes nothing to GitHub", async () => {
    const rec = await submit(KEY_A);
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "failed" }); // lock free, branch taken
    writer.calls.length = 0;
    const res = await post(`${KEY_A.slice(0, 12)}${"0".repeat(20)}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_COLLISION" } });
    expect(writer.calls).toHaveLength(0);
  });

  it("cancel looks a PR up by branch only for PRs created after the request (minus 5 min)", async () => {
    const rec = await submit();
    store.requests.set(rec.id, { ...store.requests.get(rec.id)!, stage: "unknown_recovering", prNumber: null, prUrl: null });
    writer.prs.set(BRANCH, { ...openPr(77), createdAt: new Date(Date.now() - 3_600_000).toISOString() }); // a stale PR of an older request
    expect((await cancel(rec.id)).status).toBe(200);
    expect(writer.closed).toEqual([]);
    expect(writer.notBefores.at(-1)).toBeLessThan(Date.now());
  });

  // F5
  it("cancel is audited BEFORE any GitHub call: a dead audit store means 503 and zero GitHub calls", async () => {
    const rec = await submit();
    writer.prs.set(BRANCH, openPr());
    store.failEventsWhere = (e) => (e.detail as { cancel?: string } | undefined)?.cancel === "requested";
    writer.touched.length = 0;
    const res = await cancel(rec.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "AUDIT_UNAVAILABLE" } });
    expect(writer.touched).toEqual([]);
    expect(writer.closed).toEqual([]);
    expect(store.requests.get(rec.id)!.stage).toBe("pr_open");
  });

  it("documents the new codes", async () => {
    const doc = (await (await appWith().request("/api/v1/openapi.json")).json()) as { components: { schemas: { ErrorCode: { enum: string[] } } } };
    expect(doc.components.schemas.ErrorCode.enum).toEqual(expect.arrayContaining(["REQUEST_IN_FLIGHT", "IDEMPOTENCY_KEY_COLLISION"]));
  });
});
