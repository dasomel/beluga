import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { internalErrorResponse } from "../lib/errorResponses.js";
import { healthStatusSchema } from "../schema/health.js";

// package.json이 이 API 자체 버전의 단일 원천이다 — 여기서 문자열을 따로 하드코딩하지
// 않는다.
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const { version: packageVersion } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };

export const domainApiHealthSchema = z
  .object({
    status: healthStatusSchema,
    version: z.string().min(1).openapi({ example: packageVersion }),
  })
  .openapi("DomainApiHealth");

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  tags: ["Health"],
  summary: "Beluga Domain API's own health",
  // /services가 이미 업스트림별 헬스를 노출하므로 이 엔드포인트는 그것을 다시 프록시하지
  // 않는다 — 이 프로세스 자신의 헬스만 반환한다.
  description:
    "Reports the Domain API process's own health. This does not proxy or aggregate upstream service health; see GET /api/v1/services for that.",
  responses: {
    200: {
      description: "The Domain API process itself is reachable and serving requests.",
      content: { "application/json": { schema: domainApiHealthSchema } },
    },
    500: internalErrorResponse,
  },
});

export function registerHealthRoutes(app: OpenAPIHono) {
  app.openapi(healthRoute, (c) => {
    // 이 프로세스가 요청에 응답할 수 있다는 사실 자체가 "healthy"의 정의다 — 응답할 수
    // 없는 상태(degraded/unavailable)는 이 핸들러가 실행되지 않는 상태와 같다. 내부
    // 서브시스템 점검이 생기면(이 이슈 범위 밖) 그때 다른 상태를 반환할 수 있다.
    return c.json({ status: "healthy" as const, version: packageVersion }, 200);
  });
}
