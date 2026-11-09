import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuditDecisionSource } from "../src/adapters/auditDecisions.js";
import { KubeClient, type KubeRequester } from "../src/adapters/kubeClient.js";
import { KubeResourceSource } from "../src/adapters/kubeResources.js";
import { createRuntime } from "../src/adapters/runtime.js";
import { overviewPolicy } from "../src/adapters/overviewPolicy.generated.js";
import { createApp } from "../src/app.js";
import { createAppFromEnv } from "../src/wiring.js";
import { decisionRecordSchema } from "../src/schema/decision.js";
import { domainApiHealthSchema } from "../src/routes/health.js";
import { policyProjectionSchema } from "../src/schema/policy.js";
import { listResponseSchema } from "../src/schema/envelope.js";
import { resourceSchema } from "../src/schema/resource.js";
import { PgSsoChangeStore } from "../src/store/ssoChangeStore.js";

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-365-"));
  fs.writeFileSync(path.join(dir, "token"), "token");
  fs.writeFileSync(path.join(dir, "ca"), "ca");
  env = { AUTH_MODE: "disabled", KUBE_API_URL: "https://kubernetes.default.svc", KUBE_API_TOKEN_FILE: path.join(dir, "token"), KUBE_API_CA_FILE: path.join(dir, "ca") };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
const events = { listEvents: async () => ({ events: [{ id: "event-1", relatedResourceId: "kubernetes:analytics/Deployment/test" }], warnings: [] }) };
function resources(requester: KubeRequester, timeoutMs = 30) {
  return new KubeResourceSource(new KubeClient({ apiUrl: env.KUBE_API_URL!, tokenFile: env.KUBE_API_TOKEN_FILE!, caFile: env.KUBE_API_CA_FILE!, requester, timeoutMs }), events as never);
}
const table = (cells: unknown[][] = [["test", "2/2", 2, 2, "Complete"]], names = ["Name", "Ready", "Up-to-date", "Available", "Status"]) => ({
  kind: "Table", columnDefinitions: names.map((name) => ({ name })), rows: cells.map((cells) => ({ cells })),
});

it("maps all four namespaces and three collection types, correlates actual event IDs, invents no usage", async () => {
  const paths: string[] = [];
  const source = resources(async ({ url }) => {
    paths.push(url.pathname);
    return response(table());
  });
  const batch = await source.list();
  expect(paths).toHaveLength(12);
  expect(new Set(paths.map((p) => p.split("/")[5]))).toEqual(new Set(["analytics", "lakehouse", "orchestration", "streaming"]));
  expect(batch.items).toHaveLength(12);
  batch.items.forEach((item) => { resourceSchema.parse(item); expect(item.status).toBe("healthy"); expect(item.cpuUsage).toBeNull(); });
  expect(batch.items.find((i) => i.id === "kubernetes:analytics/Deployment/test")?.relatedEventIds).toEqual(["event-1"]);
});
it.each([403, "timeout", "malformed"])("discloses partial resource failure: %s", async (failure) => {
  const source = resources(async ({ url }) => {
    if (url.pathname.endsWith("jobs")) {
      if (failure === "timeout") return new Promise<never>(() => {});
      return failure === "malformed" ? response({}) : { status: 403, body: "{}" };
    }
    return response(table());
  });
  const batch = await source.list();
  expect(batch.items).toHaveLength(8);
  expect(batch.warnings).toHaveLength(4);
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { resourceSource: source, fixtures: "partial" });
  const reply = await app.request("/api/v1/resources?kind=Job");
  expect(reply.status).toBe(200);
  const body = listResponseSchema(resourceSchema, "TestResources").parse(await reply.json());
  expect(body.data).toEqual([]);
  expect(body.warnings).toHaveLength(4);
  expect((await app.request("/api/v1/resources/missing")).status).toBe(500);
  expect((await app.request("/api/v1/resources/" + encodeURIComponent("kubernetes:analytics/Deployment/test"))).status).toBe(200);
});
it("fails closed on total resource outage, never substitutes fixtures", async () => {
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    resourceSource: resources(async () => ({ status: 403, body: "{}" })), fixtures: "partial" });
  expect((await app.request("/api/v1/resources")).status).toBe(500);
});
it("paginates, warns at bound, and preserves inventory if event lookup fails", async () => {
  const client = { getText: vi.fn(), getJson: vi.fn(async () => ({ ...table(), metadata: { continue: "next" } })) };
  const batch = await new KubeResourceSource(client as never, { listEvents: async () => { throw new Error("403"); } }).list();
  expect(client.getJson).toHaveBeenCalledTimes(60);
  expect(client.getJson.mock.calls.length).toBe(60);
  expect(batch.warnings.filter((w) => w.code === "TRUNCATED")).toHaveLength(12);
  expect(batch.warnings.at(-1)?.message).toContain("events unavailable");
});
it.each([
  [["test", "1/2", 1, 1], "degraded", undefined],
  [["test", "0/2", 0, 0], "unavailable", undefined],
  [["test", "0/0", 0, 0], "healthy", "scaled to zero"],
  [["test", "2/2", undefined, undefined], "unknown", undefined],
  [["test", undefined], "unknown", undefined],
])("maps Table readiness and intentional zero: %j", async (cells, expected, detail) => {
  const batch = await resources(async () => response(table([cells]))).list();
  const deployment = batch.items.find((i) => i.id.includes("Deployment"))!;
  expect(deployment.status).toBe(expected);
  expect(deployment.statusDetail).toBe(detail);
});
it.each(["Running", "Complete", "Suspended", "Failed", "Pending", undefined])("maps Job status %s", async (status) => {
  const batch = await resources(async () => response(table([["test", status]], ["Name", "Status"]))).list();
  const job = batch.items.find((i) => i.kind === "Job")!;
  expect(job.status).toBe(status === "Failed" ? "unavailable" : ["Running", "Complete", "Suspended"].includes(status ?? "") ? "healthy" : "unknown");
  expect(job.statusDetail).toBe(status === "Suspended" ? "suspended" : undefined);
});

