import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { declarationSchema, procedureGrantSchema } from "../src/schema.js";
import type { Declaration } from "../src/schema.js";
import { validateDeclaration } from "../src/validate.js";

const declaration = declarationSchema.parse(Object.assign({}, ...[
  "roles", "groups", "resources", "catalog",
].map((name) => parse(readFileSync(new URL(`../../../../policies/${name}.yaml`, import.meta.url), "utf8")))));
const grant = declaration.procedureGrants![0]!;
const artifacts = compileAll(declaration);
const workDir = mkdtempSync(join(tmpdir(), "procedure-grants-"));
const regoPath = join(workDir, "trino.rego");
writeFileSync(regoPath, artifacts.rego);
afterAll(() => rmSync(workDir, { recursive: true, force: true }));
const hasOpa = spawnSync("opa", ["version"], { encoding: "utf8" }).status === 0;
const semanticTest = test.skipIf(!hasOpa);
const resource = (name = "lake.orders", procedure = "OPTIMIZE", catalogName = "iceberg") => {
  const [schemaName, tableName] = name.split(".");
  // D-MAINT-5: captured colima/Trino 483 decision-log resource (2026-11-10).
  return { function: { functionName: procedure }, table: { catalogName, schemaName, tableName } };
};
function allowed(operation: string, inputResource = {}, groups = ["maintainers"]): boolean {
  const result = spawnSync("opa", ["eval", "--stdin-input", "--data", regoPath, "--format", "raw", "data.trino.allow"], {
    encoding: "utf8",
    input: JSON.stringify({ context: { identity: { user: "svc-maintenance", groups } },
      action: { operation, resource: inputResource } }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^(true|false)$/);
  return result.stdout.trim() === "true";
}

test("procedure grants reject wildcards, empty sets, unsupported names and direct-call errors", () => {
  for (const patch of [
    { tables: [] }, { tables: ["*"] }, { tables: ["lake.*"] }, { tables: ["orders"] },
    { procedures: [] }, { procedures: ["*"] }, { procedures: ["remove_orphan_files"] },
    { procedures: ["register_table"] }, { catalog: "other" },
  ]) {
    const invalid = { ...grant, ...patch };
    expect(procedureGrantSchema.safeParse(invalid).success).toBe(false);
    expect(validateDeclaration({ ...declaration, procedureGrants: [invalid] } as Declaration)
      .map((e) => e.code)).toContain("INVALID_PROCEDURE_GRANT");
  }
  expect(validateDeclaration({ ...declaration, procedureGrants: [{ ...grant, roles: ["missing"] }] })
    .map((e) => e.code)).toContain("UNKNOWN_ROLE");
  expect(validateDeclaration({ ...declaration, procedureGrants: [grant, grant] })
    .map((e) => e.code)).toContain("DUPLICATE_PROCEDURE_GRANT");
});

test("maintainers has no inheritance or Postgres data grants; output is deterministic", () => {
  expect(declaration.roles.find((r) => r.name === "maintainers")?.includes ?? []).toEqual([]);
  expect(declaration.roles.filter((r) => r.includes?.includes("maintainers"))).toEqual([]);
  expect(artifacts.keycloak.groups.find((g) => g.name === "maintainers")?.realmRoles).toEqual(["maintainers"]);
  expect(artifacts.pgddl).not.toMatch(/GRANT .* TO maintainers;/);
  expect(compileAll({ ...declaration, procedureGrants: [{ ...grant,
    tables: [...grant.tables].reverse(), procedures: [...grant.procedures].reverse() }] })).toEqual(artifacts);
});

semanticTest("only allowlisted table AND procedure pairs are executable", () => {
  expect(allowed("ExecuteTableProcedure", resource("lake.orders", "OPTIMIZE"))).toBe(true);
  expect(allowed("ExecuteTableProcedure", resource("lake.orders", "optimize"))).toBe(true);
  expect(allowed("ExecuteTableProcedure", resource("gold_shop.daily_revenue", "EXPIRE_SNAPSHOTS"))).toBe(true);
  expect(allowed("ExecuteTableProcedure", resource("gold_shop.daily_revenue", "expire_snapshots"))).toBe(true);
  for (const table of grant.tables) for (const procedure of grant.procedures) {
    expect(allowed("ExecuteTableProcedure", resource(table, procedure))).toBe(true);
  }
  for (const procedure of ["REMOVE_ORPHAN_FILES", "remove_orphan_files", "register_table"]) {
    expect(allowed("ExecuteTableProcedure", resource("lake.orders", procedure))).toBe(false);
  }
  for (const table of ["lake.other", "gold_shop.orders", "silver_shop.customers"]) {
    expect(allowed("ExecuteTableProcedure", resource(table))).toBe(false);
  }
  expect(allowed("ExecuteTableProcedure", resource("lake.orders", "optimize", "other"))).toBe(false);
  expect(allowed("ExecuteTableProcedure", { table: resource().table })).toBe(false);
  expect(allowed("ExecuteTableProcedure", { table: resource().table, function: {} })).toBe(false);
  for (const name of ["OPTIMIZE", "optimize"]) {
    expect(allowed("ExecuteTableProcedure", { table: resource().table, function: { name } })).toBe(false);
  }
  expect(allowed("ExecuteTableProcedure", { function: resource().function })).toBe(false);
  expect(allowed("ExecuteProcedure", resource())).toBe(false);
});

semanticTest.each(grant.tables)("no data privileges on %s", (table) => {
  for (const operation of [
    "SelectFromColumns", "InsertIntoTable", "DeleteFromTable", "UpdateTableColumns", "CreateTable", "DropTable",
  ]) expect(allowed(operation, resource(table)), `${operation} ${table}`).toBe(false);
});

semanticTest("no other groups or system metadata are implied", () => {
  for (const groups of [[], ["analysts"], ["engineers"], ["admins"], ["transformers"], ["svc-maintenance"]]) {
    expect(allowed("ExecuteTableProcedure", resource(), groups)).toBe(false);
  }
  expect(allowed("ExecuteQuery")).toBe(true);
  for (const operation of ["AccessCatalog", "FilterCatalogs"]) {
    expect(allowed(operation, { catalog: { name: "iceberg" } })).toBe(true);
    expect(allowed(operation, { catalog: { name: "system" } })).toBe(false);
    expect(allowed(operation, { catalog: { name: "other" } })).toBe(false);
  }
  expect(allowed("SelectFromColumns", resource("metadata.materialized_views", "optimize", "system"))).toBe(false);
});
