import { expect, test, vi } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { parseDeclaration } from "../src/schema.js";
import * as keycloakCompiler from "../src/compiler/keycloak.js";
import * as regoCompiler from "../src/compiler/rego.js";
import * as pgddlCompiler from "../src/compiler/pgddl.js";

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

test("검증 실패 시 컴파일하지 않는다 — 세 컴파일러 중 어느 것도 호출되지 않는다", () => {
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
  // "예외가 던져진다"만으로는 컴파일이 실제로 건너뛰어졌는지 증명하지 않는다 — 세 컴파일러가
  // 실행조차 되지 않았음을 스파이로 직접 확인한다(§Important 3 리뷰 지적).
  const keycloakSpy = vi.spyOn(keycloakCompiler, "compileKeycloak");
  const regoSpy = vi.spyOn(regoCompiler, "compileRego");
  const pgddlSpy = vi.spyOn(pgddlCompiler, "compilePgDdl");
  try {
    expect(() => compileAll(invalid)).toThrow(/UNKNOWN_ROLE|PII_UNMASKED/);
    expect(keycloakSpy).not.toHaveBeenCalled();
    expect(regoSpy).not.toHaveBeenCalled();
    expect(pgddlSpy).not.toHaveBeenCalled();
  } finally {
    keycloakSpy.mockRestore();
    regoSpy.mockRestore();
    pgddlSpy.mockRestore();
  }
});
