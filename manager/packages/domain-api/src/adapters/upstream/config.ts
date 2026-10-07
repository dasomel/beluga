// Environment-driven wiring for the optional upstream adapters. Default = everything disabled (stubs /
// 503), so local dev and CI never reach a cluster. No value read here is ever logged; `diagnostics`
// carries only variable names and reasons.
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
import type { DataAssetSource } from "../dataAssetSource.js";
import type { QueryHistoryAdapter } from "../queryHistory.js";
import { UpstreamHttpClient, DEFAULT_UPSTREAM_TIMEOUT_MS } from "./httpClient.js";
import { createLakekeeperDataAssetSource, type LakekeeperCatalogMapping } from "./lakekeeperCatalog.js";
import { fileTokenProvider, staticTokenProvider, type BearerTokenProvider } from "./tokenProvider.js";
import { createTrinoQueryHistoryAdapter } from "./trinoQueryHistory.js";

export const TRINO_HISTORY_ACK_VALUE = "shared-service-credential";

export interface UpstreamWiring {
  queryHistoryAdapter?: QueryHistoryAdapter;
  dataAssetSource?: DataAssetSource;
  diagnostics: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function tokenProviderFrom(env: Env, prefix: string): BearerTokenProvider | undefined {
  const file = env[`${prefix}_TOKEN_FILE`];
  if (file) return fileTokenProvider(file);
  const token = env[`${prefix}_TOKEN`];
  return token ? staticTokenProvider(token) : undefined;
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

export function loadUpstreamWiring(env: Env, fetchImpl?: typeof fetch): UpstreamWiring {
  const diagnostics: string[] = [];
  const wiring: UpstreamWiring = { diagnostics };
  const timeoutMs = Number(env["BELUGA_UPSTREAM_TIMEOUT_MS"]) > 0 ? Number(env["BELUGA_UPSTREAM_TIMEOUT_MS"]) : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const allowInsecureBearer = env["BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER"] === "true";
  const maxConcurrent = Number(env["BELUGA_UPSTREAM_MAX_CONCURRENT"]) >= 1 ? Math.floor(Number(env["BELUGA_UPSTREAM_MAX_CONCURRENT"])) : undefined;
  const ttlEnv = (name: string): number | undefined => {
    const raw = env[name];
    return raw !== undefined && raw !== "" && Number(raw) >= 0 ? Number(raw) : undefined;
  };
  const negativeCacheTtlMs = ttlEnv("BELUGA_UPSTREAM_NEGATIVE_CACHE_TTL_MS");
  const common = { timeoutMs, allowInsecureBearer, ...(maxConcurrent ? { maxConcurrent } : {}), ...(fetchImpl ? { fetchImpl } : {}) };

  if (env["BELUGA_TRINO_ENABLED"] === "true") {
    const baseUrl = env["BELUGA_TRINO_BASE_URL"];
    const tokenProvider = tokenProviderFrom(env, "BELUGA_TRINO");
    if (!baseUrl || !tokenProvider) {
      diagnostics.push("Trino query history disabled: BELUGA_TRINO_BASE_URL and a token (BELUGA_TRINO_TOKEN_FILE or BELUGA_TRINO_TOKEN) are required");
    } else if (env["BELUGA_TRINO_HISTORY_ACK"] !== TRINO_HISTORY_ACK_VALUE) {
      diagnostics.push(`Trino query history disabled: set BELUGA_TRINO_HISTORY_ACK=${TRINO_HISTORY_ACK_VALUE} to accept that history is shared by all callers (no per-caller authz)`);
    } else {
      try {
        const user = env["BELUGA_TRINO_USER"];
        const client = new UpstreamHttpClient({
          upstream: "trino", baseUrl, tokenProvider, ...common,
          ...(user ? { headers: { "X-Trino-User": user } } : {}),
        });
        wiring.queryHistoryAdapter = createTrinoQueryHistoryAdapter({
          client, redactSql: env["BELUGA_TRINO_HISTORY_SQL"] !== "none",
          ...(ttlEnv("BELUGA_TRINO_HISTORY_CACHE_TTL_MS") !== undefined ? { cacheTtlMs: ttlEnv("BELUGA_TRINO_HISTORY_CACHE_TTL_MS") as number } : {}),
          ...(negativeCacheTtlMs !== undefined ? { negativeCacheTtlMs } : {}),
        });
        diagnostics.push("Trino query history adapter enabled (read-only)");
      } catch (error) {
        diagnostics.push(`Trino query history disabled: ${(error as Error).message}`);
      }
    }
  }

  if (env["BELUGA_LAKEKEEPER_ENABLED"] === "true") {
    const baseUrl = env["BELUGA_LAKEKEEPER_BASE_URL"];
    const tokenProvider = tokenProviderFrom(env, "BELUGA_LAKEKEEPER");
    const catalogs = parseWarehouses(env["BELUGA_LAKEKEEPER_WAREHOUSES"]);
    if (!baseUrl || !tokenProvider || catalogs.length === 0) {
      diagnostics.push("Lakekeeper catalog disabled: BELUGA_LAKEKEEPER_BASE_URL, BELUGA_LAKEKEEPER_WAREHOUSES and a token are required");
    } else {
      try {
        const basePath = (env["BELUGA_LAKEKEEPER_BASE_PATH"] ?? "/catalog").replace(/\/+$/, "");
        const client = new UpstreamHttpClient({
          upstream: "lakekeeper", baseUrl: `${baseUrl.replace(/\/+$/, "")}${basePath}`, tokenProvider, ...common,
        });
        const cacheTtl = ttlEnv("BELUGA_LAKEKEEPER_CACHE_TTL_MS");
        wiring.dataAssetSource = createLakekeeperDataAssetSource({ client, catalogs, ...(cacheTtl !== undefined ? { cacheTtlMs: cacheTtl } : {}),
          ...(negativeCacheTtlMs !== undefined ? { negativeCacheTtlMs } : {}) });
        diagnostics.push("Lakekeeper catalog source enabled (read-only; node-level authorization NOT enforced)");
      } catch (error) {
        diagnostics.push(`Lakekeeper catalog disabled: ${(error as Error).message}`);
      }
    }
  }
  return wiring;
}