it("reads append-only audit events with a bounded SELECT and keeps stages without inventing diagnostic confidence", async () => {
  const query = vi.fn(async () => ({ rows: [{ id: "42", request_id: "req", stage: "applied", endpoint: "trino", created_at: new Date("2026-11-09T00:00:00Z") }] }));
  const store = new PgSsoChangeStore(() => ({ query }) as unknown as pg.Pool);
  const batch = await new AuditDecisionSource(store).list();
  expect(query.mock.calls[0]).toEqual([expect.stringContaining("FROM sso_change_event ORDER BY created_at DESC, id DESC LIMIT $1"), [1000]]);
  const record = decisionRecordSchema.parse(batch.items[0]);
  expect(record.audit?.stage).toBe("applied");
  expect(record.result).toMatchObject({ decision: "ABSTAIN", confidence: 0, provider: "manager-audit-db" });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, { verify: async () => ({ sub: "admin", groups: ["admins"] }) }, undefined, { decisionSource: new AuditDecisionSource(store), decisionsRequireAdmins: true, fixtures: "partial" });
  expect(decisionRecordSchema.parse(await (await app.request("/api/v1/decisions/audit-42", { headers: { Authorization: "Bearer admin" } })).json()).audit?.stage).toBe("applied");
  expect(listResponseSchema(decisionRecordSchema, "TestDecisions").parse(await (await app.request("/api/v1/decisions?decision=NORMAL", { headers: { Authorization: "Bearer admin" } })).json()).data).toEqual([]);
});

