// Environment-driven wiring for the optional upstream adapters. Default = everything disabled (stubs /
// 503), so local dev and CI never reach a cluster. No value read here is ever logged; `diagnostics`
// carries only variable names and reasons. Invalid values of an ENABLED adapter throw ConfigError (fail-fast,
// like BELUGA_FLINK_*); booleans are exactly `true`/`false`, integers plain digits within a range.
//
// Trino query history   BELUGA_TRINO_ENABLED=true
//   BELUGA_TRINO_BASE_URL            e.g. http://trino.analytics.svc:8080 (in-cluster) or https://...
//   BELUGA_TRINO_TOKEN_FILE | BELUGA_TRINO_TOKEN   bearer token (file preferred; rotated externally)
//   BELUGA_TRINO_USER                optional X-Trino-User (usually unnecessary with a bearer token)
//   BELUGA_TRINO_HISTORY_ACK=shared-service-credential   REQUIRED: acknowledges that history is the
//                                    service credential's view, shared by every caller (no per-caller authz)
//   BELUGA_TRINO_HISTORY_SQL=literals|none   default `literals` (redact literals/comments)
// Lakekeeper catalog    BELUGA_LAKEKEEPER_ENABLED=true
//   BELUGA_LAKEKEEPER_BASE_URL       origin only; the /catalog base path is appended
//   BELUGA_LAKEKEEPER_BASE_PATH      default /catalog
//   BELUGA_LAKEKEEPER_WAREHOUSES     `warehouse` or `trinoCatalog=warehouse`, comma separated
//   BELUGA_LAKEKEEPER_TOKEN_FILE | BELUGA_LAKEKEEPER_TOKEN
//   BELUGA_LAKEKEEPER_CACHE_TTL_MS   default 5000 (0 = single-flight only)
//   BELUGA_TRINO_HISTORY_CACHE_TTL_MS   default 5000 (0 = single-flight only)
// Shared: BELUGA_UPSTREAM_MAX_CONCURRENT (default 8, per upstream)
//   BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS   default 2000; how long genuine upstream failures are remembered
// Shared: BELUGA_UPSTREAM_TIMEOUT_MS (default 2500), BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER=true
//   (allow bearer over plain http to a non-loopback host, e.g. in-cluster ClusterIP).
import { ConfigError } from "../../config.js";
import type { DataAssetSource } from "../dataAssetSource.js";
import type { QueryHistoryAdapter } from "../queryHistory.js";
import { UpstreamHttpClient } from "./httpClient.js";
import { createLakekeeperDataAssetSource, type LakekeeperCatalogMapping } from "./lakekeeperCatalog.js";
import { fileTokenProvider, normalizeToken, staticTokenProvider, verifyTokenFile, type BearerTokenProvider } from "./tokenProvider.js";
import { createTrinoQueryHistoryAdapter } from "./trinoQueryHistory.js";

export const TRINO_HISTORY_ACK_VALUE = "shared-service-credential";

export interface UpstreamWiring {
  queryHistoryAdapter?: QueryHistoryAdapter;
  dataAssetSource?: DataAssetSource;
  diagnostics: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

// Policy (same as the Flink adapter): an operator who sets BELUGA_*_ENABLED=true intends the adapter to be on,
// so ANY invalid value throws ConfigError at startup instead of silently disabling it or falling back to a
// default. Values are never echoed in messages (they may be secrets). Booleans accept exactly `true`/`false`
// (unset or empty = false); integers accept plain decimal digits within a documented range.
function bool(env: Env, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${name} must be exactly 'true' or 'false'`);
}

function int(env: Env, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function required(env: Env, name: string, why: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is required (${why})`);
  return value;
}

function tokenProviderFrom(env: Env, prefix: string, diagnostics: string[]): BearerTokenProvider {
  const file = env[`${prefix}_TOKEN_FILE`];
  if (file) {
    // Checked once at startup (fail-fast); the provider still re-reads the file on every call for rotation.
    try {
      for (const warning of verifyTokenFile(file)) diagnostics.push(`warning: ${prefix}_TOKEN_FILE ${warning}`);
    } catch (error) {
      throw new ConfigError(`${prefix}_TOKEN_FILE ${(error as Error).message}`);
    }
    return fileTokenProvider(file);
  }
  const token = env[`${prefix}_TOKEN`];
  if (!token) throw new ConfigError(`${prefix}_TOKEN_FILE or ${prefix}_TOKEN is required`);
  if (normalizeToken(token) === null) throw new ConfigError(`${prefix}_TOKEN is not a valid bearer token (value not shown)`);
  return staticTokenProvider(token);
}

export function parseWarehouses(raw: string | undefined): LakekeeperCatalogMapping[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, warehouse] = entry.includes("=") ? entry.split("=", 2) : [entry, entry];
      return { name: (name ?? "").trim(), warehouse: (warehouse ?? "").trim() };
    })
    .filter((m) => m.name !== "" && m.warehouse !== "");
}

