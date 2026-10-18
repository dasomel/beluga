// 런타임 설정 로더. Domain API의 모든 upstream 연동은 기본 비활성이다(D1): 환경 변수가 없으면
// stub fixture 동작이 그대로 유지되므로 CI와 로컬 개발은 외부 시스템 없이 돌아간다.
// 잘못된 값은 요청 시점이 아니라 기동 시점에 즉시 실패한다(fail-fast).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidDnsName } from "./schema/sso.js";

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

export interface SsoAdapterConfig {
  /** Path to the declarative SSO YAML file, or undefined if not configured. */
  filePath?: string;
  isProduction: boolean;
  /** Platform base domain the sso.yaml host labels are resolved against (D-DOM-3). Default: DEFAULT_BASE_DOMAIN. */
  baseDomain?: string;
  /** policies/groups.yaml for write previews in development; default: <sso.yaml dir>/../../policies/groups.yaml. */
  groupsFilePath?: string;
}

// D-DOM-3: sso.yaml declares host labels; the FQDN is <label>.<baseDomain>. The default is the Vagrant domain.
export const DEFAULT_BASE_DOMAIN = "local.beluga.internal";

// Source of the base domain: BASE_DOMAIN, else (production only) derived from OIDC_ISSUER whose host is
// sso.<baseDomain> by construction of the chart, else the Vagrant default outside production. In production a
// missing value is a ConfigError: silently falling back to local.beluga.internal on another environment would
// serve wrong hosts (contractual distrust of a default).
export function resolveBaseDomain(env: Record<string, string | undefined>): string {
  const explicit = env["BASE_DOMAIN"]?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!isValidDnsName(explicit) || !explicit.includes(".")) {
      throw new ConfigError(`BASE_DOMAIN "${explicit}" is not a valid multi-label DNS name`);
    }
    return explicit;
  }
  if (env["NODE_ENV"] !== "production") return DEFAULT_BASE_DOMAIN;
  const issuer = env["OIDC_ISSUER"]?.trim();
  if (issuer !== undefined && issuer !== "") return baseDomainFromIssuer(issuer);
  throw new ConfigError("BASE_DOMAIN (or an OIDC_ISSUER of the form https://sso.<baseDomain>/realms/<realm>) must be set when NODE_ENV=production");
}

// The chart builds OIDC_ISSUER as https://sso.<baseDomain>/realms/<realm>. Deriving a domain from anything else
// (http, an IP, another first label, /auth/realms/...) would silently qualify the sso.yaml hosts with a wrong domain,
// so only that exact shape is accepted and everything else stops startup.
function baseDomainFromIssuer(issuer: string): string {
  const fail = (why: string): never => {
    throw new ConfigError(`OIDC_ISSUER "${issuer}" cannot yield BASE_DOMAIN: ${why} (expected https://sso.<baseDomain>/realms/<realm>)`);
  };
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return fail("not a URL");
  }
  if (url.protocol !== "https:") return fail("protocol is not https");
  if (url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") {
    return fail("credentials, port, query or fragment present");
  }
  if (!/^\/realms\/[^/]+$/.test(url.pathname)) return fail("path is not /realms/<realm>");
  const labels = url.hostname.split(".");
  if (labels.length < 3 || labels[0] !== "sso") return fail("host is not sso.<baseDomain>");
  const domain = labels.slice(1).join(".");
  if (!isValidDnsName(domain)) return fail("derived domain is not a valid DNS name");
  return domain;
}

// D-MSSO-1: Default when unset: resolve gitops/values/sso.yaml relative to package/monorepo location
// ONLY in development/test. In production with no env set, return undefined filePath (not configured).
export function resolveDefaultSsoConfigPath(): string | undefined {
  const candidate = fileURLToPath(new URL("../../../../gitops/values/sso.yaml", import.meta.url));
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function loadSsoAdapterConfig(env: Record<string, string | undefined>): SsoAdapterConfig {
  const isProduction = env["NODE_ENV"] === "production";
  const explicitPath = env["SSO_CONFIG_FILE"]?.trim();

  if (explicitPath !== undefined && explicitPath !== "") {
    return {
      filePath: explicitPath,
      isProduction,
    };
  }

  if (isProduction) {
    return {
      filePath: undefined,
      isProduction: true,
    };
  }

  return {
    filePath: resolveDefaultSsoConfigPath(),
    isProduction: false,
  };
}

export interface AuditDbConfig {
  host: string;
  port: number;
  database: string;
  /** Empty when the writer Secret is absent (optional env ref): the store reports "not ready". */
  user: string;
  passwordFile: string;
  sslCaFile: string;
}

// D-MSSO-11: the audit store is the dedicated CNPG cluster. MANAGER_DB_HOST unset = "not configured" (the Manager
// still serves GET routes; every write route answers 503 AUDIT_UNAVAILABLE). Once the host is set, the rest is
// mandatory and TLS verification cannot be switched off (verify-full against MANAGER_DB_SSL_CA_FILE). Only the
// paths are validated here; files are read when a connection is made, so a Secret that is not mounted yet degrades
// to "audit store unavailable" instead of stopping startup.
export function loadAuditDbConfig(env: Record<string, string | undefined>): AuditDbConfig | undefined {
  const host = env["MANAGER_DB_HOST"]?.trim();
  if (host === undefined || host === "") return undefined;
  if (!isValidDnsName(host)) throw new ConfigError("MANAGER_DB_HOST must be a DNS host name");
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === "") throw new ConfigError(`${name} must be set when MANAGER_DB_HOST is set`);
    return value;
  };
  return {
    host,
    port: intEnv(env, "MANAGER_DB_PORT", 5432, 1, 65535),
    database: required("MANAGER_DB_NAME"),
    user: env["MANAGER_DB_USER"]?.trim() ?? "",
    passwordFile: required("MANAGER_DB_PASSWORD_FILE"),
    sslCaFile: required("MANAGER_DB_SSL_CA_FILE"),
  };
}

// D-MSSO-8: the write switch is off by default and is turned on only after the platform consumer (rollout 2a)
// has been verified live. Anything but an explicit true/false is a configuration error, never a silent default.
export function loadSsoWriteEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["SSO_WRITE_ENABLED"]?.trim();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ConfigError('SSO_WRITE_ENABLED must be "true" or "false"');
}
