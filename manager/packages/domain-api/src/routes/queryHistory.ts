import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { QueryHistoryAdapter } from "../adapters/queryHistory.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS } from "../adapters/registry.js";
import { describeUpstreamFailure, isUpstreamError } from "../adapters/upstream/errors.js";
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
  description: "No execution or persistent history. Availability and visibility depend on the configured upstream adapter. `sql` is exposed verbatim and may contain sensitive literals; there is no redaction and no per-caller authz (the app has no auth middleware), so a live adapter must not be wired until a redaction/authz policy is decided. The optional Trino adapter (env-enabled, default off) requires an explicit acknowledgement of shared visibility and redacts SQL literals/comments by default; its history is the Manager service credential's view of Trino's retained queries, not the caller's.",
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
    const unavailable = (message = "Query history is currently unavailable") => c.json({ error: { code: "SERVICE_UNAVAILABLE" as const, message } }, 503);
    if (!adapter) return unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Query history adapter timed out")), DEFAULT_ADAPTER_TIMEOUT_MS);
      });
      const result = await Promise.race([
        adapter.readSnapshot ? adapter.readSnapshot() : adapter.listQueryHistory().then((entries) => ({ entries, truncated: false })),
        deadline,
      ]);
      const entries = queryHistoryEntrySchema.array().parse(result.entries);
      const warnings = result.truncated
        ? [{
            code: "HISTORY_TRUNCATED",
            message: `Upstream returned more queries than are exposed; only the first ${entries.length} are shown (meta.total counts exposed rows)`,
            serviceId: "svc-trino",
          }]
        : [];
      const { page, pageSize } = c.req.valid("query");
      const { pageItems, total } = paginate(entries, page, pageSize);
      return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, warnings), 200);
    } catch (error) {
      // Upstream failures (unreachable/401/403/5xx/malformed/timeout) log only their class, never a body or token.
      console.error("Query history adapter failed", isUpstreamError(error) ? `${error.kind}${error.status ? ` ${error.status}` : ""}` : error);
      return unavailable(describeUpstreamFailure(error, "Query history"));
    } finally {
      clearTimeout(timer);
    }
  });
}
