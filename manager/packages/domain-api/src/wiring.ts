// The single place that turns environment variables into the running app. server.ts and the integration
// tests both use it, so wiring changes cannot drift from what is tested. Every adapter is independently
// opt-in and default-off; any invalid value of an enabled adapter throws ConfigError (fail-fast).
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRuntime } from "./adapters/runtime.js";
import { loadAuthConfig } from "./auth/authConfig.js";
import { createOidcVerifier } from "./auth/oidc.js";
import { createSsoAdapterFromEnv } from "./adapters/sso/ssoAdapter.js";
import { loadUpstreamWiring } from "./adapters/upstream/config.js";
import { createApp } from "./app.js";

export interface WiredApp {
  app: OpenAPIHono;
  flinkEnabled: boolean;
  authMode: "oidc" | "disabled";
  diagnostics: string[];
}

export function createAppFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): WiredApp {
  const { registry, pipelineAdapter } = createRuntime(env, fetchImpl);
  const upstream = loadUpstreamWiring(env, fetchImpl);
  const ssoAdapter = createSsoAdapterFromEnv(env, fetchImpl);
  // D-MSSO-6: throws ConfigError for AUTH_MODE=disabled in production or an invalid OIDC_ISSUER (fail-closed).
  const auth = loadAuthConfig(env);
  const verifier = auth.mode === "oidc" ? createOidcVerifier(auth, fetchImpl ? { fetchImpl } : {}) : undefined;
  const app = createApp(registry, upstream.queryHistoryAdapter, pipelineAdapter, upstream.dataAssetSource, ssoAdapter, verifier);
  return { app, flinkEnabled: pipelineAdapter !== undefined, authMode: auth.mode, diagnostics: upstream.diagnostics };
}
