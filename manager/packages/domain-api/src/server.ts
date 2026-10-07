import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createStubRegistry } from "./adapters/stubAdapter.js";
import { loadUpstreamWiring } from "./adapters/upstream/config.js";

const port = Number(process.env["PORT"] ?? 8787);
// Upstream adapters are opt-in via env (default: fixtures / 503). See adapters/upstream/config.ts.
const upstream = loadUpstreamWiring(process.env);
for (const line of upstream.diagnostics) console.log(`[upstream] ${line}`);
const app = createApp(createStubRegistry(), upstream.queryHistoryAdapter, upstream.dataAssetSource);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
