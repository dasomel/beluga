import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { FlinkAdapter } from "../src/adapters/flink/adapter.js";
import { FlinkClientError, FlinkRestClient } from "../src/adapters/flink/client.js";
import { FLINK_STATE_MAPPING, mapState } from "../src/adapters/flink/mapping.js";
import { createRuntime } from "../src/adapters/runtime.js";
import { createApp } from "../src/app.js";
import { ConfigError, DEFAULT_FLINK_TIMEOUT_MS, loadFlinkAdapterConfig } from "../src/config.js";
import { listResponseSchema } from "../src/schema/envelope.js";
import { pipelineSchema } from "../src/schema/pipeline.js";
import { services } from "../src/stub-data/services.js";

// 픽스처: *.synthetic.json을 제외한 파일은 Flink 1.20.0 실제 클러스터에서 읽기 전용으로 녹화한 응답이다
// (tests/fixtures/flink-1.20/README.md).
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/flink-1.20/${name}`, import.meta.url)), "utf8"));

const config = { baseUrl: "http://flink.test:8081", timeoutMs: 200, jobNamePrefix: "beluga-", cacheTtlMs: 0, snapshotBudgetMs: 1000, maxConcurrency: 8, maxQueue: 64 };
const NOW = new Date("2026-10-07T00:00:00.000Z");
const JIDS = {
  orders: "e4ce0083a91b9378cd054e129326abf7",
  customers: "5ec600a747e2a2be1d5bc75b6d5a98ad",
  events: "e1c03f689440a936a1ff5304c6934440",
} as const;

interface Routes {
  overview?: unknown;
  jobs?: unknown;
  details?: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordedFetch(routes: Routes, seen: Array<{ method: string; path: string }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push({ method: init?.method ?? "GET", path });
    if (path === "/overview") return json(routes.overview ?? fixture("overview.json"));
    if (path === "/jobs/overview") return json(routes.jobs ?? fixture("jobs-overview.json"));
    const jid = path.replace("/jobs/", "");
    const detail = routes.details?.[jid];
    return detail === undefined ? json({ errors: ["not found"] }, 404) : json(detail);
  }) as typeof fetch;
}

const liveDetails = {
  [JIDS.orders]: fixture("job-cdc_orders.json"),
  [JIDS.customers]: fixture("job-cdc_customers.json"),
  [JIDS.events]: fixture("job-events_sessionization.json"),
};

function adapterWith(fetchImpl: typeof fetch, overrides: Partial<typeof config> = {}) {
  return new FlinkAdapter({ config: { ...config, ...overrides }, fetchImpl, now: () => NOW });
}

test("녹화된 RUNNING job 3개가 job당 하나의 Pipeline으로 매핑되고 스키마를 통과한다", async () => {
  const { pipelines, warnings } = await adapterWith(recordedFetch({ details: liveDetails })).listPipelines();

  expect(warnings).toEqual([]);
  expect(pipelines.map((p) => p.id)).toEqual([
    `pl-flink-${JIDS.customers}`,
    `pl-flink-${JIDS.orders}`,
    `pl-flink-${JIDS.events}`,
  ].sort());
  for (const p of pipelines) {
    expect(() => pipelineSchema.parse(p)).not.toThrow();
    expect(p.status).toBe("healthy");
    expect(p.jobs[0]).toMatchObject({ kind: "flink", serviceId: "svc-flink", lastRun: { result: "running", finishedAt: null, failureReason: null } });
    expect(p.correlation.method).toBe("inferred");
  }
  const orders = pipelines.find((p) => p.name === "beluga-cdc_orders")!;
  expect(orders.jobs[0]!.id).toBe(`job-flink-${JIDS.orders}`);
  expect(orders.jobs[0]!.lastRun!.startedAt).toBe(new Date(1791368356575).toISOString());
  expect(orders.stages.map((s) => [s.serviceType, s.status])).toEqual([["flink", "healthy"], ["iceberg", "unknown"]]);
});

test("job->table 링크는 이름 규약(0.6)이며 declared로 위조되지 않고 Flink job graph 근거를 포함한다", async () => {
  const { pipelines } = await adapterWith(recordedFetch({ details: liveDetails })).listPipelines();

  const byName = Object.fromEntries(pipelines.map((p) => [p.name, p]));
  const expected = {
    "beluga-cdc_orders": "lakekeeper.lake.orders",
    "beluga-cdc_customers": "lakekeeper.lake.customers",
    "beluga-events_sessionization": "lakekeeper.lake.events_enriched",
  };
  for (const [name, table] of Object.entries(expected)) {
    const links = byName[name]!.correlationLinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ relation: "job-writes-table", method: "name-convention", confidence: 0.6 });
    expect(links[0]!.evidence.join(" ")).toContain(`IcebergSink on '${table}'`);
    expect(byName[name]!.correlation.confidence).toBe(0.6);
  }
  // Kafka topic은 Flink REST가 노출하지 않으므로 topic->job 링크는 만들지 않는다.
  expect(pipelines.flatMap((p) => p.correlationLinks).some((l) => l.relation === "topic-feeds-job")).toBe(false);
});

test("RESTARTING job은 degraded이고 실행 결과는 unknown, 실패 사유는 상태 이름만 담는다", async () => {
  const jobs = fixture("jobs-overview.restarting.synthetic.json");
  const details = { [JIDS.orders]: fixture("job-cdc_orders.restarting.synthetic.json") };
  const { pipelines } = await adapterWith(recordedFetch({ jobs, details })).listPipelines();

  expect(pipelines).toHaveLength(1);
  expect(pipelines[0]!.status).toBe("degraded");
  expect(pipelines[0]!.jobs[0]!.lastRun).toMatchObject({ result: "unknown", failureReason: "Flink reported job state RESTARTING" });
});

test("FAILED job은 unavailable/failed이고 종료 시각을 담는다", async () => {
  const jobs = fixture("jobs-overview.failed.synthetic.json");
  const { pipelines } = await adapterWith(recordedFetch({ jobs })).listPipelines();

  expect(pipelines[0]!.status).toBe("unavailable");
  const lastRun = pipelines[0]!.jobs[0]!.lastRun!;
  expect(lastRun.result).toBe("failed");
  expect(lastRun.finishedAt).not.toBeNull();
});

test("상태 매핑 표: 알 수 없는 상태와 failed task가 있는 RUNNING은 보수적으로 매핑된다", () => {
  expect(Object.keys(FLINK_STATE_MAPPING).sort()).toEqual(
    ["CANCELED", "CANCELLING", "CREATED", "FAILED", "FAILING", "FINISHED", "INITIALIZING", "RECONCILING", "RESTARTING", "RUNNING", "SUSPENDED"],
  );
  expect(mapState("SOMETHING_NEW")).toEqual({ health: "unknown", result: "unknown" });
  expect(mapState("RUNNING", { failed: 1 })).toEqual({ health: "degraded", result: "running" });
  expect(mapState("RUNNING", { failed: 0 }).health).toBe("healthy");
  // healthy는 RUNNING과 FINISHED뿐이다.
  expect(Object.entries(FLINK_STATE_MAPPING).filter(([, m]) => m.health === "healthy").map(([s]) => s).sort()).toEqual(["FINISHED", "RUNNING"]);
});

test("JobManager에 연결할 수 없으면 throw하지 않고 unknown/경고로 낮춘다", async () => {
  const refused = (async () => { throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.9:8081"); }) as typeof fetch;
  const adapter = adapterWith(refused);
  vi.spyOn(console, "warn").mockImplementation(() => {});

  expect((await adapter.getHealth()).status).toBe("unknown");
  expect(await adapter.getVersion()).toBeNull();
  expect((await adapter.getMetadata()).keyMetrics).toEqual([]);
  const snapshot = await adapter.listPipelines();
  expect(snapshot.pipelines).toEqual([]);
  expect(snapshot.warnings).toEqual([{ code: "UPSTREAM_UNAVAILABLE", message: expect.stringContaining("unreachable"), serviceId: "svc-flink" }]);
  expect(JSON.stringify(snapshot)).not.toContain("10.0.0.9");
});

test("route는 JobManager가 내려가 있어도 200과 경고를 반환한다", async () => {
  const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const app = createApp(undefined, undefined, adapterWith(refused));
  const res = await app.request("/api/v1/pipelines");

  expect(res.status).toBe(200);
  const body = listResponseSchema(pipelineSchema, "PipelineListFlinkDown").parse(await res.json());
  expect(body.data).toEqual([]);
  expect(body.warnings?.[0]?.code).toBe("UPSTREAM_UNAVAILABLE");
});

test("route는 라이브 Pipeline을 목록/상세로 제공하고 없는 id는 404이다", async () => {
  const app = createApp(undefined, undefined, adapterWith(recordedFetch({ details: liveDetails })));
  const list = listResponseSchema(pipelineSchema, "PipelineListFlinkLive").parse(await (await app.request("/api/v1/pipelines")).json());
  expect(list.meta.total).toBe(3);
  expect(list.data.every((p) => p.id.startsWith("pl-flink-"))).toBe(true); // stub과 섞이지 않는다.

  const one = await app.request(`/api/v1/pipelines/pl-flink-${JIDS.orders}`);
  expect(one.status).toBe(200);
  expect((await app.request("/api/v1/pipelines/pl-lakehouse-ingest")).status).toBe(404);
});

test("잘못된 JSON과 예상 밖 모양은 invalid-response로 분류된다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const malformed = (async () => new Response("{not json", { status: 200 })) as typeof fetch;
  const wrongShape = (async () => json({ jobs: [{ jid: "../etc/passwd", name: "x", state: "RUNNING" }] })) as typeof fetch;

  await expect(new FlinkRestClient({ ...config, fetchImpl: malformed }).getJobsOverview()).rejects.toMatchObject({ kind: "invalid-response" });
  await expect(new FlinkRestClient({ ...config, fetchImpl: wrongShape }).getJobsOverview()).rejects.toMatchObject({ kind: "invalid-response" });

  const adapter = adapterWith(malformed);
  expect((await adapter.getHealth()).status).toBe("unknown");
  const snapshot = await adapter.listPipelines();
  expect(snapshot.pipelines).toEqual([]);
  expect(snapshot.warnings[0]!.message).toContain("unexpected response");
});

test("응답이 없으면 timeout으로 분류되고 요청이 abort된다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let aborted = false;
  const hang = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;

  await expect(new FlinkRestClient({ ...config, timeoutMs: 20, fetchImpl: hang }).getOverview()).rejects.toMatchObject({ kind: "timeout" });
  expect(aborted).toBe(true);
  const snapshot = await adapterWith(hang, { timeoutMs: 20 }).listPipelines();
  expect(snapshot.warnings[0]!.message).toContain("did not respond in time");
});

test("HTTP 5xx는 degraded, 4xx는 unknown health이다", async () => {
  const status = (code: number) => (async () => new Response("{}", { status: code })) as typeof fetch;
  expect((await adapterWith(status(503)).getHealth()).status).toBe("degraded");
  expect((await adapterWith(status(404)).getHealth()).status).toBe("unknown");
});

test("정상 JobManager의 service 메타데이터는 live overview에서 온다", async () => {
  const adapter = adapterWith(recordedFetch({}));
  expect(await adapter.getVersion()).toBe("1.20.0");
  expect((await adapter.getHealth()).status).toBe("healthy");
  const meta = await adapter.getMetadata();
  expect(meta.endpoint).toBeNull(); // 내부 REST 주소는 노출하지 않는다.
  expect(meta.keyMetrics.map((m) => m.name)).toEqual(["TaskManagers", "Slots total", "Slots available", "Jobs running"]);
});

test("registry/service route에서 svc-flink가 라이브 어댑터로 대체되고 순서는 유지된다", async () => {
  const { registry, pipelineAdapter } = createRuntime({ BELUGA_FLINK_REST_URL: "http://flink.test:8081" }, recordedFetch({}));
  const listed = await registry.listServices();

  expect(pipelineAdapter).toBeDefined();
  expect(listed.map((s) => s.id)).toEqual(services.map((s) => s.id));
  const flink = listed.find((s) => s.id === "svc-flink")!;
  expect(flink).toMatchObject({ version: "1.20.0", status: "healthy" });
});

test("설정이 없으면 기본은 stub이다(어댑터 비활성)", async () => {
  const { registry, pipelineAdapter } = createRuntime({});
  expect(pipelineAdapter).toBeUndefined();
  expect(await registry.listServices()).toEqual(services);
  expect(loadFlinkAdapterConfig({})).toBeUndefined();
  expect(loadFlinkAdapterConfig({ BELUGA_FLINK_REST_URL: "  " })).toBeUndefined();
});

test("설정 검증: 기본값, 경로/자격증명/스킴/타임아웃 오류는 기동 시점에 거부된다", () => {
  expect(loadFlinkAdapterConfig({ BELUGA_FLINK_REST_URL: "http://flink-cluster-rest.streaming:8081/" })).toEqual({
    baseUrl: "http://flink-cluster-rest.streaming:8081",
    timeoutMs: DEFAULT_FLINK_TIMEOUT_MS,
    cacheTtlMs: 5000,
    snapshotBudgetMs: 5000,
    maxConcurrency: 8,
    maxQueue: 64,
    jobNamePrefix: "beluga-",
  });
  const bad = (env: Record<string, string>) => () => loadFlinkAdapterConfig(env);
  expect(bad({ BELUGA_FLINK_REST_URL: "not a url" })).toThrow(ConfigError);
  expect(bad({ BELUGA_FLINK_REST_URL: "ftp://x" })).toThrow(/http or https/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://u:p@x:8081" })).toThrow(/credentials/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081/jobs" })).toThrow(/bare origin/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_TIMEOUT_MS: "0" })).toThrow(/TIMEOUT/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_TIMEOUT_MS: "abc" })).toThrow(/TIMEOUT/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_CACHE_TTL_MS: "-1" })).toThrow(/CACHE_TTL/);
  // 캐시 비활성(TTL < 1000)은 명시적 opt-in이 있어야만 허용된다.
  const url = { BELUGA_FLINK_REST_URL: "http://x:8081" };
  expect(bad({ ...url, BELUGA_FLINK_CACHE_TTL_MS: "0" })).toThrow(/between 1000 and/);
  expect(bad({ ...url, BELUGA_FLINK_CACHE_TTL_MS: "999" })).toThrow(/CACHE_TTL/);
  expect(bad({ ...url, BELUGA_FLINK_CACHE_TTL_MS: "0", BELUGA_FLINK_ALLOW_NO_CACHE: "yes" })).toThrow(/CACHE_TTL/);
  expect(loadFlinkAdapterConfig({ ...url, BELUGA_FLINK_CACHE_TTL_MS: "1000" })?.cacheTtlMs).toBe(1000);
  expect(loadFlinkAdapterConfig({ ...url, BELUGA_FLINK_CACHE_TTL_MS: "0", BELUGA_FLINK_ALLOW_NO_CACHE: "true" })?.cacheTtlMs).toBe(0);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_SNAPSHOT_BUDGET_MS: "0" })).toThrow(/SNAPSHOT_BUDGET/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_MAX_CONCURRENCY: "99" })).toThrow(/MAX_CONCURRENCY/);
  expect(bad({ BELUGA_FLINK_REST_URL: "http://x:8081", BELUGA_FLINK_MAX_QUEUE: "2000" })).toThrow(/MAX_QUEUE/);
});

test("읽기 전용: GET만, 허용된 경로만 호출하고 변경성 endpoint는 호출하지 않는다", async () => {
  const seen: Array<{ method: string; path: string }> = [];
  const adapter = adapterWith(recordedFetch({ details: liveDetails }, seen));
  await adapter.listPipelines();
  await adapter.getHealth();

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((r) => r.method === "GET")).toBe(true);
  expect(seen.every((r) => r.path === "/overview" || r.path === "/jobs/overview" || /^\/jobs\/[0-9a-f]{32}$/.test(r.path))).toBe(true);
});

test("jid가 경로를 바꾸려 하면 요청 전에 거부된다", () => {
  const client = new FlinkRestClient({ ...config, fetchImpl: (() => { throw new Error("must not be called"); }) as typeof fetch });
  expect(() => client.getJob("../../cluster")).toThrow(FlinkClientError);
});

test("job 상세 조회가 실패해도 job은 투영되고 PARTIAL 경고가 붙는다", async () => {
  const { pipelines, warnings } = await adapterWith(recordedFetch({ details: { [JIDS.orders]: liveDetails[JIDS.orders] } })).listPipelines();

  expect(pipelines).toHaveLength(3);
  expect(warnings.map((w) => w.code)).toEqual(["PARTIAL"]);
  const customers = pipelines.find((p) => p.name === "beluga-cdc_customers")!;
  expect(customers.correlationLinks).toEqual([]);
  expect(customers.correlation.confidence).toBe(0.3);
  expect(customers.stages).toHaveLength(1);
});

test("Pipeline id는 jid에서만 파생되어 같은 이름의 job이 추가/제거되어도 바뀌지 않는다", async () => {
  const base = (fixture("jobs-overview.json") as { jobs: Array<Record<string, unknown>> }).jobs[0]!;
  const alone = await adapterWith(recordedFetch({ jobs: { jobs: [base] } })).listPipelines();
  const twin = { ...base, jid: "a".repeat(32) };
  const both = await adapterWith(recordedFetch({ jobs: { jobs: [base, twin] } })).listPipelines();

  expect(alone.pipelines[0]!.id).toBe(`pl-flink-${JIDS.orders}`);
  expect(both.pipelines.map((p) => p.id).sort()).toEqual([`pl-flink-${"a".repeat(32)}`, `pl-flink-${JIDS.orders}`].sort());
  expect(both.pipelines.find((p) => p.id === `pl-flink-${JIDS.orders}`)).toBeDefined();
});

// ---- 리뷰 반영: 증폭 방어, 단건 조회, 본문 상한, 참조 정합성 ----

function countingFetch(jobCount: number, opts: { delayMs?: number } = {}) {
  const calls = { overview: 0, jobsOverview: 0, detail: 0, active: 0, maxActive: 0 };
  const jobs = Array.from({ length: jobCount }, (_, i) => ({
    ...(fixture("jobs-overview.json") as { jobs: Array<Record<string, unknown>> }).jobs[0]!,
    jid: i.toString(16).padStart(32, "0"),
    name: `beluga-job_${i}`,
  }));
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.active += 1;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    try {
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.delayMs);
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
        });
      }
      if (path === "/overview") { calls.overview += 1; return json(fixture("overview.json")); }
      if (path === "/jobs/overview") { calls.jobsOverview += 1; return json({ jobs }); }
      calls.detail += 1;
      return json({ ...(fixture("job-cdc_orders.json") as object), jid: path.replace("/jobs/", "") });
    } finally {
      calls.active -= 1;
    }
  }) as typeof fetch;
  return { impl, calls, jobs };
}

test("동시 inbound 요청 N개는 하나의 snapshot 구성으로 합쳐진다(overview 1 + detail <= MAX_JOBS)", async () => {
  const { impl, calls } = countingFetch(150, { delayMs: 5 });
  const adapter = adapterWith(impl, { cacheTtlMs: 5000, snapshotBudgetMs: 5000 });
  const results = await Promise.all(Array.from({ length: 20 }, () => adapter.listPipelines()));

  expect(calls.jobsOverview).toBe(1);
  expect(calls.detail).toBeLessThanOrEqual(100);
  expect(calls.maxActive).toBeLessThanOrEqual(8); // 전역 동시성 상한
  expect(results.every((r) => r === results[0])).toBe(true);
  expect(results[0]!.pipelines).toHaveLength(100);
  expect(results[0]!.warnings.map((w) => w.code)).toContain("TRUNCATED");
});

test("캐시는 TTL 동안 재사용되고 만료되면 다시 읽는다", async () => {
  const { impl, calls } = countingFetch(3);
  let nowMs = Date.parse("2026-10-07T00:00:00Z");
  const adapter = new FlinkAdapter({ config: { ...config, cacheTtlMs: 5000 }, fetchImpl: impl, now: () => new Date(nowMs) });

  await adapter.listPipelines();
  nowMs += 4999;
  await adapter.listPipelines();
  expect(calls.jobsOverview).toBe(1);
  nowMs += 2;
  await adapter.listPipelines();
  expect(calls.jobsOverview).toBe(2);
  expect(calls.detail).toBe(6);
});

test("snapshot 전체 예산을 넘으면 읽은 만큼만 반환하고 PARTIAL 경고를 붙이며 예산 안에 끝난다", async () => {
  // 개별 timeout(5s)은 길지만 예산(60ms)이 먼저 적용된다. overview는 빠르고 detail은 느리다.
  const { jobs } = countingFetch(10);
  const slowDetails = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/jobs/overview") return json({ jobs });
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }) as typeof fetch;
  const adapter = adapterWith(slowDetails, { timeoutMs: 5000, snapshotBudgetMs: 60, maxConcurrency: 2 });

  const started = Date.now();
  const { pipelines, warnings } = await adapter.listPipelines();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(pipelines).toHaveLength(10);
  expect(warnings.map((w) => w.code)).toEqual(["PARTIAL"]);
  expect(warnings[0]!.message).toContain("time budget exceeded");
});

test("예산 안에 /jobs/overview도 못 받으면 UPSTREAM_UNAVAILABLE이다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const hang = ((_i: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
  const { warnings } = await adapterWith(hang, { timeoutMs: 5000, snapshotBudgetMs: 30 }).listPipelines();
  expect(warnings[0]!.code).toBe("UPSTREAM_UNAVAILABLE");
});

test("전역 동시성 상한은 snapshot과 services 호출을 합쳐서도 지켜진다", async () => {
  const { impl, calls } = countingFetch(30, { delayMs: 3 });
  const adapter = adapterWith(impl, { maxConcurrency: 3 });
  await Promise.all([adapter.listPipelines(), adapter.getHealth(), adapter.getVersion()]);
  expect(calls.maxActive).toBeLessThanOrEqual(3);
});

test("GET by id는 신선한 snapshot 캐시가 있으면 upstream을 호출하지 않는다", async () => {
  const { impl, calls, jobs } = countingFetch(5);
  const adapter = adapterWith(impl, { cacheTtlMs: 5000 });
  await adapter.listPipelines();
  const before = { ...calls };
  const found = await adapter.getPipeline(`pl-flink-${jobs[2]!["jid"] as string}`);

  expect(found.pipeline).toBeDefined();
  expect(calls.jobsOverview).toBe(before.jobsOverview);
  expect(calls.detail).toBe(before.detail);
});

test("JobManager가 내려가 있으면 GET by id는 가짜 404가 아니라 503이다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const app = createApp(undefined, undefined, adapterWith(refused));
  const res = await app.request(`/api/v1/pipelines/pl-flink-${JIDS.orders}`);

  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  expect(body.error.message).toContain("unreachable");
  // 형식이 다른 id는 upstream 상태와 무관하게 404(호출 없음).
  expect((await app.request("/api/v1/pipelines/pl-lakehouse-ingest")).status).toBe(404);
});

test("JobManager가 정상이고 job이 없으면 GET by id는 404이다", async () => {
  const app = createApp(undefined, undefined, adapterWith(recordedFetch({ details: liveDetails })));
  expect((await app.request(`/api/v1/pipelines/pl-flink-${"f".repeat(32)}`)).status).toBe(404);
});

test("본문 상한은 스트리밍 중에 적용되어 초과 즉시 읽기를 중단한다", async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() { cancelled = true; },
  });
  const huge = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const client = new FlinkRestClient({ ...config, maxBodyBytes: 4096, fetchImpl: huge });

  await expect(client.getOverview()).rejects.toMatchObject({ kind: "invalid-response" });
  expect(pulled).toBeLessThan(10); // 무한 스트림을 끝까지 읽지 않는다.
  expect(cancelled).toBe(true);

  const declared = (async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } })) as typeof fetch;
  await expect(new FlinkRestClient({ ...config, maxBodyBytes: 4096, fetchImpl: declared }).getOverview()).rejects.toMatchObject({ kind: "invalid-response" });
});

test("어댑터가 켜지면 다른 route의 stub pipeline 참조는 해석 불가이므로 null이 되고, 꺼져 있으면 그대로이다", async () => {
  const refs = async (app: ReturnType<typeof createApp>, path: string) =>
    ((await (await app.request(`${path}?pageSize=100`)).json()) as { data: Array<{ relatedPipelineId: string | null }> }).data.map((d) => d.relatedPipelineId);

  const live = createApp(undefined, undefined, adapterWith(recordedFetch({ details: liveDetails })));
  for (const path of ["/api/v1/events", "/api/v1/resources", "/api/v1/decisions"]) {
    const ids = await refs(live, path);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === null)).toBe(true);
  }
  const stub = createApp();
  const stubIds = [...(await refs(stub, "/api/v1/events")), ...(await refs(stub, "/api/v1/resources")), ...(await refs(stub, "/api/v1/decisions"))];
  expect(stubIds.some((id) => id === "pl-lakehouse-ingest")).toBe(true);
});

test("서로 다른 유효 jid를 대량으로 by-id 조회해도 upstream 호출은 job 수로 제한된다(요청 수에 비례하지 않음)", async () => {
  const { impl, calls, jobs } = countingFetch(100, { delayMs: 2 });
  const adapter = adapterWith(impl, { cacheTtlMs: 5000, maxQueue: 1000 });
  const ids = jobs.map((j) => `pl-flink-${j["jid"] as string}`);
  const burst = () => Promise.all(Array.from({ length: 1100 }, (_, i) => adapter.getPipeline(ids[i % ids.length]!)));

  const first = await burst();
  expect(first.every((r) => r.pipeline !== undefined)).toBe(true);
  expect(calls.jobsOverview).toBe(1);
  expect(calls.detail).toBe(100); // job당 1회
  await burst(); // TTL 안의 반복은 upstream을 호출하지 않는다.
  expect(calls.jobsOverview).toBe(1);
  expect(calls.detail).toBe(100);
});

// ---- client 대기열 ----
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { opened, release };
}

test("대기열이 가득 차면 기다리지 않고 즉시 overloaded로 거부한다", async () => {
  const g = gate();
  const impl = (async () => { await g.opened; return json(fixture("overview.json")); }) as typeof fetch;
  const client = new FlinkRestClient({ ...config, timeoutMs: 5000, maxConcurrency: 1, maxQueue: 1, fetchImpl: impl });

  const active = client.getOverview(); // 슬롯 점유
  const queued = client.getOverview(); // 대기열 1/1
  const rejected = await client.getOverview().catch((e: unknown) => e);
  expect(rejected).toMatchObject({ kind: "overloaded" });
  g.release();
  await expect(active).resolves.toBeDefined();
  await expect(queued).resolves.toBeDefined();
});

test("슬롯 대기 시간도 timeout에 포함되고, 대기 중 만료/abort되어도 슬롯이 새지 않는다", async () => {
  let hold = true;
  const impl = ((_i: unknown, init?: RequestInit) =>
    hold
      ? new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : Promise.resolve(json(fixture("overview.json")))) as typeof fetch;
  const client = new FlinkRestClient({ ...config, timeoutMs: 40, maxConcurrency: 1, maxQueue: 10, fetchImpl: impl });

  const started = Date.now();
  const first = client.getOverview().catch((e: unknown) => e); // 슬롯 점유, 40ms에 timeout
  const waiting = client.getOverview().catch((e: unknown) => e); // 대기 중 같은 40ms 데드라인
  const ctl = new AbortController();
  const aborted = client.getOverview(ctl.signal).catch((e: unknown) => e);
  ctl.abort(); // 대기 중 외부 abort
  expect(await aborted).toMatchObject({ kind: "timeout" });
  expect(await first).toMatchObject({ kind: "timeout" });
  expect(await waiting).toMatchObject({ kind: "timeout" });
  expect(Date.now() - started).toBeLessThan(500); // 요청당 40ms가 직렬로 쌓이지 않는다.

  hold = false; // 슬롯/대기열 누수가 없으면 새 요청이 바로 성공한다.
  await expect(client.getOverview()).resolves.toMatchObject({ "flink-version": "1.20.0" });
  await expect(client.getOverview()).resolves.toBeDefined();
});

test("대기열이 가득 차면 adapter는 health를 unknown으로 낮춘다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const g = gate();
  const impl = (async () => { await g.opened; return json(fixture("jobs-overview.json")); }) as typeof fetch;
  const adapter = adapterWith(impl, { timeoutMs: 5000, maxConcurrency: 1, maxQueue: 0 });
  const busy = adapter.getPipeline(`pl-flink-${JIDS.orders}`); // overview가 유일한 슬롯 점유
  await new Promise((r) => setTimeout(r, 5));
  const other = await adapter.getHealth(); // 서비스 health도 대기열 없이 거부 -> unknown
  expect(other.status).toBe("unknown");
  g.release();
  await busy;
});

// ---- 라운드 3: by-id는 list와 같은 snapshot에서, 불완전하면 503, 일시 실패는 캐시하지 않음 ----

test("by-id는 snapshot 1회 구성으로 처리되고 동시 호출은 합쳐진다", async () => {
  const { impl, calls, jobs } = countingFetch(50);
  const adapter = adapterWith(impl, { cacheTtlMs: 5000 });
  const lookups = await Promise.all(jobs.slice(0, 10).map((j) => adapter.getPipeline(`pl-flink-${j["jid"] as string}`)));

  expect(lookups.every((l) => l.pipeline !== undefined && !l.unavailable)).toBe(true);
  expect(calls.jobsOverview).toBe(1);
  expect(calls.detail).toBe(50); // snapshot 1회: job당 상세 1건
});

test("같은 id를 반복 조회하면 TTL당 snapshot 1회이고 만료되면 다시 읽는다", async () => {
  const { impl, calls, jobs } = countingFetch(5);
  let nowMs = Date.parse("2026-10-07T00:00:00Z");
  const adapter = new FlinkAdapter({ config: { ...config, cacheTtlMs: 5000 }, fetchImpl: impl, now: () => new Date(nowMs) });
  const id = `pl-flink-${jobs[1]!["jid"] as string}`;

  for (let i = 0; i < 50; i++) await adapter.getPipeline(id);
  expect(calls.jobsOverview).toBe(1);
  nowMs += 5001;
  await adapter.getPipeline(id);
  expect(calls.jobsOverview).toBe(2);
});

test("서로 다른 id가 캐시 크기(256)를 넘어도 upstream 비용은 TTL당 snapshot 1회(<=1+100)로 유지된다", async () => {
  const { impl, calls } = countingFetch(300);
  const adapter = adapterWith(impl, { cacheTtlMs: 5000, maxQueue: 1000 });
  const ids = Array.from({ length: 300 }, (_, i) => `pl-flink-${i.toString(16).padStart(32, "0")}`);
  const burst = () => Promise.all(ids.map((id) => adapter.getPipeline(id)));

  const first = await burst();
  const afterFirst = calls.jobsOverview + calls.detail;
  expect(afterFirst).toBe(1 + 100); // MAX_JOBS 상한
  const second = await burst();
  expect(calls.jobsOverview + calls.detail).toBe(afterFirst); // 반복은 upstream 호출 0
  expect(second).toEqual(first);
  // 상한(100) 밖의 job은 목록과 같이 주소 지정되지 않는다(문서화된 한계).
  expect(first.filter((l) => l.pipeline !== undefined)).toHaveLength(100);
});

test("상세가 누락된(불완전한) pipeline은 by-id에서 깨끗한 200이 아니라 unavailable(503)이다 — list에는 PARTIAL로 남는다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const impl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/jobs/overview") return json(fixture("jobs-overview.json"));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const adapter = adapterWith(impl, { cacheTtlMs: 5000 });
  const id = `pl-flink-${JIDS.orders}`;

  const lookup = await adapter.getPipeline(id);
  expect(lookup.unavailable).toBe(true);
  expect(lookup.pipeline).toBeUndefined();
  expect(lookup.warnings.map((w) => w.code)).toEqual(["PARTIAL"]);
  const list = await adapter.listPipelines();
  expect(list.pipelines.find((p) => p.id === id)).toBeDefined();
  expect(list.warnings.map((w) => w.code)).toEqual(["PARTIAL"]);

  const app = createApp(undefined, undefined, adapter);
  const res = await app.request(`/api/v1/pipelines/${id}`);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
});

test("실제 upstream 오류(500)는 최대 1s만 기억되어 재시도 폭주를 막는다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let detailCalls = 0;
  const jobs = (fixture("jobs-overview.json") as { jobs: unknown[] }).jobs;
  const impl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/jobs/overview") return json({ jobs });
    detailCalls += 1;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  let nowMs = Date.parse("2026-10-07T00:00:00Z");
  const adapter = new FlinkAdapter({ config: { ...config, cacheTtlMs: 5000 }, fetchImpl: impl, now: () => new Date(nowMs) });
  for (let i = 0; i < 20; i++) expect((await adapter.getPipeline(`pl-flink-${JIDS.orders}`)).unavailable).toBe(true);
  expect(detailCalls).toBe(3); // job 3개의 상세 각 1회(snapshot 1회)
  nowMs += 1001;
  await adapter.getPipeline(`pl-flink-${JIDS.orders}`);
  expect(detailCalls).toBe(6);
});

test("overloaded/timeout 상세 실패는 by-id에서 unavailable이며 캐시되지 않아 복구 즉시 반영된다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const mode of ["overloaded", "timeout"] as const) {
    let healthy = false;
    const hang = (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const impl = ((input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (healthy) return Promise.resolve(path === "/jobs/overview" ? json(fixture("jobs-overview.json")) : json(liveDetails[path.replace("/jobs/", "") as keyof typeof liveDetails]));
      if (path === "/jobs/overview") return Promise.resolve(json(fixture("jobs-overview.json")));
      return hang(input, init);
    }) as typeof fetch;
    // overloaded: 동시성 1 + 대기열 0 이면 두 번째 상세부터 즉시 거부. timeout: 상세가 응답하지 않음.
    const overrides = mode === "overloaded" ? { maxConcurrency: 1, maxQueue: 0, timeoutMs: 30 } : { timeoutMs: 30 };
    const adapter = adapterWith(impl, { cacheTtlMs: 5000, ...overrides });
    const ids = [JIDS.orders, JIDS.customers, JIDS.events].map((j) => `pl-flink-${j}`);

    const during = await Promise.all(ids.map((id) => adapter.getPipeline(id)));
    expect(during.filter((l) => l.pipeline !== undefined && !l.unavailable)).toHaveLength(0); // 불완전한 객체는 깨끗하게 나가지 않는다
    expect(during.every((l) => l.unavailable)).toBe(true);

    healthy = true; // 복구: 일시 실패는 캐시되지 않으므로 바로 완전한 객체가 나온다.
    const after = await adapter.getPipeline(ids[0]!);
    expect(after.unavailable).toBe(false);
    expect(after.pipeline?.stages.map((s) => s.serviceType)).toEqual(["flink", "iceberg"]);
  }
});

test("list의 일시 실패 snapshot도 캐시되지 않고, 경고가 응답에 남는다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let healthy = false;
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/jobs/overview") return Promise.resolve(json(fixture("jobs-overview.json")));
    if (healthy) return Promise.resolve(json(liveDetails[path.replace("/jobs/", "") as keyof typeof liveDetails]));
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }) as typeof fetch;
  const adapter = adapterWith(impl, { cacheTtlMs: 5000, timeoutMs: 30 });

  const degraded = await adapter.listPipelines();
  expect(degraded.warnings.map((w) => w.code)).toEqual(["PARTIAL"]);
  healthy = true;
  const recovered = await adapter.listPipelines();
  expect(recovered.warnings).toEqual([]);
  expect(recovered.pipelines.every((p) => p.stages.length === 2)).toBe(true);
});
