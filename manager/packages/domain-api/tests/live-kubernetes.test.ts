import fs from "node:fs";
import http from "node:http";
import { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KubeClient, defaultKubeRequester, type KubeRequester } from "../src/adapters/kubeClient.js";
import { KubeWorkloadAdapter } from "../src/adapters/kubeWorkload.js";
import { KubeEventSource } from "../src/adapters/kubeEvents.js";
import { ServiceAdapterRegistry } from "../src/adapters/registry.js";
import { createRuntime } from "../src/adapters/runtime.js";
import { ArgocdReader } from "../src/sso-change/argocdReader.js";
import { services } from "../src/stub-data/services.js";
import { domainApiHealthSchema } from "../src/routes/health.js";
import { listResponseSchema } from "../src/schema/envelope.js";
import { eventSchema } from "../src/schema/event.js";
import { createAppFromEnv } from "../src/wiring.js";

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-kube-"));
  fs.writeFileSync(path.join(dir, "token"), "rotating-token");
  fs.writeFileSync(path.join(dir, "ca"), "ca");
  env = { KUBE_API_URL: "https://kubernetes.default.svc", KUBE_API_TOKEN_FILE: path.join(dir, "token"), KUBE_API_CA_FILE: path.join(dir, "ca"), AUTH_MODE: "disabled" };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function client(requester: KubeRequester, timeoutMs = 100) {
  return new KubeClient({ apiUrl: env.KUBE_API_URL!, tokenFile: env.KUBE_API_TOKEN_FILE!, caFile: env.KUBE_API_CA_FILE!, requester, timeoutMs });
}
const response = (obj: unknown) => ({ status: 200, body: JSON.stringify(obj) });
async function service(id: string, requester: KubeRequester, timeoutMs?: number) {
  const adapter = new KubeWorkloadAdapter(services.find((s) => s.id === id)!, client(requester, timeoutMs), "test.beluga.internal");
  return (await new ServiceAdapterRegistry([adapter]).listServices())[0]!;
}

