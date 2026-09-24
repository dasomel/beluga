import { z } from "@hono/zod-openapi";

export const listMetaSchema = z
  .object({
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .openapi("ListMeta");

// ADR-0002 Decision Drivers의 partial-failure semantics: 하나의 upstream이
// degraded/stale/unreachable이어도 전체 요청을 실패시키지 않고, 이 배열로 부분 실패를
// 드러낸다. serviceId가 nullable인 이유는 Pipeline처럼 특정 단일 서비스로 환원되지
// 않는 경고도 있기 때문이다.
export const listWarningSchema = z
  .object({
    code: z.string().min(1).openapi({ example: "DEGRADED" }),
    message: z.string().min(1).openapi({ example: "Service 'Kafka' status is degraded" }),
    serviceId: z.string().min(1).nullable().openapi({ example: "svc-kafka" }),
  })
  .openapi("ListWarning");

// 모든 컬렉션 엔드포인트가 공유하는 봉투(envelope). warnings는 보고할 것이 있을 때만
// 키 자체를 내려준다(빈 배열을 항상 내려주지 않음) — 존재 여부가 "주의가 필요한
// 항목이 있다"는 신호가 되도록.
export function listResponseSchema<T extends z.ZodTypeAny>(itemSchema: T, refId: string) {
  return z
    .object({
      data: z.array(itemSchema),
      meta: listMetaSchema,
      warnings: z.array(listWarningSchema).optional(),
    })
    .openapi(refId);
}

export const errorCodeSchema = z.enum(["NOT_FOUND", "VALIDATION_ERROR", "INTERNAL_ERROR"]).openapi("ErrorCode");

// 단일 리소스 404 등에 쓰는 일관된 에러 모양 — Hono의 기본 404 바디 대신 이 모양을
// 항상 반환한다.
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      message: z.string().min(1),
    }),
  })
  .openapi("ErrorResponse");

export type ListMeta = z.infer<typeof listMetaSchema>;
export type ListWarning = z.infer<typeof listWarningSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
