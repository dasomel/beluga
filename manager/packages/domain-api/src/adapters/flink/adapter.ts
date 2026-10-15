// Flink JobManager 읽기 전용 어댑터(이슈 #16/#35/#41). ServiceAdapter(svc-flink)와 PipelineAdapter를 함께 구현한다.
// 설정이 없으면 만들어지지 않는다(config.ts) — 기본은 stub. 어떤 메서드도 throw하지 않는다.
import type { FlinkAdapterConfig } from "../../config.js";
import type { ListWarning } from "../../schema/envelope.js";
import type { HealthStatus } from "../../schema/health.js";
import type { AdapterHealth, AdapterMetadata, ServiceAdapter } from "../types.js";
import type { PipelineAdapter, PipelineLookup, PipelineSnapshot } from "../pipelineAdapter.js";
import { FlinkClientError, FlinkRestClient, type FlinkErrorKind, type FlinkJobDetail, type FlinkJobSummary, type FlinkOverview } from "./client.js";
import { buildPipelines, FLINK_SERVICE_ID, PIPELINE_ID_PATTERN, pipelineIdFor, type FlinkJobInput } from "./mapping.js";

// D1: 상세 조회(/jobs/{id}) 상한. 오래된 job 이력이 많은 클러스터에서 요청 폭주를 막는다.
const MAX_JOBS = 100;
// D2: 마지막 확인으로부터 이 시간이 지나면 클라이언트가 stale로 취급한다(stub의 60s와 같은 규모).
const STALE_AFTER_MS = 60_000;

export interface FlinkAdapterOptions {
  config: FlinkAdapterConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

// 단일 비행(single-flight) + 짧은 TTL 캐시. 동시에 들어온 호출은 하나의 진행 중 작업을 공유하고, 결과는
// 로더가 정한 ttlMs 동안 재사용한다(0이면 재사용 안 함). 거부(throw)된 결과는 캐시하지 않는다.
class SingleFlightCache<T> {
  private entry: { value: T; expiresAt: number } | undefined;
  private inflight: Promise<T> | undefined;

  constructor(private readonly clock: () => number) {}

  get(load: () => Promise<{ value: T; ttlMs: number }>): Promise<T> {
    if (this.entry && this.clock() < this.entry.expiresAt) return Promise.resolve(this.entry.value);
    if (!this.inflight) {
      const p = load().then(({ value, ttlMs }) => {
        this.entry = { value, expiresAt: this.clock() + ttlMs };
        return value;
      });
      this.inflight = p;
      const clear = () => {
        if (this.inflight === p) this.inflight = undefined;
      };
      p.then(clear, clear);
    }
    return this.inflight;
  }
}

// D4: 일시적 실패(대기열 포화, timeout, 연결 불가)는 절대 캐시하지 않는다 — 부하 때문에 거부된 결과가 TTL 동안
// 그대로 서빙되면 안 된다. 실제 upstream 응답 오류(http-error, invalid-response)만 최대 1s 짧게 기억한다.
const TRANSIENT_KINDS = new Set<FlinkErrorKind>(["overloaded", "timeout", "unreachable"]);
const NEGATIVE_TTL_CAP_MS = 1000;

interface BuiltSnapshot {
  value: PipelineSnapshot;
  ttlMs: number;
}

export class FlinkAdapter implements ServiceAdapter, PipelineAdapter {
  readonly id = FLINK_SERVICE_ID;
  readonly name = "Flink";
  readonly type = "flink" as const;
  readonly contractVersion = 1;

  private readonly client: FlinkRestClient;
  private readonly now: () => Date;
  private readonly overviewCache: SingleFlightCache<FlinkOverview>;
  private readonly snapshotCache: SingleFlightCache<PipelineSnapshot>;

  constructor(private readonly options: FlinkAdapterOptions) {
    const { config } = options;
    this.client = new FlinkRestClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      maxQueue: config.maxQueue,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.now = options.now ?? (() => new Date());
    const clock = () => this.now().getTime();
    this.overviewCache = new SingleFlightCache(clock);
    this.snapshotCache = new SingleFlightCache(clock);
  }