describe("live workload health", () => {
  it.each([[2, 2, "healthy"], [1, 2, "degraded"], [0, 2, "unavailable"], [0, 0, "unavailable"]])(
    "ready %i desired %i -> %s", async (ready, desired, status) => {
      const result = await service("svc-airflow", async () => response({ spec: { replicas: desired }, status: { readyReplicas: ready, updatedReplicas: ready, availableReplicas: ready } }));
      expect(result.status).toBe(status);
      expect(result.namespace).toBe("orchestration");
      expect(result.workloadRef).toBe("deployments/airflow-webserver");
      expect(result.keyMetrics).toEqual(expect.arrayContaining([{ name: "ready", value: String(ready), unit: "replicas" }]));
      expect(result.endpoint).toBe("https://airflow.test.beluga.internal");
      expect(result.version).toBeNull();
    },
  );
  it("counts every Trino deployment; missing required coordinator cannot be healthy", async () => {
    const result = await service("svc-trino", async ({ url }) => url.pathname.endsWith("trino-coordinator")
      ? { status: 404, body: "{}" } : response({ spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } }));
    expect(result.status).toBe("degraded");
    expect(result.keyMetrics.find((m) => m.name === "detail")?.value).toContain("not deployed");
  });
  it("supports the chart coordinator-only profile without inventing worker replicas", async () => {
    const result = await service("svc-trino", async ({ url }) => url.pathname.endsWith("trino-worker")
      ? { status: 404, body: "{}" } : response({ spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } }));
    expect(result.status).toBe("healthy");
    expect(result.keyMetrics).toContainEqual({ name: "desired", value: "1", unit: "replicas" });
  });
  it("does not trust ready replicas from an earlier generation", async () => {
    const result = await service("svc-superset", async () => response({ metadata: { generation: 3 }, spec: { replicas: 1 }, status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } }));
    expect(result.status).toBe("unavailable");
  });
  it.each([403, 500])("HTTP %i becomes unknown, never healthy or not deployed", async (status) => {
    const result = await service("svc-iceberg", async () => ({ status, body: "{}" }));
    expect(result.status).toBe("unknown");
    expect(result.keyMetrics.some((m) => m.name === "ready")).toBe(false);
  });
  it("bounds injected hanging requester and maps unreachable/malformed responses to unknown", async () => {
    for (const requester of [async () => new Promise<never>(() => {}), async () => { throw new Error("ECONNREFUSED"); }, async () => response({})]) {
      expect((await service("svc-iceberg", requester, 10)).status).toBe("unknown");
    }
  });
  it("observability is healthy only when Grafana and VictoriaMetrics are ready", async () => {
    const result = await service("svc-observability", async ({ url }) => {
      expect(url.pathname).toMatch(/^\/apis\/apps\/v1\/namespaces\/platform-system\/(deployments\/grafana|statefulsets\/victoria-metrics)$/);
      return response({ spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } });
    });
    expect(result.status).toBe("healthy");
    expect(result.namespace).toBe("platform-system");
    expect(result.workloadRef).toBe("deployments/grafana,statefulsets/victoria-metrics");
  });
  it("observability degrades when either workload is down", async () => {
    const result = await service("svc-observability", async ({ url }) => response({ spec: { replicas: 1 }, status: {
      readyReplicas: url.pathname.endsWith("/grafana") ? 1 : 0,
      updatedReplicas: url.pathname.endsWith("/grafana") ? 1 : 0,
      availableReplicas: url.pathname.endsWith("/grafana") ? 1 : 0,
    } }));
    expect(result.status).toBe("degraded");
  });
  it("observability degrades when Grafana is down and VictoriaMetrics is ready", async () => {
    const result = await service("svc-observability", async ({ url }) => response({ spec: { replicas: 1 }, status: {
      readyReplicas: url.pathname.endsWith("/grafana") ? 0 : 1,
      updatedReplicas: url.pathname.endsWith("/grafana") ? 0 : 1,
      availableReplicas: url.pathname.endsWith("/grafana") ? 0 : 1,
    } }));
    expect(result.status).toBe("degraded");
  });
  it("observability is unavailable when one workload is missing and the other is not ready", async () => {
    const result = await service("svc-observability", async ({ url }) => url.pathname.endsWith("/grafana")
      ? { status: 404, body: "{}" }
      : response({ spec: { replicas: 1 }, status: { readyReplicas: 0, updatedReplicas: 0, availableReplicas: 0 } }));
    expect(result.status).toBe("unavailable");
    expect(result.keyMetrics.find((m) => m.name === "ready")?.value).toBe("0");
  });
  it("observability is not deployed only when both workloads return 404", async () => {
    const result = await service("svc-observability", async () => ({ status: 404, body: "{}" }));
    expect(result.status).toBe("unavailable");
    expect(result.keyMetrics.find((m) => m.name === "detail")?.value).toContain("not deployed");
  });
  it("observability 403 is unknown", async () => {
    expect((await service("svc-observability", async () => ({ status: 403, body: "{}" }))).status).toBe("unknown");
  });
  it("missing required workload explicitly says not deployed", async () => {
    const result = await service("svc-iceberg", async () => ({ status: 404, body: "{}" }));
    expect(result.status).toBe("unavailable");
    expect(result.keyMetrics.find((m) => m.name === "detail")?.value).toContain("not deployed");
  });
  it("reads Strimzi Kafka readiness and identifies counts as CRs", async () => {
    for (const ready of [true, false]) {
      const result = await service("svc-kafka", async ({ url }) => {
        expect(url.pathname).toBe("/apis/kafka.strimzi.io/v1/namespaces/streaming/kafkas/beluga-kafka");
        return response({ spec: {}, status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] } });
      });
      expect(result.status).toBe(ready ? "healthy" : "unavailable");
      expect(result.keyMetrics[0]?.unit).toBe("CRs");
    }
  });
  it("probes /readyz as text and treats denied probes as unknown", async () => {
    expect((await service("svc-kubernetes", async ({ url }) => {
      expect(url.pathname).toBe("/readyz");
      return { status: 200, body: "ok" };
    })).status).toBe("healthy");
    expect((await service("svc-kubernetes", async () => ({ status: 403, body: "denied" }))).status).toBe("unknown");
  });
  it("shares concurrent metadata/health calls and fetches again next request", async () => {
    let calls = 0;
    const adapter = new KubeWorkloadAdapter(services[1]!, client(async () => { calls++; return response({ spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 } }); }), "local.beluga.internal");
    const registry = new ServiceAdapterRegistry([adapter]);
    await registry.listServices();
    expect(calls).toBe(1);
    await registry.listServices();
    expect(calls).toBe(2);
  });
  it("rejects off-origin paths before forwarding credentials", async () => {
    await expect(client(async () => { throw new Error("must not be called"); }).getJson("//evil.test/events")).rejects.toThrow("invalid API path");
  });
});

