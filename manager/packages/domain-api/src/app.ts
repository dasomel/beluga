import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
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

  // 이 패키지에는 아직 dev/prod를 구분하는 환경 변수가 없다(server.ts는 PORT만 읽는다).
  // 그 구분이 생기기 전까지는 packages/web의 Vite dev 서버(5180)만 허용하는 개발 편의용
  // CORS로 좁혀 둔다 -- 운영 배포 시에는 이 permissive한 origin을 재검토해야 한다.
  app.use(
    "/api/*",
    cors({
      origin: "http://localhost:5180",
    }),
  );

  registerHealthRoutes(app);
  registerServiceRoutes(app);
  registerPipelineRoutes(app);
  registerDataAssetRoutes(app);
  registerEventRoutes(app);

  // app.doc()(OpenApiGeneratorV3)는 3.0 스타일 JSON Schema(boolean exclusiveMinimum,
  // "nullable: true")를 생성한다 -- openapi 필드에 "3.1.0"을 적어도 실제 스키마 문법은
  // 3.0인 상태가 된다. doc31()(OpenApiGeneratorV31)이 3.1 문법(JSON Schema 2020-12:
  // type 배열, 숫자 exclusiveMinimum)을 생성하므로 선언과 실제 문법을 일치시킨다
  // (issue #43 finding #1).
  app.doc31(OPENAPI_JSON_PATH, {
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

  // onError가 없으면 핸들러 안에서 던져진 예외가 Hono 기본 처리로 떨어져 text/plain
  // "Internal Server Error"를 반환한다 -- 404/400과 달리 이 경로만 다른 에러 모양을
  // 낸다(issue #43 finding #3). err.message는 stub 데이터 안쪽 로직에서 나온 내부
  // 세부사항일 수 있으므로 응답 바디에는 절대 포함하지 않고, 서버 로그로만 남긴다.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: { code: "INTERNAL_ERROR" as const, message: "Internal server error" } }, 500);
  });

  return app;
}
