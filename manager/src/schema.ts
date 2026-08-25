import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const privilegeSchema = z.enum(["select", "insert", "update", "delete"]);
export const maskKindSchema = z.enum(["hash", "partial", "null"]);

export const grantSchema = z.strictObject({
  roles: z.array(z.string()).min(1),
  privileges: z.array(privilegeSchema).min(1),
  columnMask: z.record(z.string(), maskKindSchema).optional(),
  rowFilter: z.string().optional(),
  allowUnmasked: z.boolean().optional(),
});

export const resourceSchema = z.strictObject({
  resource: z.string().min(1),
  classification: z.enum(["public", "internal", "pii"]),
  grants: z.array(grantSchema),
  sensitiveColumns: z.array(z.string().min(1)).optional(),
});

export const roleSchema = z.strictObject({
  name: z.string().min(1),
  includes: z.array(z.string()).optional(),
});

export const groupSchema = z.strictObject({
  name: z.string().min(1),
  roles: z.array(z.string()).min(1),
});

// Task 12: 테이블과 무관한 카탈로그·쿼리 레벨 오퍼레이션(ExecuteQuery/AccessCatalog/
// ShowSchemas). Trino OPA는 이런 오퍼레이션에도 매 요청 allow를 요구하므로(실측:
// default allow := false 위에서 테이블 규칙만 있으면 ExecuteQuery -> false로 쿼리 자체가
// 막힌다), resource+grants 모델과 별개로 표현한다.
// 수정 라운드 1(Task 12 리뷰 M-3): 이 세 이름·리소스 모양은 Trino 483 태그 소스로
// 확정됐다(오퍼레이션명은 각 checkCan* 호출부에 하드코딩된 리터럴이라 이름 규칙으로
// 유도되지 않는다 — 반드시 소스를 볼 것): ExecuteQuery(리소스 없음)는
// OpaAccessControl.java:119, AccessCatalog는 :169, ShowSchemas는 :258. 리소스 모양은
// rego.ts의 emitter 쪽 주석 참고.
export const queryOperationSchema = z.enum([
  "ExecuteQuery",
  "AccessCatalog",
  "ShowSchemas",
  // Task 19: 카탈로그·스키마·테이블 브라우징(BI 도구·대화형 SQL 클라이언트가 실제로 보내는
  // 시퀀스). 리소스 모양은 rego.ts의 OPERATION_RESOURCE_SHAPE 주석 참고 — 전부 Trino 483 태그
  // OpaAccessControl.java 소스로 확정(문서에 없음, 이름 규칙으로 유도 불가).
  "ShowTables",
  "ShowColumns",
  "ShowCreateTable",
  "ShowFunctions",
  "SetCatalogSessionProperty",
  "FilterCatalogs",
  "FilterSchemas",
  "FilterTables",
  // Task 14/19 후속(최종 리뷰 I-5): DESCRIBE <table>이 인증된 analysts 롤 사용자에게 컬럼
  // 0개로 조용히 비어 나오는 실배포 결함을 라이브 OPA 결정 로그 캡처로 확인해 추가.
  // OpaAccessControl.java 소스를 직접 읽어 확정한 게 아니라, Trino 483이 컬럼마다 보낸
  // 실제 요청 로그(`resource.table.catalogName` 모양, ShowColumns/FilterTables와 동일)로
  // 역추적한 것 — enum에서 통째로 빠져 있어 default allow := false로 떨어지고 있었다.
  "FilterColumns",
]);

// Task 19(M-4, D-H): 배포 카탈로그는 iceberg 하나뿐이다
// (gitops/charts/beluga-data/templates/06-trino.yaml — ConfigMap trino-catalog-iceberg 단일).
// resourceSchema에 catalog 필드를 얹는 대신 상수로 고정한다 — 한 번도 다른 값을 받아본 적
// 없는 필드는 Task 12 리뷰 I-2가 경고한 "검증 안 된 확장점"이 된다. 두 번째 카탈로그가
// 실제로 배포되면 resourceSchema에 선택적 catalog 필드(기본값 이 상수)를 추가하고
// rego.ts의 참조를 res.catalog로 바꿀 것 — 그게 이 결정의 탈출구다.
export const DEPLOYED_CATALOG = "iceberg";

export const catalogGrantSchema = z.strictObject({
  catalog: z.string().min(1),
  roles: z.array(z.string()).min(1),
  operations: z.array(queryOperationSchema).min(1),
});

// catalogGrants는 선택적 필드다 — 없는 기존 선언도 계속 유효해야 기존 골든 테스트가
// 깨지지 않는다.
export const declarationSchema = z.strictObject({
  roles: z.array(roleSchema),
  groups: z.array(groupSchema),
  resources: z.array(resourceSchema),
  catalogGrants: z.array(catalogGrantSchema).optional(),
});

export type Privilege = z.infer<typeof privilegeSchema>;
export type MaskKind = z.infer<typeof maskKindSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Group = z.infer<typeof groupSchema>;
export type QueryOperation = z.infer<typeof queryOperationSchema>;
export type CatalogGrant = z.infer<typeof catalogGrantSchema>;
export type Declaration = z.infer<typeof declarationSchema>;

export function parseDeclaration(yamlText: string): Declaration {
  return declarationSchema.parse(parseYaml(yamlText));
}
