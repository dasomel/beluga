import { expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { parseDeclaration } from "../src/schema.js";

const valid = parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: analysts
    roles: [analyst]
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`);

test("세 산출물을 모두 만든다", () => {
  const a = compileAll(valid);
  expect(a.keycloak.realmRoles).toHaveLength(1);
  expect(a.rego).toContain("package trino");
  expect(a.pgddl).toContain("CREATE ROLE analyst");
});

test("검증 실패 시 컴파일하지 않는다", () => {
  const invalid = parseDeclaration(`
roles: []
groups: []
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [ghost]
        privileges: [select]
`);
  expect(() => compileAll(invalid)).toThrow(/UNKNOWN_ROLE|PII_UNMASKED/);
});
