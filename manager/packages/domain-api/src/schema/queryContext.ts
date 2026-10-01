import { z } from "@hono/zod-openapi";

// Query Workspace(#17)의 진입점 계약. Manager는 query engine이 아니다 — 이 응답은
// "Trino에서 무엇을 어디서 열지"만 알려주고, 실행과 권한 판단은 전적으로 Trino에 위임한다.
export const queryContextSchema = z
  .object({
    assetId: z.string().min(1).openapi({ example: "asset-table-orders" }),
    catalog: z.string().min(1).openapi({ example: "beluga_lake", description: "Trino catalog" }),
    schema: z.string().min(1).openapi({ example: "analytics", description: "Trino schema" }),
    table: z.string().min(1).openapi({ example: "orders", description: "Trino table" }),
    trinoServiceId: z.string().min(1).openapi({ example: "svc-trino" }),
    trinoUiUrl: z.string().url().openapi({ example: "https://trino.local.beluga.internal" }),
    sampleSql: z.string().min(1).openapi({
      example: 'SELECT * FROM "beluga_lake"."analytics"."orders" LIMIT 20',
      description: "Read-only starter statement (single SELECT with LIMIT). Execution is delegated to Trino.",
    }),
    readOnly: z.literal(true).openapi({ description: "Always true: Manager never executes or mutates." }),
    rowLimit: z.number().int().positive().openapi({ example: 20 }),
  })
  .openapi("QueryContext");

export type QueryContext = z.infer<typeof queryContextSchema>;
