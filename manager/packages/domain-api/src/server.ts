import { serve } from "@hono/node-server";
import { createAppFromEnv } from "./wiring.js";

const port = Number(process.env["PORT"] ?? 8787);
// All adapters (Flink, Trino history, Lakekeeper catalog) are opt-in and default-off; invalid configuration of an
// enabled adapter fails startup here with a ConfigError.
const { app, flinkEnabled, diagnostics } = createAppFromEnv(process.env);
for (const line of diagnostics) console.log(`[upstream] ${line}`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`Flink adapter: ${flinkEnabled ? "enabled (read-only)" : "disabled (stub data)"}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