  // registry가 metadata/version/health를 병렬로 부르므로 하나의 요청을 공유하고 TTL 동안 재사용한다.
  private overview(): Promise<FlinkOverview> {
    return this.overviewCache.get(async () => ({ value: await this.client.getOverview(), ttlMs: this.options.config.cacheTtlMs }));
  }

  async getMetadata(): Promise<AdapterMetadata> {
    const base: AdapterMetadata = {
      endpoint: null, // 내부 REST 주소는 노출하지 않는다.
      capabilities: ["job.list"],
      capabilityCategories: ["processing"],
      namespace: null,
      workloadRef: null,
      keyMetrics: [],
      dependencies: [],
    };
    try {
      const o = await this.overview();
      const metric = (name: string, value: number) => ({ name, value: String(value), unit: null });
      return {
        ...base,
        keyMetrics: [
          metric("TaskManagers", o.taskmanagers),
          metric("Slots total", o["slots-total"]),
          metric("Slots available", o["slots-available"]),
          metric("Jobs running", o["jobs-running"]),
        ],
      };
    } catch {
      return base;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      return (await this.overview())["flink-version"];
    } catch {
      return null;
    }
  }

  async getHealth(): Promise<AdapterHealth> {
    let status: HealthStatus;
    try {
      await this.overview();
      status = "healthy";
    } catch (err) {
      status = healthFor(err);
    }
    return { status, lastCheckedAt: this.now().toISOString(), staleAfterMs: STALE_AFTER_MS };
  }

  // 한 번의 구성은 1 /jobs/overview + 최대 MAX_JOBS개의 /jobs/{id}이며, 동시 호출은 합쳐지고 완전한 결과는 TTL 동안 캐시된다.
  listPipelines(): Promise<PipelineSnapshot> {
    return this.snapshotCache.get(() => this.buildSnapshot());
  }

