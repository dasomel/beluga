import { expect, test } from "vitest";
import { POLICY_OPERATION_ACCESS_TYPE } from "../src/accessType.js";

test("policy operation access types classify every declaration operation", () => {
  expect(POLICY_OPERATION_ACCESS_TYPE).toEqual({
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
  });
});
