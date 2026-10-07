import { serve } from "@hono/node-server";
import { createRuntime } from "./adapters/runtime.js";
import { createApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 8787);
// BELUGA_FLINK_REST_URL이 없으면 stub 구성(기본). 잘못된 설정은 여기서 기동 실패로 드러난다.
const { registry, pipelineAdapter } = createRuntime(process.env);
const app = createApp(registry, undefined, pipelineAdapter);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`Flink adapter: ${pipelineAdapter ? "enabled (read-only)" : "disabled (stub data)"}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
