import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { buildListEnvelope } from "../lib/envelope.js";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { paginate } from "../lib/pagination.js";
import { errorResponseSchema, listResponseSchema } from "../schema/envelope.js";
import { eventSchema } from "../schema/event.js";
import { eventListQuerySchema } from "../schema/query.js";
import { events } from "../stub-data/events.js";

const eventListResponseSchema = listResponseSchema(eventSchema, "EventListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/events",
  tags: ["Events"],
  summary: "List Beluga platform events",
  // Event에는 health status 필드가 없다(schema/event.ts) — severity만 있다. 그래서 다른
  // 목록 엔드포인트와 달리 ?status= 필터를 얹지 않는다(보고서에 명시한 스펙 불일치
  // 해소). 대신 실제로 존재하는 필드인 severity는 필터링 가능하다(issue #43 finding #4).
  request: { query: eventListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of events, newest first, optionally filtered by severity.",
      content: { "application/json": { schema: eventListResponseSchema } },
    },
    // services.ts와 동일한 이유 (issue #43 finding #2) -- 여기서는 page/pageSize 검증
    // 실패에 더해 알 수 없는 severity 값도 같은 400 VALIDATION_ERROR 경로를 탄다.
    400: {
      description: "Query validation failed (e.g. page < 1, pageSize > 100, unknown severity).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerEventRoutes(app: OpenAPIHono) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize, severity } = c.req.valid("query");
    const filtered = events.filter((event) => severity === undefined || event.severity === severity);
    const sorted = [...filtered].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const { pageItems, total } = paginate(sorted, page, pageSize);

    // Event 목록 자체는 degraded/stale한 "이 목록의 업스트림"이라는 개념이 없어
    // warnings를 만들지 않는다 — 그 정보는 이미 severity/message로 표현된다.
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
  });
}