function makeClient(upstream: string, baseUrl: string, tokenProvider: BearerTokenProvider, common: Record<string, unknown>, headers?: Record<string, string>) {
  try {
    return new UpstreamHttpClient({ upstream, baseUrl, tokenProvider, ...common, ...(headers ? { headers } : {}) });
  } catch (error) {
    // Messages from the client never contain token values; the URL value itself is not echoed.
    throw new ConfigError(`${upstream} adapter: ${(error as Error).message === "Invalid URL" ? "base URL is not a valid http(s) URL" : (error as Error).message}`);
  }
}

// Throws ConfigError on any invalid value of an enabled adapter (fail-fast, like BELUGA_FLINK_*).
export function loadUpstreamWiring(env: Env, fetchImpl?: typeof fetch): UpstreamWiring {
  const diagnostics: string[] = [];
  const wiring: UpstreamWiring = { diagnostics };
  const trinoEnabled = bool(env, "BELUGA_TRINO_ENABLED");
  const lakekeeperEnabled = bool(env, "BELUGA_LAKEKEEPER_ENABLED");
  if (!trinoEnabled && !lakekeeperEnabled) return wiring;

  const timeoutMs = int(env, "BELUGA_UPSTREAM_TIMEOUT_MS", 1, 30_000);
  const maxConcurrent = int(env, "BELUGA_UPSTREAM_MAX_CONCURRENT", 1, 32);
  const negativeCacheTtlMs = int(env, "BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS", 0, 600_000);
  const allowInsecureBearer = bool(env, "BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER");
  const common = {
    allowInsecureBearer,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  if (trinoEnabled) {
    const baseUrl = required(env, "BELUGA_TRINO_BASE_URL", "Trino coordinator origin");
    const tokenProvider = tokenProviderFrom(env, "BELUGA_TRINO", diagnostics);
    if (env["BELUGA_TRINO_HISTORY_ACK"] !== TRINO_HISTORY_ACK_VALUE) {
      throw new ConfigError(`BELUGA_TRINO_HISTORY_ACK=${TRINO_HISTORY_ACK_VALUE} is required: query history is shared by all callers (no per-caller authz)`);
    }
    const sqlMode = env["BELUGA_TRINO_HISTORY_SQL"] ?? "literals";
    if (sqlMode !== "literals" && sqlMode !== "none") throw new ConfigError("BELUGA_TRINO_HISTORY_SQL must be 'literals' or 'none'");
    const cacheTtlMs = int(env, "BELUGA_TRINO_HISTORY_CACHE_TTL_MS", 0, 600_000);
    const user = env["BELUGA_TRINO_USER"];
    if (user !== undefined && !/^[\x21-\x7E]*$/.test(user)) throw new ConfigError("BELUGA_TRINO_USER contains characters not allowed in a header");
    const client = makeClient("trino", baseUrl, tokenProvider, common, user ? { "X-Trino-User": user } : undefined);
    wiring.queryHistoryAdapter = createTrinoQueryHistoryAdapter({
      client, redactSql: sqlMode === "literals",
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
      ...(negativeCacheTtlMs !== undefined ? { negativeCacheTtlMs } : {}),
    });
    diagnostics.push("Trino query history adapter enabled (read-only)");
  }

  if (lakekeeperEnabled) {
    const baseUrl = required(env, "BELUGA_LAKEKEEPER_BASE_URL", "Lakekeeper origin");
    const tokenProvider = tokenProviderFrom(env, "BELUGA_LAKEKEEPER", diagnostics);
    const catalogs = parseWarehouses(env["BELUGA_LAKEKEEPER_WAREHOUSES"]);
    if (catalogs.length === 0) throw new ConfigError("BELUGA_LAKEKEEPER_WAREHOUSES must list at least one `warehouse` or `catalog=warehouse`");
    const basePath = (env["BELUGA_LAKEKEEPER_BASE_PATH"] ?? "/catalog").replace(/\/+$/, "");
    if (!/^(\/[A-Za-z0-9_.~-]+)+$/.test(basePath)) throw new ConfigError("BELUGA_LAKEKEEPER_BASE_PATH must be an absolute path such as /catalog");
    const cacheTtlMs = int(env, "BELUGA_LAKEKEEPER_CACHE_TTL_MS", 0, 600_000);
    const client = makeClient("lakekeeper", `${baseUrl.replace(/\/+$/, "")}${basePath}`, tokenProvider, common);
    wiring.dataAssetSource = createLakekeeperDataAssetSource({
      client, catalogs,
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
      ...(negativeCacheTtlMs !== undefined ? { negativeCacheTtlMs } : {}),
    });
    diagnostics.push("Lakekeeper catalog source enabled (read-only; node-level authorization NOT enforced)");
  }
  return wiring;
}
