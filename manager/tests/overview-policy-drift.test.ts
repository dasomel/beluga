import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { generatedPolicyModule, generateOverviewPolicy } from "../scripts/generate-overview-policy.js";
import { policyProjectionSchema } from "../packages/domain-api/src/schema/policy.js";

test("build snapshot matches real declarations and deployed compiler artifacts, with no fixture dependency", () => {
  expect(readFileSync(new URL("../packages/domain-api/src/adapters/overviewPolicy.generated.ts", import.meta.url), "utf8")).toBe(generatedPolicyModule());
  const policy = policyProjectionSchema.parse(generateOverviewPolicy());
  expect(policy.roles.find((role) => role.name === "analysts")?.permissions.some((permission) => permission.resource === "lake.orders")).toBe(true);
  expect(policy.sourceFile).not.toContain("fixture");
});


test("transformers projection preserves source SELECT and exact output schema grants", () => {
  const policy = policyProjectionSchema.parse(generateOverviewPolicy());
  expect(policy.groups).toContainEqual({ name: "transformers", roles: ["transformers"] });
  const permissions = policy.roles.find((role) => role.name === "transformers")!.permissions;
  expect(permissions).toContainEqual({ resource: "lake.orders", catalog: "iceberg",
    engine: "trino", operation: "select", accessType: "read-only" });
  const schemas = permissions.filter((permission) => permission.resource.endsWith(".*"));
  expect(schemas).toHaveLength(34);
  expect(new Set(schemas.map((permission) => permission.resource))).toEqual(new Set(["silver_shop.*", "gold_shop.*"]));
  for (const resource of ["silver_shop.*", "gold_shop.*"]) {
    expect(schemas).toContainEqual({ resource, catalog: "iceberg", engine: "trino",
      operation: "CreateTable", accessType: "mutating" });
    expect(schemas).toContainEqual({ resource, catalog: "iceberg", engine: "trino",
      operation: "SelectFromColumns", accessType: "read-only" });
  }
  expect(permissions.some((permission) => permission.resource === "lake.customers")).toBe(false);
  expect(policy.roles.find((role) => role.name === "analysts")!.permissions
    .some((permission) => permission.resource === "silver_shop.*")).toBe(false);
});


test("build preparation fails closed on malformed declarations, missing sources and deployed artifact drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "overview-policy-"));
  const root = pathToFileURL(`${dir}/`);
  try {
    cpSync(new URL("../../policies/", import.meta.url), join(dir, "policies"), { recursive: true });
    cpSync(new URL("../../gitops/charts/", import.meta.url), join(dir, "gitops/charts"), { recursive: true });
    expect(generateOverviewPolicy(root).roles.length).toBeGreaterThan(0);
    const rego = new URL("gitops/charts/beluga-platform/files/opa/trino.rego", root);
    const original = readFileSync(rego, "utf8");
    writeFileSync(rego, "drift");
    expect(() => generateOverviewPolicy(root)).toThrow("deployed policy artifact drift");
    writeFileSync(rego, original);
    writeFileSync(new URL("policies/resources.yaml", root), "resources: [broken");
    expect(() => generateOverviewPolicy(root)).toThrow();
    rmSync(new URL("policies/resources.yaml", root));
    expect(() => generateOverviewPolicy(root)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("maintainers projection preserves exact procedures without data privileges", () => {
  const policy = policyProjectionSchema.parse(generateOverviewPolicy());
  expect(policy.groups).toContainEqual({ name: "maintainers", roles: ["maintainers"] });
  const role = policy.roles.find((item) => item.name === "maintainers")!;
  expect(role.includes).toEqual([]);
  const procedures = role.permissions.filter((permission) => permission.operation.startsWith("ExecuteTableProcedure:"));
  expect(procedures).toHaveLength(10);
  expect(new Set(procedures.map((permission) => permission.resource))).toEqual(new Set([
    "lake.orders", "lake.customers", "lake.events_enriched", "silver_shop.orders", "gold_shop.daily_revenue",
  ]));
  expect(new Set(procedures.map((permission) => permission.operation))).toEqual(new Set([
    "ExecuteTableProcedure:optimize", "ExecuteTableProcedure:expire_snapshots",
  ]));
  expect(procedures.every((permission) => permission.accessType === "mutating")).toBe(true);
  expect(role.permissions.filter((permission) => !procedures.includes(permission))
    .map((permission) => permission.operation)).toEqual(["ExecuteQuery", "AccessCatalog", "FilterCatalogs"]);
});
