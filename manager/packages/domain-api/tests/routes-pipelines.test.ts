import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { pipelineJobSchema, pipelineSchema } from "../src/schema/pipeline.js";
import { pipelines } from "../src/stub-data/pipelines.js";

const pipelineListResponseSchema = listResponseSchema(pipelineSchema, "PipelineListResponseTest");

test("GET /api/v1/pipelines는 스키마와 정확히 일치하는 목록 envelope을 반환하고 correlation을 포함한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines");

  expect(res.status).toBe(200);
  const body = pipelineListResponseSchema.parse(await res.json());
  expect(body.meta.total).toBe(pipelines.length);
  for (const pipeline of body.data) {
    expect(pipeline.correlation.confidence).toBeGreaterThanOrEqual(0);
    expect(pipeline.correlation.confidence).toBeLessThanOrEqual(1);
    expect(typeof pipeline.correlation.method).toBe("string");
  }
});

test("GET /api/v1/pipelines/{id}는 단일 파이프라인을 스키마 그대로 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines/pl-lakehouse-ingest");

  expect(res.status).toBe(200);
  const body = pipelineSchema.parse(await res.json());
  expect(body.correlation.method).toBe("declared");
});

test("GET /api/v1/pipelines/{id}는 존재하지 않는 id에 대해 일관된 404 모양을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines/does-not-exist");

  expect(res.status).toBe(404);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("NOT_FOUND");
});

test("page/pageSize가 실제로 stub 데이터를 슬라이스한다", async () => {
  const app = createApp();
  const page1 = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines?page=1&pageSize=1")).json());
  const page2 = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines?page=2&pageSize=1")).json());

  expect(page1.data).toHaveLength(1);
  expect(page2.data).toHaveLength(1);
  expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
  expect(page1.meta).toEqual({ total: pipelines.length, page: 1, pageSize: 1 });
});

test("?status= 필터는 aggregate status가 일치하는 파이프라인만 남긴다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines?status=healthy");
  const body = pipelineListResponseSchema.parse(await res.json());

  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((pipeline) => pipeline.status === "healthy")).toBe(true);
  expect(body.warnings).toBeUndefined();
});

test("healthy가 아닌 파이프라인이 있으면 warnings가 나타나고 serviceId는 null이다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/pipelines");
  const body = pipelineListResponseSchema.parse(await res.json());

  expect(body.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "DEGRADED", serviceId: null }),
      expect.objectContaining({ code: "UNAVAILABLE", serviceId: null }),
    ]),
  );
});

test("pipeline 응답은 항상 jobs 배열을 포함하고 실패한 실행은 failureReason을 가진다", async () => {
  const app = createApp();
  const body = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines")).json());

  for (const pipeline of body.data) {
    expect(Array.isArray(pipeline.jobs)).toBe(true);
    for (const job of pipeline.jobs) {
      if (job.lastRun?.result === "failed") expect(job.lastRun.failureReason).not.toBeNull();
    }
  }
  expect(body.data.some((pipeline) => pipeline.jobs.length > 0)).toBe(true);
});

test("jobs가 없는 pipeline 입력은 jobs: []로 파싱된다", () => {
  const { jobs: _jobs, ...withoutJobs } = pipelines[0]!;
  expect(pipelineSchema.parse(withoutJobs).jobs).toEqual([]);
});

test("lastRun이 null이거나 finishedAt이 null인 running job은 스키마를 통과한다", () => {
  const base = { id: "j", name: "j", kind: "flink", serviceId: "svc-flink", relatedResourceIds: [] };
  expect(pipelineJobSchema.parse({ ...base, lastRun: null }).lastRun).toBeNull();
  const running = pipelineJobSchema.parse({
    ...base,
    lastRun: { result: "running", startedAt: "2026-09-21T05:00:00.000Z", finishedAt: null, failureReason: null },
  });
  expect(running.lastRun?.finishedAt).toBeNull();
});

test("correlationLinks는 읽기 전용으로 노출되고 4개 relation 쌍과 낮은 확신도 링크를 포함한다", async () => {
  const app = createApp();
  const body = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines")).json());
  const links = body.data.flatMap((pipeline) => pipeline.correlationLinks);

  expect(new Set(links.map((link) => link.relation))).toEqual(
    new Set(["topic-feeds-job", "job-writes-table", "table-served-by-catalog", "dag-triggers-job"]),
  );
  expect(links.some((link) => link.confidence < 0.5 && link.method === "ambiguous-name-convention")).toBe(true);
  expect(links.some((link) => link.method === "declared-label" && link.confidence >= 0.9)).toBe(true);
  // 링크가 없는 파이프라인(unknown)은 빈 배열로 하위 호환.
  expect(body.data.find((pipeline) => pipeline.id === "pl-cluster-observability")?.correlationLinks).toEqual([]);
});

test("correlationLinks 없이 입력된 Pipeline은 빈 배열로 기본값을 갖는다", () => {
  const parsed = pipelineSchema.parse({
    id: "pl-x", name: "x", stages: [], status: "healthy",
    correlation: { confidence: 1, method: "declared" }, lastUpdatedAt: "2026-09-21T00:00:00.000Z",
  });
  expect(parsed.correlationLinks).toEqual([]);
});

test("모든 correlation link는 evidence를 갖고 id가 유일하며 endpoint가 relation의 kind와 일치한다", async () => {
  const app = createApp();
  const body = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines")).json());
  const kinds = {
    "topic-feeds-job": ["kafka-topic", "flink-job"],
    "job-writes-table": ["flink-job", "iceberg-table"],
    "table-served-by-catalog": ["iceberg-table", "trino-catalog"],
    "dag-triggers-job": ["airflow-dag", "flink-job"],
  } as const;
  for (const pipeline of body.data) {
    const ids = pipeline.correlationLinks.map((link) => link.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of pipeline.correlationLinks) {
      expect(link.evidence.length).toBeGreaterThan(0);
      expect([link.source.kind, link.target.kind]).toEqual(kinds[link.relation]);
    }
  }
});

test("job correlation endpoint는 같은 Pipeline의 jobs에 존재한다", async () => {
  const app = createApp();
  const body = pipelineListResponseSchema.parse(await (await app.request("/api/v1/pipelines")).json());
  const jobKinds = { "flink-job": "flink", "airflow-dag": "airflow" } as const;

  for (const pipeline of body.data) {
    for (const link of pipeline.correlationLinks) {
      for (const endpoint of [link.source, link.target]) {
        if (endpoint.kind in jobKinds) {
          const kind = jobKinds[endpoint.kind as keyof typeof jobKinds];
          expect(pipeline.jobs.some((job) => job.id === endpoint.id && job.kind === kind)).toBe(true);
        }
      }
    }
  }
});
