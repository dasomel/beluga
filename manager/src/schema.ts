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
export const queryOperationSchema = z.enum(["ExecuteQuery", "AccessCatalog", "ShowSchemas"]);

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
