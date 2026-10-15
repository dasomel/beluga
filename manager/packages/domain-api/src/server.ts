import { serve } from "@hono/node-server";
import { ConfigError } from "./config.js";
import { createAppFromEnv, type WiredApp } from "./wiring.js";

const port = Number(process.env["PORT"] ?? 8787);
// All adapters (Flink, Trino history, Lakekeeper catalog) are opt-in and default-off; invalid configuration of an
// enabled adapter fails startup (exit code 1) with a one-line ConfigError message and no stack trace.
let wired: WiredApp;
try {
  wired = createAppFromEnv(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
const { app, flinkEnabled, diagnostics } = wired;
for (const line of diagnostics) console.log(`[upstream] ${line}`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`Flink adapter: ${flinkEnabled ? "enabled (read-only)" : "disabled (stub data)"}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