  private async buildSnapshot(): Promise<BuiltSnapshot> {
    const { cacheTtlMs, snapshotBudgetMs, maxConcurrency, jobNamePrefix } = this.options.config;
    const warnings: ListWarning[] = [];
    const incompletePipelineIds: string[] = [];
    let transient = false; // 일시적 실패가 하나라도 있으면 이 결과는 캐시하지 않는다.
    let genuine = false; // 실제 upstream 응답 오류만 있으면 짧게(<=1s) 캐시한다.
    const note = (err: unknown) => {
      if (err instanceof FlinkClientError && !TRANSIENT_KINDS.has(err.kind)) genuine = true;
      else transient = true;
    };
    const result = (snapshot: PipelineSnapshot): BuiltSnapshot => ({
      value: snapshot,
      ttlMs: transient ? 0 : genuine ? Math.min(cacheTtlMs, NEGATIVE_TTL_CAP_MS) : cacheTtlMs,
    });

    // 전체 시간 예산: 초과하면 진행 중/대기 중 요청을 abort하고 읽은 만큼만 반환한다.
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), snapshotBudgetMs);
    try {
      let summaries: FlinkJobSummary[];
      try {
        summaries = await this.client.getJobsOverview(budget.signal);
      } catch (err) {
        note(err);
        return result({ pipelines: [], warnings: [warningFor(err)], incompletePipelineIds });
      }

      const selected = summaries.slice(0, MAX_JOBS);
      if (summaries.length > selected.length) {
        warnings.push({
          code: "TRUNCATED",
          message: `Flink reports ${summaries.length} jobs; only the first ${MAX_JOBS} are shown`,
          serviceId: FLINK_SERVICE_ID,
        });
      }

      const outcomes = await mapLimited(
        selected,
        maxConcurrency,
        async (s): Promise<{ detail: FlinkJobDetail } | { error: unknown }> => {
          if (budget.signal.aborted) return { error: new FlinkClientError("timeout", "snapshot time budget exceeded") };
          try {
            return { detail: await this.client.getJob(s.jid, budget.signal) };
          } catch (error) {
            return { error };
          }
        },
      );
      const inputs: FlinkJobInput[] = [];
      selected.forEach((summary, i) => {
        const outcome = outcomes[i]!;
        if ("detail" in outcome) {
          inputs.push({ summary, detail: outcome.detail });
        } else {
          note(outcome.error);
          incompletePipelineIds.push(pipelineIdFor(summary.jid));
          inputs.push({ summary });
        }
      });
      if (incompletePipelineIds.length > 0) {
        warnings.push({
          code: "PARTIAL",
          message:
            `Flink job details were unavailable for ${incompletePipelineIds.length} job(s)` +
            `${budget.signal.aborted ? " (snapshot time budget exceeded)" : ""}; their sink tables are not shown`,
          serviceId: FLINK_SERVICE_ID,
        });
      }

      const { pipelines, skipped } = buildPipelines(inputs, { jobNamePrefix, now: this.now() });
      if (skipped > 0) {
        genuine = true;
        warnings.push({
          code: "INVALID_JOB",
          message: `${skipped} Flink job(s) could not be mapped to a Pipeline and were skipped`,
          serviceId: FLINK_SERVICE_ID,
        });
      }
      return result({ pipelines, warnings, incompletePipelineIds });
    } finally {
      clearTimeout(timer);
    }
  }

  // 단일 Pipeline 조회는 list와 같은 snapshot(단일 비행 + TTL 캐시)에서 꺼낸다 — 요청 수/서로 다른 id 수와
  // 무관하게 upstream 비용은 snapshot 1회 구성(TTL당)이다. 완전한 객체를 줄 수 없으면(상세 누락) 깨끗한
  // 200이 아니라 unavailable(503)로 보고한다: 단건 응답에는 warnings 필드가 없기 때문이다.
  async getPipeline(id: string): Promise<PipelineLookup> {
    if (!PIPELINE_ID_PATTERN.test(id)) return { pipeline: undefined, warnings: [], unavailable: false };

    const snap = await this.listPipelines();
    if (snap.warnings.some((w) => w.code === "UPSTREAM_UNAVAILABLE")) {
      return { pipeline: undefined, warnings: snap.warnings, unavailable: true };
    }
    const pipeline = snap.pipelines.find((p) => p.id === id);
    if (pipeline && snap.incompletePipelineIds.includes(id)) {
      const partial = snap.warnings.filter((w) => w.code === "PARTIAL");
      return { pipeline: undefined, warnings: partial, unavailable: true };
    }
    return { pipeline, warnings: [], unavailable: false };
  }
}

// unreachable/timeout은 우리 쪽에서 관측할 수 없다는 뜻이지 서비스가 내려갔다는 증거가 아니므로
// unknown이다. 5xx는 응답은 하지만 오류이므로 degraded. 그 밖의 비정상 응답은 unknown.
function healthFor(err: unknown): HealthStatus {
  if (err instanceof FlinkClientError && err.kind === "http-error" && (err.status ?? 0) >= 500) return "degraded";
  return "unknown";
}

function warningFor(err: unknown): ListWarning {
  const kind = err instanceof FlinkClientError ? err.kind : "unreachable";
  const messages: Record<string, string> = {
    unreachable: "Flink JobManager is unreachable; live pipelines are unavailable",
    timeout: "Flink JobManager did not respond in time; live pipelines are unavailable",
    "http-error": "Flink JobManager returned an error response; live pipelines are unavailable",
    "invalid-response": "Flink JobManager returned an unexpected response; live pipelines are unavailable",
    overloaded: "Too many pending Flink JobManager requests; live pipelines are temporarily unavailable",
  };
  console.warn(`Flink adapter: listPipelines failed (${kind})`);
  return { code: "UPSTREAM_UNAVAILABLE", message: messages[kind] ?? messages["unreachable"]!, serviceId: FLINK_SERVICE_ID };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
