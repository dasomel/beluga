import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema } from "../src/schema/envelope.js";

// app.ts에 onError가 없으면 핸들러 안에서 던져진 예외가 Hono 기본 처리로 떨어져
// text/plain "Internal Server Error"를 반환한다 -- 다른 모든 에러 경로(404/400)가
// 지키는 "일관된 에러 envelope" 원칙이 여기서만 깨진다. app.doc()에 잡히지 않는
// 임시 라우트로 예외를 주입해 재현한다(issue #43 finding #3).
test("핸들러에서 처리되지 않은 예외가 발생해도 표준 에러 envelope(JSON)을 반환하고 내부 메시지를 유출하지 않는다", async () => {
  const app = createApp();
  app.get("/__test-unhandled-exception", () => {
    throw new Error("boom-secret-internal-detail");
  });

  const res = await app.request("/__test-unhandled-exception");

  expect(res.status).toBe(500);
  expect(res.headers.get("content-type")).toContain("application/json");

  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("INTERNAL_ERROR");
  expect(body.error.message).not.toContain("boom-secret-internal-detail");
});
