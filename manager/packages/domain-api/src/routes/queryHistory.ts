import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { QueryHistoryAdapter } from "../adapters/queryHistory.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS } from "../adapters/registry.js";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema } from "../schema/envelope.js";
import { paginationQuerySchema } from "../schema/query.js";
import { queryHistoryEntrySchema, queryHistoryResponseSchema } from "../schema/queryHistory.js";

const route = createRoute({
  method: "get",
  path: "/api/v1/query-history",
  tags: ["Query"],
  summary: "Read the configured adapter's visible query snapshot",
  description: "No execution or persistent history. Availability and visibility depend on the configured upstream adapter. `sql` is exposed verbatim and may contain sensitive literals; there is no redaction and no per-caller authz (the app has no auth middleware), so a live adapter must not be wired until a redaction/authz policy is decided.",
  request: { query: paginationQuerySchema },
  responses: {
    200: { description: "Upstream snapshot in adapter order (no inferred chronology).", content: { "application/json": { schema: queryHistoryResponseSchema } } },
    400: { description: "Invalid pagination.", content: { "application/json": { schema: errorResponseSchema } } },
    503: { description: "History capability unavailable or failed.", content: { "application/json": { schema: errorResponseSchema } } },
    500: internalErrorResponse,
  },
});

export function registerQueryHistoryRoutes(app: OpenAPIHono, adapter?: QueryHistoryAdapter) {
  app.openapi(route, async (c) => {
    const unavailable = () => c.json({ error: { code: "SERVICE_UNAVAILABLE" as const, message: "Query history is currently unavailable" } }, 503);
    if (!adapter) return unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Query history adapter timed out")), DEFAULT_ADAPTER_TIMEOUT_MS);
      });
      const snapshot = await Promise.race([adapter.listQueryHistory(), deadline]);
      const entries = queryHistoryEntrySchema.array().parse(snapshot);
      const { page, pageSize } = c.req.valid("query");
      const { pageItems, total } = paginate(entries, page, pageSize);
      return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
    } catch (error) {
      console.error("Query history adapter failed", error);
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  });
}
