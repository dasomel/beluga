import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildListEnvelope, healthWarning } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { pipelineSchema } from "../schema/pipeline.js";
import { statusFilterableListQuerySchema } from "../schema/query.js";
import { pipelines } from "../stub-data/pipelines.js";

const pipelineListResponseSchema = listResponseSchema(pipelineSchema, "PipelineListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/pipelines",
  tags: ["Pipelines"],
  summary: "List Beluga pipelines correlated across services",
  request: { query: statusFilterableListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of pipelines, optionally filtered by aggregate status.",
      content: { "application/json": { schema: pipelineListResponseSchema } },
    },
    // services.ts와 동일한 이유 -- defaultHook의 쿼리 검증 실패 응답을 문서화한다
    // (issue #43 finding #2).
    400: {
      description: "Query validation failed (e.g. page < 1, pageSize > 100, unknown status).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

const getByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/pipelines/{id}",
  tags: ["Pipelines"],
  summary: "Get a single pipeline by id",
  request: { params: z.object({ id: z.string().min(1).openapi({ example: "pl-lakehouse-ingest" }) }) },
  responses: {
    200: {
      description: "The pipeline.",
      content: { "application/json": { schema: pipelineSchema } },
    },
    404: {
      description: "No pipeline exists with this id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerPipelineRoutes(app: OpenAPIHono) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, status } = c.req.valid("query");
    const filtered = pipelines.filter((pipeline) => status === undefined || pipeline.status === status);
    const { pageItems, total } = paginate(filtered, page, pageSize);
    // pipeline 레벨 경고는 특정 하나의 서비스로 환원되지 않으므로 serviceId는 null로
    // 둔다 — 어떤 stage가 원인인지 보려면 응답의 stages[].detail을 본다.
    const warnings = pageItems
      .map((pipeline) => healthWarning(pipeline.status, pipeline.name, null))
      .filter((warning) => warning !== null);

    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, warnings), 200);
  });

  app.openapi(getByIdRoute, (c) => {
    const { id } = c.req.valid("param");
    const found = pipelines.find((pipeline) => pipeline.id === id);

    if (!found) {
      return c.json({ error: { code: "NOT_FOUND" as const, message: `Pipeline '${id}' was not found` } }, 404);
    }

    return c.json(found, 200);
  });
}
