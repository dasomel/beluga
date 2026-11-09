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
