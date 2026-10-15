import { expect, test } from "vitest";
import { parseDeclaration } from "../src/schema.js";

test("유효한 선언을 파싱한다", () => {
  const yaml = `
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
groups:
  - name: analysts
    roles: [analysts]
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analysts]
        privileges: [select]
        columnMask:
          email: hash
`;
  const d = parseDeclaration(yaml);
  expect(d.roles).toHaveLength(2);
  expect(d.roles[1]?.includes).toEqual(["analysts"]);
  expect(d.resources[0]?.classification).toBe("pii");
  expect(d.resources[0]?.grants[0]?.columnMask?.email).toBe("hash");
  expect(d.resources[0]?.engine).toBe("trino");
});

test("PostgreSQL 엔진을 명시적으로 파싱하고 알 수 없는 엔진은 거부한다", () => {
  const postgres = parseDeclaration(`
roles: []
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants: []
`);
  expect(postgres.resources[0]?.engine).toBe("postgres");
  expect(() => parseDeclaration(`
roles: []
groups: []
resources:
  - resource: public.orders
    engine: mysql
    classification: internal
    grants: []
`)).toThrow();
});

test("알 수 없는 privilege는 거부한다", () => {
  const yaml = `
roles: []
groups: []
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [r]
        privileges: [drop]
`;
  expect(() => parseDeclaration(yaml)).toThrow();
});

test("모르는 키는 거부한다", () => {
  expect(() => parseDeclaration(`
roles: []
groups: []
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analysts]
        privileges: [select]
        columMask: { email: hash }
`)).toThrow();
});
