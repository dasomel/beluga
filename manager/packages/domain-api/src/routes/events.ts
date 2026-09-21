import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { buildListEnvelope } from "../lib/envelope.js";
import { paginate } from "../lib/pagination.js";
import { listResponseSchema } from "../schema/envelope.js";
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
  // 해소).
  request: { query: eventListQuerySchema },
  responses: {
    200: {
      description: "Paginated list of events, newest first.",
      content: { "application/json": { schema: eventListResponseSchema } },
    },
  },
});

export function registerEventRoutes(app: OpenAPIHono) {
  app.openapi(listRoute, (c) => {
    const { page, pageSize } = c.req.valid("query");
    const sorted = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const { pageItems, total } = paginate(sorted, page, pageSize);

    // Event 목록 자체는 degraded/stale한 "이 목록의 업스트림"이라는 개념이 없어
    // warnings를 만들지 않는다 — 그 정보는 이미 severity/message로 표현된다.
    return c.json(buildListEnvelope(pageItems, { total, page, pageSize }, []), 200);
  });
}
