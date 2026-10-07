// Flink JobManager REST 클라이언트 — 읽기 전용(GET만) 경계. 문서(Flink 1.20):
// https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/rest_api/
// 사용 endpoint: GET /overview, GET /jobs/overview, GET /jobs/{jobid}.
// 이 모듈은 어떤 변경성 요청(POST/PATCH/DELETE, job cancel/savepoint 등)도 만들 수 없게
// 요청 메서드와 경로 집합을 고정한다. 오류는 FlinkClientError로 분류해서 던지고, 호출자(adapter)가
// 이를 health/warning으로 낮춘다 — route까지 전파되지 않는다.
import { z } from "@hono/zod-openapi";

export type FlinkErrorKind = "unreachable" | "timeout" | "http-error" | "invalid-response" | "overloaded";

export class FlinkClientError extends Error {
  constructor(
    readonly kind: FlinkErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FlinkClientError";
  }
}

// 응답 본문 상한(바이트): 정상 응답(jobs/{id}는 plan 포함)은 수 KB지만 오작동/악성 응답이 메모리를
// 쓰지 못하게 한다. content-length 사전 검사 + 스트리밍 중 누적 바이트 검사로 상한을 넘으면 읽기를 중단한다.
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENCY = 8;
// 슬롯을 기다리는 요청 대기열 상한: 넘으면 기다리지 않고 즉시 overloaded로 거부한다(메모리/지연 무한 증가 방지).
export const DEFAULT_MAX_QUEUE = 64;

// Flink는 알 수 없는 상태 문자열이 추가될 수 있으므로 state는 enum이 아니라 string으로 받고
// 매핑 표에서 보수적으로 처리한다(mapping.ts).
const epochMs = z.number().finite();

export const flinkOverviewSchema = z.object({
  "flink-version": z.string().min(1),
  taskmanagers: z.number().int().nonnegative(),
  "slots-total": z.number().int().nonnegative(),
  "slots-available": z.number().int().nonnegative(),
  "jobs-running": z.number().int().nonnegative(),
});

export const flinkJobSummarySchema = z.object({
  jid: z.string().regex(/^[0-9a-f]{32}$/),
  name: z.string().min(1),
  state: z.string().min(1),
  "start-time": epochMs,
  "end-time": epochMs,
  "last-modification": epochMs,
  tasks: z.record(z.string(), z.number()).default({}),
});

export const flinkJobsOverviewSchema = z.object({ jobs: z.array(flinkJobSummarySchema) });

export const flinkJobDetailSchema = z.object({
  jid: z.string().regex(/^[0-9a-f]{32}$/),
  state: z.string().min(1),
  vertices: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
});

export type FlinkOverview = z.infer<typeof flinkOverviewSchema>;
export type FlinkJobSummary = z.infer<typeof flinkJobSummarySchema>;
export type FlinkJobDetail = z.infer<typeof flinkJobDetailSchema>;

export interface FlinkClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** 이 클라이언트가 동시에 진행하는 upstream 요청의 전역 상한(요청 단위 timeout은 슬롯을 얻은 뒤 시작). */
  maxConcurrency?: number;
  maxQueue?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

export class FlinkRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxConcurrency: number;
  private readonly maxBodyBytes: number;
  private readonly maxQueue: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: FlinkClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  }

  getOverview(signal?: AbortSignal): Promise<FlinkOverview> {
    return this.get("/overview", flinkOverviewSchema, signal);
  }

  async getJobsOverview(signal?: AbortSignal): Promise<FlinkJobSummary[]> {
    return (await this.get("/jobs/overview", flinkJobsOverviewSchema, signal)).jobs;
  }

  getJob(jobId: string, signal?: AbortSignal): Promise<FlinkJobDetail> {
    // 경로 보간 전에 형식을 고정한다 — upstream이 돌려준 jid가 경로를 바꾸지 못하게 한다.
    if (!/^[0-9a-f]{32}$/.test(jobId)) {
      throw new FlinkClientError("invalid-response", "Job id is not a 32-character hex string");
    }
    return this.get(`/jobs/${jobId}`, flinkJobDetailSchema, signal);
  }

  // 전역 동시성 슬롯. 대기 중 abort(예: snapshot 예산 초과)되면 슬롯을 얻지 않고 timeout으로 끝낸다.
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new FlinkClientError("timeout", "Flink REST request timed out or was cancelled while waiting for a slot"));
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new FlinkClientError("overloaded", "Flink REST request queue is full"));
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(); // 슬롯은 release()가 넘겨준다(active 유지).
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new FlinkClientError("timeout", "Flink REST request timed out or was cancelled while waiting for a slot"));
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async get<T>(path: string, schema: z.ZodType<T>, external?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const onExternal = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternal, { once: true });
    }
    // 데드라인은 요청이 들어온 시점(슬롯 대기 포함)부터 시작한다 — 대기열에서도 timeoutMs를 넘기지 못한다.
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let acquired = false;
    try {
      await this.acquire(controller.signal);
      acquired = true;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (err) {
        throw this.classifyTransport(err, controller.signal);
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new FlinkClientError("http-error", `Flink REST ${path} returned HTTP ${res.status}`, res.status);
      }
      let text: string;
      try {
        text = await this.readCapped(res, path);
      } catch (err) {
        if (err instanceof FlinkClientError) throw err;
        throw this.classifyTransport(err, controller.signal);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new FlinkClientError("invalid-response", `Flink REST ${path} returned malformed JSON`);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new FlinkClientError("invalid-response", `Flink REST ${path} returned an unexpected shape`);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
      if (acquired) this.release();
    }
  }

  // 본문을 스트리밍으로 읽으며 누적 바이트가 상한을 넘으면 즉시 취소한다.
  private async readCapped(res: Response, path: string): Promise<string> {
    const tooLarge = () =>
      new FlinkClientError("invalid-response", `Flink REST ${path} response exceeds ${this.maxBodyBytes} bytes`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      void res.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBodyBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  private classifyTransport(err: unknown, signal: AbortSignal): FlinkClientError {
    if (signal.aborted) {
      return new FlinkClientError("timeout", `Flink REST did not respond within ${this.options.timeoutMs}ms`);
    }
    // 내부 호스트/오류 세부사항은 메시지에 싣지 않는다.
    void err;
    return new FlinkClientError("unreachable", "Flink REST is unreachable");
  }
}
