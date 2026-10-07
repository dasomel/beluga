import { serve } from "@hono/node-server";
import { createRuntime } from "./adapters/runtime.js";
import { createApp } from "./app.js";
import { loadUpstreamWiring } from "./adapters/upstream/config.js";

const port = Number(process.env["PORT"] ?? 8787);
// Every upstream adapter is independently opt-in and default-off (stubs/503 otherwise).
// Flink: BELUGA_FLINK_* (invalid config fails startup here). Trino history / Lakekeeper catalog: BELUGA_TRINO_*,
// BELUGA_LAKEKEEPER_* (invalid config only disables that adapter and logs why).
const { registry, pipelineAdapter } = createRuntime(process.env);
const upstream = loadUpstreamWiring(process.env);
for (const line of upstream.diagnostics) console.log(`[upstream] ${line}`);
const app = createApp(registry, upstream.queryHistoryAdapter, pipelineAdapter, upstream.dataAssetSource);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`Flink adapter: ${pipelineAdapter ? "enabled (read-only)" : "disabled (stub data)"}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
