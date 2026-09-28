import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { POLICY_OPERATION_ACCESS_TYPE } from "../packages/policy-compiler/src/accessType.js";
import { compileAll } from "../packages/policy-compiler/src/compiler/index.js";
import { parseDeclaration } from "../packages/policy-compiler/src/schema.js";
import type { PolicyPermission, PolicyProjection } from "../packages/domain-api/src/schema/policy.js";
import { platformPolicy } from "../packages/domain-api/src/stub-data/policies.js";

// D2: root test tsconfig만 compiler source를 읽게 해 runtime package dependency/build path를 만들지 않는다.
function metadata(target: "trino-rego" | "postgres-grant" | "keycloak-mapper", content: string) {
  return {
    target,
    contentHash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    lineCount: content.split(/\r?\n/).length,
  };
}

test("static policy projection stays aligned with the policy compiler fixture", () => {
  const yaml = readFileSync(new URL("../packages/domain-api/tests/fixtures/platform-policy.yaml", import.meta.url), "utf8");
  const declaration = parseDeclaration(yaml);
  const compiled = compileAll(declaration);

  const artefacts = [
    metadata("trino-rego", compiled.rego),
    metadata("postgres-grant", compiled.pgddl),
    metadata("keycloak-mapper", JSON.stringify(compiled.keycloak, null, 2)),
  ];

  const expectedPermissions = declaration.roles.map((role) => {
    const permissions: PolicyPermission[] = [];

    for (const resource of declaration.resources) {
      for (const grant of resource.grants) {
        if (!grant.roles.includes(role.name)) continue;
        for (const operation of grant.privileges) {
          permissions.push({
            resource: resource.resource,
            catalog: resource.engine === "postgres" ? "postgres" : "iceberg",
            engine: resource.engine ?? "trino",
            operation,
            accessType: POLICY_OPERATION_ACCESS_TYPE[operation],
            ...(grant.columnMask === undefined ? {} : { columnMask: grant.columnMask }),
            ...(grant.rowFilter === undefined ? {} : { rowFilter: grant.rowFilter }),
            ...(grant.allowUnmasked === undefined ? {} : { allowUnmasked: grant.allowUnmasked }),
          });
        }
      }
    }

    for (const grant of declaration.catalogGrants ?? []) {
      if (!grant.roles.includes(role.name)) continue;
      for (const operation of grant.operations) {
        permissions.push({
          resource: `${grant.catalog}.*`,
          catalog: grant.catalog,
          engine: "trino",
          operation,
          accessType: POLICY_OPERATION_ACCESS_TYPE[operation],
        });
      }
    }

    return { name: role.name, includes: role.includes ?? [], permissions };
  });

  const expectedProjection: PolicyProjection = {
    id: "beluga-platform-policy",
    name: "Beluga Platform Policy",
    version: "0.1.0",
    description: "Fixture-backed policy summary; not a live Keycloak or OPA integration.",
    sourceFile: "packages/domain-api/tests/fixtures/platform-policy.yaml",
    evaluatedAt: "2026-09-28T09:00:00.000Z",
    roles: expectedPermissions,
    groups: declaration.groups.map((group) => ({ name: group.name, roles: group.roles })),
    artefacts,
  };

  expect(platformPolicy).toEqual(expectedProjection);
});
