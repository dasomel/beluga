// The single place that turns environment variables into the running app. server.ts and the integration
// tests both use it, so wiring changes cannot drift from what is tested. Every adapter is independently
// opt-in and default-off; any invalid value of an enabled adapter throws ConfigError (fail-fast).
import fs from "node:fs";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRuntime } from "./adapters/runtime.js";
import { loadAuthConfig } from "./auth/authConfig.js";
import { createOidcVerifier } from "./auth/oidc.js";
import { createSsoAdapterFromEnv } from "./adapters/sso/ssoAdapter.js";
import { loadUpstreamWiring } from "./adapters/upstream/config.js";
import { createApp } from "./app.js";
import {
  loadAuditDbConfig,
  loadGithubAppConfig,
  loadKubeApiConfig,
  loadReconcileIntervalMs,
  loadSsoWriteEnabled,
  resolveBaseDomain,
} from "./config.js";
import { ArgocdReader, type ArgocdPort } from "./sso-change/argocdReader.js";
import { GithubAppClient } from "./sso-change/githubApp.js";
import { SsoChangeReconciler } from "./sso-change/reconciler.js";
import { createPgSsoChangeStore } from "./store/ssoChangeStore.js";

export interface WiredApp {
  app: OpenAPIHono;
  flinkEnabled: boolean;
  authMode: "oidc" | "disabled";
  diagnostics: string[];
  /** D-MSSO-18: present only when the audit store AND the GitHub writer are configured. server.ts starts/stops it. */
  reconciler?: SsoChangeReconciler;
}

// D-MSSO-15: the writer exists only when ids + a readable, parseable key are all present. The key is read once
// (kubelet mounts the Secret before the container starts). The diagnostic line never contains a value.
function createGitWriter(env: Record<string, string | undefined>, diagnostics: string[], fetchImpl?: typeof fetch): GithubAppClient | undefined {
  const config = loadGithubAppConfig(env);
  if (config === undefined) {
    diagnostics.push("GitHub App writer not configured (GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_FILE)");
    return undefined;
  }
  try {
    const privateKeyPem = fs.readFileSync(config.privateKeyFile, "utf8");
    return new GithubAppClient({ appId: config.appId, installationId: config.installationId, privateKeyPem, ...(fetchImpl ? { fetchImpl } : {}) });
  } catch {
    diagnostics.push("GitHub App writer not configured (private key file is missing, unreadable or not a private key)");
    return undefined;
  }
}

// D-MSSO-16: the reader exists only when the three KUBE_API_* variables are set and both files are readable.
function createArgocdReader(env: Record<string, string | undefined>, diagnostics: string[]): ArgocdPort | undefined {
  const config = loadKubeApiConfig(env);
  if (config === undefined) {
    diagnostics.push("ArgoCD reader not configured (KUBE_API_URL / KUBE_API_TOKEN_FILE / KUBE_API_CA_FILE)");
    return undefined;
  }
  try {
    fs.accessSync(config.tokenFile, fs.constants.R_OK);
    fs.accessSync(config.caFile, fs.constants.R_OK);
  } catch {
    diagnostics.push("ArgoCD reader not configured (service account token or CA file is not readable)");
    return undefined;
  }
  return new ArgocdReader({ apiUrl: config.apiUrl, tokenFile: config.tokenFile, caFile: config.caFile });
}

export function createAppFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): WiredApp {
  // Parsed first: an invalid value fails startup before any adapter is built.
  const auditDb = loadAuditDbConfig(env);
  const writeEnabled = loadSsoWriteEnabled(env);
  const reconcileIntervalMs = loadReconcileIntervalMs(env);
  loadKubeApiConfig(env); // validated here so a bad URL stops startup before anything is built
  const { registry, pipelineAdapter } = createRuntime(env, fetchImpl);
  const upstream = loadUpstreamWiring(env, fetchImpl);
  const ssoAdapter = createSsoAdapterFromEnv(env, fetchImpl);
  // D-MSSO-6: throws ConfigError for AUTH_MODE=disabled in production or an invalid OIDC_ISSUER (fail-closed).
  const auth = loadAuthConfig(env);
  const verifier = auth.mode === "oidc" ? createOidcVerifier(auth, fetchImpl ? { fetchImpl } : {}) : undefined;
  // D-MSSO-11: no audit DB configured = no store (writes answer 503). The pool is created lazily, so a database or
  // Secret that is not there yet never stops startup. D-MSSO-15: no GitHub App Secret = no writer (submit and cancel
  // answer 503 GIT_WRITER_UNCONFIGURED) and no reconciler.
  const store = auditDb ? createPgSsoChangeStore(auditDb) : undefined;
  const diagnostics = [...upstream.diagnostics];
  const gitWriter = createGitWriter(env, diagnostics, fetchImpl);
  const argocdReader = createArgocdReader(env, diagnostics);
  const app = createApp(registry, upstream.queryHistoryAdapter, pipelineAdapter, upstream.dataAssetSource, ssoAdapter, verifier, {
    store,
    gitWriter,
    argocdReader,
    writeEnabled,
  });
  const reconciler =
    store !== undefined && gitWriter !== undefined
      ? new SsoChangeReconciler({ store, git: gitWriter, argocd: argocdReader, baseDomain: resolveBaseDomain(env), intervalMs: reconcileIntervalMs })
      : undefined;
  return { app, flinkEnabled: pipelineAdapter !== undefined, authMode: auth.mode, diagnostics, ...(reconciler ? { reconciler } : {}) };
}
