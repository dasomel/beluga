import { expect, test } from "vitest";
import { parseDeclaration } from "../src/schema.js";

test("유효한 선언을 파싱한다", () => {
  const yaml = `
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups:
  - name: analysts
    roles: [beluga-analyst]
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
        columnMask:
          email: hash
`;
  const d = parseDeclaration(yaml);
  expect(d.roles).toHaveLength(2);
  expect(d.roles[1]?.includes).toEqual(["beluga-analyst"]);
  expect(d.resources[0]?.classification).toBe("pii");
  expect(d.resources[0]?.grants[0]?.columnMask?.email).toBe("hash");
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
      - roles: [beluga-analyst]
        privileges: [select]
        columMask: { email: hash }
`)).toThrow();
});