describe("events and production wiring", () => {
  const requester: KubeRequester = async ({ url }) => {
    if (url.pathname.includes("/applications/")) return response({ status: { sync: { status: "OutOfSync" }, health: { status: "Degraded" } } });
    const namespace = url.pathname.split("/")[4];
    expect(url.searchParams.get("limit")).toBe("100");
    return response({ items: [
      { metadata: { uid: `${namespace}-1` }, type: "Warning", message: "Back-off", lastTimestamp: "2026-11-05T00:00:00Z", involvedObject: { kind: "Pod", name: "broken", namespace } },
      { metadata: { uid: `${namespace}-2` }, type: "Normal", message: "Started", eventTime: "2026-11-06T00:00:00Z" },
      { metadata: { uid: "invalid" }, lastTimestamp: "invalid" },
    ] });
  };
  it("maps core events and ArgoCD problems, sorts newest first, validates schema", async () => {
    const kube = client(requester);
    const source = new KubeEventSource(kube, new ArgocdReader({ apiUrl: env.KUBE_API_URL!, tokenFile: env.KUBE_API_TOKEN_FILE!, caFile: env.KUBE_API_CA_FILE! }, kube));
    const events = eventSchema.array().parse((await source.listEvents()).events);
    expect(events).toHaveLength(10);
    const warning = events.find((e) => e.id === "kube-event-analytics-1")!;
    expect(warning).toMatchObject({ severity: "warning", source: "kubernetes", relatedResourceId: "kubernetes:analytics/Pod/broken", relatedPipelineId: null });
    expect(events.find((e) => e.id === "kube-event-analytics-2")?.severity).toBe("info");
    expect(events.filter((event) => event.source === "service")).toHaveLength(2);
    expect(events.map((e) => e.timestamp)).toEqual(events.map((e) => e.timestamp).sort().reverse());
  });
  it("excludes healthy/synced apps and bounds result count", async () => {
    const kube = client(async () => response({ items: Array.from({ length: 150 }, (_, i) => ({ metadata: { uid: String(i) }, lastTimestamp: "2026-11-06T00:00:00Z" })) }));
    const source = new KubeEventSource(kube, { getApplication: async (name) => ({ name, syncStatus: "Synced", healthStatus: "Healthy", revision: undefined }) });
    expect((await source.listEvents()).events).toHaveLength(100);
  });
  it("uses live event source and partial fixtures flag when KUBE_API is configured", async () => {
    const { app } = createAppFromEnv(env, undefined, requester);
    const health = domainApiHealthSchema.parse(await (await app.request("/api/v1/health")).json());
    expect(health.components.fixtures).toBe("partial");
    const result = listResponseSchema(eventSchema, "LiveEventTest").parse(await (await app.request("/api/v1/events?severity=warning&pageSize=100")).json());
    expect(result.data).toHaveLength(6);
    expect(result.data.every((e) => e.source !== undefined && ["kubernetes", "service"].includes(e.source))).toBe(true);
  });
  it("keeps default fixtures and no network when Kubernetes config is unset", async () => {
    const runtime = createRuntime({});
    expect(runtime.eventSource).toBeUndefined();
    expect(await runtime.registry.listServices()).toEqual(services);
    const { app } = createAppFromEnv({ AUTH_MODE: "disabled" }, undefined, async () => { throw new Error("must not be called"); });
    expect(domainApiHealthSchema.parse(await (await app.request("/api/v1/health")).json()).components.fixtures).toBe("stub");
    expect(listResponseSchema(eventSchema, "StubEventTest").parse(await (await app.request("/api/v1/events")).json()).data.length).toBeGreaterThan(0);
  });
  it("enables seven Kubernetes entries while Flink remains its independently configured REST adapter", async () => {
    const runtime = createRuntime({ ...env, BELUGA_FLINK_REST_URL: "https://flink.example.test" }, undefined, async ({ url }) => {
      if (url.pathname === "/readyz") return { status: 200, body: "ok" };
      return response({ spec: { replicas: 1 }, status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1, conditions: [{ type: "Ready", status: "True" }] } });
    });
    expect(runtime.pipelineAdapter).toBeDefined();
    expect((await runtime.registry.getService("svc-airflow"))?.status).toBe("healthy");
    expect((await runtime.registry.getService("svc-kafka"))?.namespace).toBe("streaming");
    expect((await runtime.registry.getService("svc-superset"))?.namespace).toBe("analytics");
    expect((await runtime.registry.getService("svc-iceberg"))?.namespace).toBe("lakehouse");
    expect((await runtime.registry.getService("svc-kubernetes"))?.status).toBe("healthy");
    expect((await runtime.registry.getService("svc-observability"))?.status).toBe("healthy");
    expect((await runtime.registry.getService("svc-trino"))?.keyMetrics).toContainEqual({ name: "desired", value: "2", unit: "replicas" });
  });
  it("rereads both token and CA files for the generic client", async () => {
    const seen: string[] = [];
    const kube = client(async (request) => { seen.push(`${request.headers.Authorization}/${request.ca}`); return response({}); });
    await kube.getJson("/api/v1/namespaces/analytics/events");
    fs.writeFileSync(env.KUBE_API_TOKEN_FILE!, "next-token");
    fs.writeFileSync(env.KUBE_API_CA_FILE!, "next-ca");
    await kube.getJson("/api/v1/namespaces/analytics/events");
    expect(seen).toEqual(["Bearer rotating-token/ca", "Bearer next-token/next-ca"]);
  });
  it("failed live source returns error rather than fabricated fixture events", async () => {
    const { app } = createAppFromEnv(env, undefined, async () => ({ status: 403, body: "{}" }));
    const res = await app.request("/api/v1/events");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});


describe("Round 2 regressions", () => {
  it("aborts an injected slow-drip transport at the overall deadline and stops buffering", async () => {
    vi.useFakeTimers();
    let bytes = 0;
    let aborted = false;
    try {
      const pending = client(({ signal }) => new Promise((_, reject) => {
        const drip = setInterval(() => { bytes++; }, 5);
        signal.addEventListener("abort", () => {
          aborted = true;
          clearInterval(drip);
          reject(new Error("aborted"));
        }, { once: true });
      }), 25).getText("/readyz");
      const failed = expect(pending).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(25);
      await failed;
      expect(aborted).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      const atDeadline = bytes;
      await vi.advanceTimersByTimeAsync(100);
      expect(bytes).toBe(atDeadline);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("destroys the native HTTP socket despite continuous slow-drip response data", async () => {
    let drip: ReturnType<typeof setInterval> | undefined;
    let bytes = 0;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) { done(); },
      destroy(error, done) { clearInterval(drip); done(error); },
    });
    const originalRequest = http.request;
    const spy = vi.spyOn(http, "request").mockImplementation(((url, options, callback) =>
      originalRequest(url, { ...options, createConnection: () => socket }, callback)) as typeof http.request);
    try {
      const kube = new KubeClient({ apiUrl: "http://kube.test", tokenFile: env.KUBE_API_TOKEN_FILE!, caFile: env.KUBE_API_CA_FILE!,
        timeoutMs: 60, requester: (request) => {
          const reply = defaultKubeRequester(request);
          socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
          drip = setInterval(() => { bytes++; socket.push("1\r\nx\r\n"); }, 5);
          return reply;
        } });
      await expect(kube.getText("/readyz")).rejects.toThrow("timeout");
      expect(bytes).toBeGreaterThan(1);
      expect(socket.destroyed).toBe(true);
    } finally {
      clearInterval(drip);
      socket.destroy();
      spy.mockRestore();
    }
  });
  it("keeps ArgoCD default 5s and explicit timeout overrides", async () => {
    for (const timeoutMs of [undefined, 75]) {
      const reader = new ArgocdReader({ apiUrl: env.KUBE_API_URL!, tokenFile: env.KUBE_API_TOKEN_FILE!, caFile: env.KUBE_API_CA_FILE!,
        ...(timeoutMs === undefined ? {} : { timeoutMs }), requester: async (request) => {
          expect(request.timeoutMs).toBe(timeoutMs ?? 5000);
          return response({ status: { sync: { status: "Synced" } } });
        } });
      await reader.getApplication("beluga-platform");
    }
  });
  it.each([[3, 1, 3, "degraded", "1"], [3, 3, 1, "degraded", "1"], [3, 0, 3, "unavailable", "0"], [3, 3, 3, "healthy", "3"]])(
    "rollout ready=%i updated=%i available=%i -> %s", async (ready, updated, available, status, count) => {
      const result = await service("svc-airflow", async () => response({ metadata: { generation: 2 }, spec: { replicas: 3 },
        status: { observedGeneration: 2, readyReplicas: ready, updatedReplicas: updated, availableReplicas: available } }));
      expect(result.status).toBe(status);
      expect(result.keyMetrics).toContainEqual({ name: "ready", value: count, unit: "replicas" });
    });
  it.each(["namespace", "argocd"])("returns 200 with warnings for a failed %s source", async (failedSource) => {
    const { app } = createAppFromEnv(env, undefined, async ({ url, timeoutMs }) => {
      const argo = url.pathname.includes("/applications/");
      expect(timeoutMs).toBe(argo ? 5000 : 2500);
      if ((failedSource === "namespace" && url.pathname.includes("/analytics/")) ||
          (failedSource === "argocd" && url.pathname.endsWith("/beluga-data"))) return { status: 403, body: "{}" };
      if (argo) return response({ status: { sync: { status: "Synced" }, health: { status: "Healthy" } } });
      return response({ items: [{ metadata: { uid: url.pathname }, lastTimestamp: "2026-11-06T00:00:00Z", message: "Started" }] });
    });
    const res = await app.request("/api/v1/events?pageSize=100");
    expect(res.status).toBe(200);
    const body = listResponseSchema(eventSchema, "PartialEvents").parse(await res.json());
    expect(body.data).toHaveLength(failedSource === "namespace" ? 3 : 4);
    expect(body.warnings).toEqual([{ code: "UPSTREAM_UNAVAILABLE", serviceId: null,
      message: `Event source ${failedSource === "namespace" ? "kubernetes:analytics" : "argocd:beluga-data"} unavailable` }]);
  });
  it("successful empty source yields 200 when all other sources fail", async () => {
    const { app } = createAppFromEnv(env, undefined, async ({ url }) => url.pathname.includes("/analytics/")
      ? response({ items: [] }) : { status: 403, body: "{}" });
    const res = await app.request("/api/v1/events?severity=warning");
    expect(res.status).toBe(200);
    const body = listResponseSchema(eventSchema, "EmptyPartialEvents").parse(await res.json());
    expect(body.data).toEqual([]);
    expect(body.warnings).toHaveLength(5);
  });
});
