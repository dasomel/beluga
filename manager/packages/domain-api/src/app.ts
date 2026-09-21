import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { registerDataAssetRoutes } from "./routes/dataAssets.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPipelineRoutes } from "./routes/pipelines.js";
import { registerServiceRoutes } from "./routes/services.js";

const OPENAPI_JSON_PATH = "/api/v1/openapi.json";
const DOCS_PATH = "/api/v1/docs";

export function createApp(): OpenAPIHono {
  // ADR-0002 Decision Drivers의 "consistent error" 원칙을 요청 파라미터 검증 실패에도
  // 적용한다 — 브리프가 명시한 건 단일 리소스 404뿐이지만, zod-openapi 기본 검증 실패
  // 응답({success, error:{name,message}})을 그대로 두면 같은 API 안에 에러 모양이
  // 두 가지가 된다. 이 defaultHook이 모든 route의 400 검증 실패를 동일한 envelope으로
  // 정규화한다.
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR" as const,
              message: result.error.issues.map((issue) => issue.message).join("; "),
            },
          },
          400,
        );
      }
    },
  });

  registerHealthRoutes(app);
  registerServiceRoutes(app);
  registerPipelineRoutes(app);
  registerDataAssetRoutes(app);
  registerEventRoutes(app);

  app.doc(OPENAPI_JSON_PATH, {
    openapi: "3.1.0",
    info: {
      title: "Beluga Domain API",
      version: "0.1.0",
      description:
        "Beluga's own domain contract over the integrated OSS platform (issue #43). Stub data only " +
        "for now -- see stub-data/ for the explicit non-goal statement.",
    },
  });
  app.get(DOCS_PATH, swaggerUI({ url: OPENAPI_JSON_PATH }));

  // 매칭되는 라우트가 전혀 없을 때도 Hono의 기본 텍스트 404 대신 같은 에러 envelope을
  // 반환한다 -- 단일 리소스 404와 동일한 "일관된 에러 모양" 원칙의 자연스러운 연장.
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND" as const, message: `No route matches ${c.req.method} ${c.req.path}` } }, 404),
  );

  return app;
}
