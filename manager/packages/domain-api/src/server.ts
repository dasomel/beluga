import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 8787);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Beluga Domain API listening on http://localhost:${info.port}`);
  console.log(`OpenAPI document: http://localhost:${info.port}/api/v1/openapi.json`);
  console.log(`Docs (Swagger UI): http://localhost:${info.port}/api/v1/docs`);
});
