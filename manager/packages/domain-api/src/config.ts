// 런타임 설정 로더. Domain API의 모든 upstream 연동은 기본 비활성이다(D1): 환경 변수가 없으면
// stub fixture 동작이 그대로 유지되므로 CI와 로컬 개발은 외부 시스템 없이 돌아간다.
// 잘못된 값은 요청 시점이 아니라 기동 시점에 즉시 실패한다(fail-fast).

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface FlinkAdapterConfig {
  /** Flink JobManager REST base URL (scheme://host[:port], 경로/자격증명 없음). */
  baseUrl: string;
  timeoutMs: number;
  /** correlation 이름 규약 비교 전에 job 이름에서 제거하는 접두어. 빈 문자열이면 제거 안 함. */
  jobNamePrefix: string;
  /** listPipelines snapshot 캐시 TTL(ms). 0이면 캐시 없음(동시 요청 합치기만 유지). */
  cacheTtlMs: number;
  /** snapshot 1회 구성의 전체 시간 예산(ms). 초과 시 읽은 만큼만 반환하고 PARTIAL 경고. */
  snapshotBudgetMs: number;
  /** upstream 요청 전역 동시성 상한. */
  maxConcurrency: number;
  /** 슬롯 대기열 길이 상한. 가득 차면 즉시 거부(unavailable). */
  maxQueue: number;
}

// D2: 2s는 ServiceAdapterRegistry의 기본 3s deadline보다 짧아, 어댑터가 자체 timeout으로 먼저
// 분류된 실패를 낸다. 상한 30s는 요청 핸들러가 무기한 매달리지 않게 하는 안전 한계다.
export const DEFAULT_FLINK_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 30_000;
// D3: 인증 없는 Domain API가 JobManager 부하 증폭기가 되지 않도록 snapshot을 5s 캐시·합치고(단일 비행),
// 구성 예산 5s, 전역 동시 요청 8로 제한한다. 값은 설정으로 조정할 수 있다.
export const DEFAULT_FLINK_CACHE_TTL_MS = 5000;
export const MIN_CACHE_TTL_MS = 1000;
export const DEFAULT_FLINK_SNAPSHOT_BUDGET_MS = 5000;
export const DEFAULT_FLINK_MAX_CONCURRENCY = 8;
export const DEFAULT_FLINK_MAX_QUEUE = 64;
export const DEFAULT_FLINK_JOB_NAME_PREFIX = "beluga-";

export function loadFlinkAdapterConfig(env: Record<string, string | undefined>): FlinkAdapterConfig | undefined {
  const raw = env["BELUGA_FLINK_REST_URL"]?.trim();
  if (raw === undefined || raw === "") return undefined; // 비활성(기본)

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("BELUGA_FLINK_REST_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("BELUGA_FLINK_REST_URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("BELUGA_FLINK_REST_URL must not embed credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new ConfigError("BELUGA_FLINK_REST_URL must be a bare origin (no path, query or fragment)");
  }

  const timeoutMs = intEnv(env, "BELUGA_FLINK_TIMEOUT_MS", DEFAULT_FLINK_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  // D3b: TTL 0은 캐시를 끄므로 인증 없는 호출자가 동시성 상한까지 JobManager를 몰아칠 수 있다.
  // 명시적 BELUGA_FLINK_ALLOW_NO_CACHE=true 없이는 하한(1000ms) 미만을 거부한다.
  const allowNoCache = env["BELUGA_FLINK_ALLOW_NO_CACHE"]?.trim() === "true";
  const cacheTtlMs = intEnv(env, "BELUGA_FLINK_CACHE_TTL_MS", DEFAULT_FLINK_CACHE_TTL_MS, allowNoCache ? 0 : MIN_CACHE_TTL_MS, 60_000);
  const snapshotBudgetMs = intEnv(env, "BELUGA_FLINK_SNAPSHOT_BUDGET_MS", DEFAULT_FLINK_SNAPSHOT_BUDGET_MS, 1, 60_000);
  const maxQueue = intEnv(env, "BELUGA_FLINK_MAX_QUEUE", DEFAULT_FLINK_MAX_QUEUE, 0, 1024);
  const maxConcurrency = intEnv(env, "BELUGA_FLINK_MAX_CONCURRENCY", DEFAULT_FLINK_MAX_CONCURRENCY, 1, 32);

  return {
    baseUrl: url.origin,
    timeoutMs,
    cacheTtlMs,
    snapshotBudgetMs,
    maxConcurrency,
    maxQueue,
    jobNamePrefix: env["BELUGA_FLINK_JOB_NAME_PREFIX"] ?? DEFAULT_FLINK_JOB_NAME_PREFIX,
  };
}

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
