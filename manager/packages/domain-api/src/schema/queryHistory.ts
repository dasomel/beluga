import { z } from "@hono/zod-openapi";
import { listResponseSchema } from "./envelope.js";

// D1: upstream이 실제 제공하는 식별자/SQL/상태만 노출한다. 실행 시각·사용자·자산
// 연관은 추정하지 않는다. 비용은 작은 계약이며 live adapter에서 확장할 수 있다.
export const queryHistoryEntrySchema = z.object({
  id: z.string().min(1),
  sql: z.string().min(1),
  state: z.string().min(1),
}).openapi("QueryHistoryEntry");

export const queryHistoryResponseSchema = listResponseSchema(queryHistoryEntrySchema, "QueryHistoryResponse");
export type QueryHistoryEntry = z.infer<typeof queryHistoryEntrySchema>;