it("restricts audit-backed decision list and detail to admins while leaving stub decisions public to the route", async () => {
  const audit = new AuditDecisionSource({ listAuditEvents: async () => [{ id: "42", requestId: null, stage: "applied", endpoint: "trino", createdAt: "2026-11-09T00:00:00Z" }] });
  const verifier = { verify: async (token: string) => ({ sub: token, groups: token === "admin" ? ["admins"] : ["engineers"] }) };
  const app = createApp(undefined, undefined, undefined, undefined, undefined, verifier, undefined, { decisionSource: audit, decisionsRequireAdmins: true, fixtures: "partial" });
  for (const path of ["/api/v1/decisions", "/api/v1/decisions/audit-42"]) {
    expect((await app.request(path, { headers: { Authorization: "Bearer user" } })).status).toBe(403);
    expect((await app.request(path, { headers: { Authorization: "Bearer admin" } })).status).toBe(200);
  }
  const stubApp = createApp();
  expect((await stubApp.request("/api/v1/decisions")).status).toBe(200);
  expect((await stubApp.request("/api/v1/decisions/decision-fresh")).status).toBe(200);
});
it.each(["timeout", "permission", "unreachable"])("does not return fixture decisions on audit %s", async (failure) => {
  const source = new AuditDecisionSource({ listAuditEvents: async () => {
    if (failure === "timeout") return new Promise<never>(() => {});
    throw new Error(failure);
  } }, 5);
  const app = createApp(undefined, undefined, undefined, undefined, undefined, { verify: async () => ({ sub: "admin", groups: ["admins"] }) }, undefined, { decisionSource: source, decisionsRequireAdmins: true, fixtures: "partial" });
  expect((await app.request("/api/v1/decisions", { headers: { Authorization: "Bearer admin" } })).status).toBe(500);
});
it("keeps audit-backed decision routes admin-only when the option is explicitly false", async () => {
  const audit = new AuditDecisionSource({ listAuditEvents: async () => [] });
  const verifier = { verify: async () => ({ sub: "user", groups: ["engineers"] }) };
  const app = createApp(undefined, undefined, undefined, undefined, undefined, verifier, undefined, { decisionSource: audit, decisionsRequireAdmins: false, fixtures: "partial" });
  expect((await app.request("/api/v1/decisions", { headers: { Authorization: "Bearer user" } })).status).toBe(403);
});
it("empty audit history is a real empty response; capped history emits warnings", async () => {
  expect((await new AuditDecisionSource({ listAuditEvents: async () => [] }).list()).items).toEqual([]);
  const row = { id: "1", requestId: null, stage: "denied" as const, endpoint: null, createdAt: "2026-11-09T00:00:00Z" };
  expect((await new AuditDecisionSource({ listAuditEvents: async () => Array.from({ length: 1000 }, () => row) }).list()).warnings).toHaveLength(1);
});
it("health transitions only with Kubernetes, Flink, audit DB and built policy all wired", async () => {
  vi.spyOn(PgSsoChangeStore.prototype, "status").mockReturnValue("ok");
  for (const kube of [false, true]) for (const flink of [false, true]) for (const db of [false, true]) {
    const wired = createAppFromEnv({ AUTH_MODE: "disabled", ...(kube ? env : {}), ...(flink ? { BELUGA_FLINK_REST_URL: "http://flink.test" } : {}),
      ...(db ? { MANAGER_DB_HOST: "manager-db", MANAGER_DB_NAME: "manager", MANAGER_DB_USER: "manager_writer", MANAGER_DB_PASSWORD_FILE: path.join(dir, "token"), MANAGER_DB_SSL_CA_FILE: path.join(dir, "ca") } : {}) });
    const health = domainApiHealthSchema.parse(await (await wired.app.request("/api/v1/health")).json());
    expect(health.components.fixtures).toBe(kube && flink && db ? "live" : kube || flink || db ? "partial" : "stub");
  }
});
it("runtime routes use built policy declarations while no-config resources and decisions retain fixtures", async () => {
  const app = createAppFromEnv({ AUTH_MODE: "disabled" }).app;
  const policy = policyProjectionSchema.parse(await (await app.request("/api/v1/policies/beluga-platform-policy")).json());
  expect(policy).toEqual(overviewPolicy);
  expect(policy.sourceFile).toContain("policies/");
  expect(policy.roles.flatMap((r: { permissions: { resource: string }[] }) => r.permissions).some((p: { resource: string }) => p.resource === "lake.orders")).toBe(true);
  expect(listResponseSchema(resourceSchema, "TestResources").parse(await (await app.request("/api/v1/resources")).json()).data.length).toBeGreaterThan(0);
  expect(listResponseSchema(decisionRecordSchema, "TestDecisions").parse(await (await app.request("/api/v1/decisions")).json()).data[0]?.result.provider).not.toBe("manager-audit-db");
  expect(createRuntime({}).resourceSource).toBeUndefined();
});

