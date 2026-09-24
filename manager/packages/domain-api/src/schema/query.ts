import { z } from "@hono/zod-openapi";
import { eventSeveritySchema } from "./event.js";
import { healthStatusSchema } from "./health.js";
import { serviceTypeSchema } from "./service.js";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1).openapi({ example: 1 }),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ example: 20 }),
});

export const statusFilterableListQuerySchema = paginationQuerySchema.extend({
  status: healthStatusSchema.optional(),
});

export const serviceListQuerySchema = statusFilterableListQuerySchema.extend({
  type: serviceTypeSchema.optional(),
});

// Event는 domain 모델에 status(health) 필드가 없다 — severity만 있다. 스펙 문구
// ("status filter usable on any list endpoint")를 문자 그대로 따르면 필터링할 필드가
// 없는 파라미터를 계약에 얹게 되어 오히려 오해를 유발한다. 그래서 이 엔드포인트에는
// status 필터를 얹지 않는다(보고서에 명시). 대신 Event가 실제로 가진 필드인 severity는
// 필터링 가능해야 한다(issue #43 finding #4) — enum이라 알 수 없는 값은 defaultHook을
// 거쳐 자동으로 400 VALIDATION_ERROR가 된다.
export const eventListQuerySchema = paginationQuerySchema.extend({
  severity: eventSeveritySchema.optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type StatusFilterableListQuery = z.infer<typeof statusFilterableListQuerySchema>;
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
