import type { Privilege, QueryOperation } from "./schema.js";

export type PolicyAccessType = "read-only" | "mutating";

// 새 privilege 또는 query operation은 여기에 분류를 추가하지 않으면 typecheck가 실패한다.
// 이는 UI projection이 권한의 읽기/변경 성격을 추측하지 않게 하는 compiler 단일 출처다.
export const POLICY_OPERATION_ACCESS_TYPE: Record<Privilege | QueryOperation, PolicyAccessType> = {
  select: "read-only",
  insert: "mutating",
  update: "mutating",
  delete: "mutating",
  ExecuteQuery: "read-only",
  AccessCatalog: "read-only",
  ShowSchemas: "read-only",
  ShowTables: "read-only",
  ShowColumns: "read-only",
  ShowCreateTable: "read-only",
  ShowFunctions: "read-only",
  SetCatalogSessionProperty: "mutating",
  FilterCatalogs: "read-only",
  FilterSchemas: "read-only",
  FilterTables: "read-only",
  FilterColumns: "read-only",
};