it("environment wiring serves Kubernetes inventory and actual audit port records without upstream network", async () => {
  vi.spyOn(PgSsoChangeStore.prototype, "status").mockReturnValue("ok");
  const read = vi.spyOn(PgSsoChangeStore.prototype, "listAuditEvents").mockResolvedValue([
    { id: "77", requestId: "request", stage: "merged", endpoint: "trino", createdAt: "2026-11-09T00:00:00Z" },
  ]);
  const app = createAppFromEnv({ ...env, AUTH_MODE: "disabled", MANAGER_DB_HOST: "manager-db", MANAGER_DB_NAME: "manager", MANAGER_DB_USER: "manager_writer",
    MANAGER_DB_PASSWORD_FILE: path.join(dir, "token"), MANAGER_DB_SSL_CA_FILE: path.join(dir, "ca") }, undefined,
    async ({ url }) => response(table(url.pathname.endsWith("deployments") ? undefined : []))).app;
  const inventory = listResponseSchema(resourceSchema, "WiredResources").parse(await (await app.request("/api/v1/resources")).json());
  expect(inventory.data).toHaveLength(4);
  expect(inventory.data.every((item) => item.id.startsWith("kubernetes:"))).toBe(true);
  expect((await app.request("/api/v1/decisions")).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});

it.each(["throw", "UPSTREAM_UNAVAILABLE", "TRUNCATED"])("event-only %s keeps missing resource 404 and envelope warnings", async (failure) => {
  const source = new KubeResourceSource({ getText: vi.fn(), getJson: vi.fn(async () => table()) } as never, {
    listEvents: async () => {
      if (failure === "throw") throw new Error("ArgoCD unavailable");
      return { events: [], warnings: [{ code: failure, message: "events incomplete", serviceId: null }] };
    },
  });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { resourceSource: source, fixtures: "partial" });
  expect((await app.request("/api/v1/resources/missing")).status).toBe(404);
  expect(listResponseSchema(resourceSchema, "EventWarnings").parse(await (await app.request("/api/v1/resources")).json()).warnings).toHaveLength(1);
});
it("requests Table with includeObject=None and resolves reordered columns", async () => {
  const source = resources(async ({ url, headers }) => {
    expect(headers.Accept).toBe("application/json;as=Table;v=v1;g=meta.k8s.io");
    expect(url.searchParams.get("includeObject")).toBe("None");
    return response(table([[2, "test", "2/2", 2, "Complete"]], ["Available", "Name", "Ready", "Up-to-date", "Status"]));
  });
  expect((await source.list()).items.every((i) => i.status === "healthy")).toBe(true);
});
it("rejects full-object lists instead of consuming templates", async () => {
  await expect(resources(async () => response({ items: [{ spec: { template: {} } }] })).list()).rejects.toThrow("all resource sources failed");
});
it("truncated inventory cannot prove absence", async () => {
  const source = resources(async () => response({ ...table(), metadata: { continue: "next" } }));
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, { resourceSource: source, fixtures: "partial" });
  expect((await app.request("/api/v1/resources/missing")).status).toBe(500);
});
it.each(["resources", "decisions"])("shares five-second %s list/detail snapshot, coalesces, expires and retries errors", async (route) => {
  vi.useFakeTimers();
  const source = { list: vi.fn(async () => ({ items: [], warnings: [] })) };
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    route === "resources" ? { resourceSource: source, fixtures: "partial" } : { decisionSource: source, fixtures: "partial" });
  const request = (path: string) => app.request(path);
  await Promise.all([request(`/api/v1/${route}`), request(`/api/v1/${route}/missing`)]);
  expect(source.list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4999);
  await request(`/api/v1/${route}`);
  expect(source.list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  source.list.mockRejectedValueOnce(new Error("timeout"));
  expect((await request(`/api/v1/${route}/missing`)).status).toBe(500);
  expect((await request(`/api/v1/${route}`)).status).toBe(200);
  expect(source.list).toHaveBeenCalledTimes(3);
});
it.each([999, 1000])("audit absence uses inventory completeness with %i rows", async (length) => {
  const row = { id: "1", requestId: null, stage: "denied" as const, endpoint: null, createdAt: "2026-11-09T00:00:00Z" };
  const source = new AuditDecisionSource({ listAuditEvents: async () => Array.from({ length }, () => row) });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, { verify: async () => ({ sub: "admin", groups: ["admins"] }) }, undefined, { decisionSource: source, fixtures: "partial", decisionsRequireAdmins: true });
  const auth = { headers: { Authorization: "Bearer admin" } };
  expect((await app.request("/api/v1/decisions/audit-old", auth)).status).toBe(length === 1000 ? 500 : 404);
  expect((await app.request("/api/v1/decisions/audit-1", auth)).status).toBe(200);
});

it.each(["0/0", "0/2", "1/2", "2/2", undefined])("StatefulSet readiness uses only its Ready column: %s", async (ready) => {
  const batch = await resources(async () => response(table([["test", ready]], ["Name", "Ready"]))).list();
  const item = batch.items.find((i) => i.id.includes("StatefulSet"))!;
  expect(item.status).toBe(ready === undefined ? "unknown" : ready === "0/2" ? "unavailable" : ready === "1/2" ? "degraded" : "healthy");
  expect(item.statusDetail).toBe(ready === "0/0" ? "scaled to zero" : undefined);
});
