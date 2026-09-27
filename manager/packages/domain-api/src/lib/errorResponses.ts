import { errorResponseSchema } from "../schema/envelope.js";

// app.ts의 onError가 처리되지 않은 예외를 이 모양으로 정규화해 모든 route에서 낼 수
// 있으므로(issue #43 finding #3), 각 createRoute의 responses가 반복해서 선언할 조각을
// 한 곳에 둔다.
export const internalErrorResponse = {
  description: "An unexpected server error occurred.",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;
