import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { declarationSchema, schemaGrantSchema } from "../src/schema.js";
import type { Declaration } from "../src/schema.js";
import { validateDeclaration } from "../src/validate.js";

const declaration = declarationSchema.parse(Object.assign({}, ...[
  "roles", "groups", "resources", "catalog",
].map((name) => parse(readFileSync(new URL(`../../../../policies/${name}.yaml`, import.meta.url), "utf8")))));
const grant = declaration.schemaGrants![0]!;
const artifacts = compileAll(declaration);
const workDir = mkdtempSync(join(tmpdir(), "schema-grants-"));
const regoPath = join(workDir, "trino.rego");
writeFileSync(regoPath, artifacts.rego);
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// OPA is optional for the TypeScript-only package suite; local/CI semantic verification
// must install OPA and run this suite without skipped cases (see compiler docs).
const hasOpa = spawnSync("opa", ["version"], { encoding: "utf8" }).status === 0;
const semanticTest = test.skipIf(!hasOpa);
const table = (schemaName: string, tableName = "orders", catalogName = "iceberg") => ({
  table: { catalogName, schemaName, tableName, columns: ["order_id"] },
});
const schema = (schemaName: string, catalogName = "iceberg") => ({ schema: { catalogName, schemaName } });

function allowed(operation: string, resource = {}, targetResource?: object, groups = ["transformers"]): boolean {
  const result = spawnSync("opa", ["eval", "--stdin-input", "--data", regoPath, "--format", "raw", "data.trino.allow"], {
    encoding: "utf8",
    input: JSON.stringify({
      context: { identity: { user: "svc-dbt", groups } },
      action: { operation, resource, ...(targetResource ? { targetResource } : {}) },
    }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^(true|false)$/);
  return result.stdout.trim() === "true";
}

test("schema grants require explicit schema identifiers, operations and catalog", () => {
  for (const schemas of [[], ["*"], ["silver_*"], ["lake.orders"], [""]]) {
    expect(schemaGrantSchema.safeParse({ ...grant, schemas }).success).toBe(false);
  }
  expect(schemaGrantSchema.safeParse({ ...grant, catalog: "other" }).success).toBe(false);
  expect(schemaGrantSchema.safeParse({ ...grant, operations: ["DropSchema"] }).success).toBe(false);
  expect(schemaGrantSchema.safeParse({ ...grant, operations: [] }).success).toBe(false);
});

test("semantic validation rejects direct-call wildcards, duplicate grants and unknown roles", () => {
  const invalid = (patch: object): Declaration => ({ ...declaration, schemaGrants: [{ ...grant, ...patch }] });
  expect(validateDeclaration(invalid({ schemas: ["*"] })).map((e) => e.code)).toContain("INVALID_SCHEMA_GRANT");
  expect(validateDeclaration(invalid({ roles: ["missing"] })).map((e) => e.code)).toContain("UNKNOWN_ROLE");
  expect(validateDeclaration(invalid({ schemas: ["silver_shop", "silver_shop"] })).map((e) => e.code))
    .toContain("DUPLICATE_SCHEMA_GRANT");
});

test("transformers is independent and source grants stay Trino-only", () => {
  expect(declaration.roles.find((r) => r.name === "transformers")?.includes ?? []).toEqual([]);
  expect(declaration.roles.filter((r) => r.includes?.includes("transformers"))).toEqual([]);
  expect(artifacts.keycloak.groups.find((g) => g.name === "transformers")?.realmRoles).toEqual(["transformers"]);
  expect(artifacts.pgddl).toContain("CREATE ROLE transformers WITH NOLOGIN INHERIT;");
  expect(artifacts.pgddl).not.toMatch(/GRANT .* TO transformers;/);
});

test("schema grant generation is independent of declaration array order", () => {
  const reordered = {
    ...declaration,
    schemaGrants: [{ ...grant, schemas: [...grant.schemas].reverse(), operations: [...grant.operations].reverse() }],
  };
  expect(compileAll(reordered)).toEqual(artifacts);
  const splitGrants: Declaration = {
    ...declaration,
    schemaGrants: grant.operations.map((operation) => ({ ...grant, operations: [operation] })),
  };
  expect(compileAll({ ...splitGrants, schemaGrants: [...splitGrants.schemaGrants!].reverse() }))
    .toEqual(compileAll(splitGrants));
});

semanticTest.each(["silver_shop", "gold_shop"])("all declared operations allow only %s", (outputSchema) => {
  for (const operation of grant.operations) {
    const resource = ["CreateSchema", "ShowTables", "FilterSchemas"].includes(operation)
      ? schema(outputSchema) : table(outputSchema, "orders__dbt_tmp");
    const target = operation === "RenameTable" ? table(outputSchema, "orders") : undefined;
    expect(allowed(operation, resource, target), operation).toBe(true);
  }
});

semanticTest("renames require source and target catalog/schema inside the same allowed set", () => {
  expect(allowed("RenameTable", table("silver_shop"), table("gold_shop"))).toBe(true);
  for (const [source, target] of [
    [table("silver_shop"), table("lake")],
    [table("lake"), table("silver_shop")],
    [table("gold_shop"), table("gold_shop", "orders", "other")],
    [table("gold_shop", "orders", "other"), table("gold_shop")],
  ]) expect(allowed("RenameTable", source, target)).toBe(false);
  expect(allowed("RenameTable", table("silver_shop"))).toBe(false);
});

semanticTest("source SELECT and view-source access are exact-table only", () => {
  for (const operation of ["SelectFromColumns", "CreateViewWithSelectFromColumns"]) {
    expect(allowed(operation, table("lake", "orders"))).toBe(true);
    expect(allowed(operation, table("lake", "customers"))).toBe(false);
    expect(allowed(operation, table("lake", "events_enriched"))).toBe(false);
    expect(allowed(operation, table("lake", "orders", "other"))).toBe(false);
  }
  for (const operation of ["CreateTable", "InsertIntoTable", "DeleteFromTable", "DropTable", "CreateView", "DropView", "SetTableProperties"]) {
    expect(allowed(operation, table("lake")), operation).toBe(false);
    expect(allowed(operation, table("unrelated")), operation).toBe(false);
  }
  expect(allowed("CreateSchema", schema("other_name"))).toBe(false);
  expect(allowed("CreateSchema", schema("lake"))).toBe(false);
  expect(allowed("CreateSchema", schema("silver_shop", "other"))).toBe(false);
});

semanticTest("non-transformers cannot create output tables even with svc-dbt username", () => {
  for (const groups of [[], ["analysts"], ["engineers"], ["admins"], ["service-account-dbt"]]) {
    expect(allowed("CreateTable", table("silver_shop"), undefined, groups)).toBe(false);
  }
  expect(allowed("SelectFromColumns", table("lake", "customers"))).toBe(false);
  expect(allowed("SelectFromColumns", table("lake", "customers"), undefined, ["engineers"])).toBe(true);
  expect(allowed("SelectFromColumns", table("lake", "orders"), undefined, ["analysts"])).toBe(true);
});

semanticTest("catalog gates and information_schema reads preserve per-candidate filtering", () => {
  expect(allowed("ExecuteQuery")).toBe(true);
  for (const operation of ["AccessCatalog", "FilterCatalogs", "ShowSchemas"]) {
    expect(allowed(operation, { catalog: { name: "iceberg" } })).toBe(true);
    expect(allowed(operation, { catalog: { name: "other" } })).toBe(false);
    expect(allowed(operation, { catalog: { name: "system" } })).toBe(false);
  }
  expect(allowed("SelectFromColumns", table("information_schema", "tables"))).toBe(true);
  expect(allowed("SelectFromColumns", table("information_schema", "columns"))).toBe(true);
  expect(allowed("SelectFromColumns", table("information_schema", "schemata"))).toBe(true);
  expect(["silver_shop", "gold_shop", "lake", "information_schema", "private"]
    .filter((name) => allowed("FilterSchemas", schema(name))))
    .toEqual(["silver_shop", "gold_shop", "lake", "information_schema"]);
  for (const operation of ["FilterTables", "FilterColumns", "ShowColumns", "ShowCreateTable"]) {
    expect(["orders", "customers", "events_enriched"].filter((name) => allowed(operation, table("lake", name))))
      .toEqual(["orders"]);
  }
  expect(allowed("ShowTables", schema("lake"))).toBe(true);
  expect(allowed("ShowTables", schema("private"))).toBe(false);
  expect(allowed("SelectFromColumns", table("runtime", "queries", "system"))).toBe(false);
});
