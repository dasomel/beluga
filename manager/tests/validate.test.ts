import { expect, test } from "vitest";
import { parseDeclaration } from "../src/schema.js";
import { expandRoles, validateDeclaration } from "../src/validate.js";

const base = (extra: string) => parseDeclaration(`
roles:
  - name: analyst
  - name: engineer
    includes: [analyst]
groups: []
${extra}
`);

test("정의되지 않은 롤 참조를 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [ghost]
        privileges: [select]
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("UNKNOWN_ROLE");
});

test("순환 상속을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: a
    includes: [b]
  - name: b
    includes: [a]
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("CYCLIC_INHERITANCE");
});

test("PII 리소스에 민감 컬럼이 없으면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_NO_SENSITIVE_COLUMNS");
});

test("PII 리소스에 마스킹 없는 select를 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("PII 리소스라도 마스킹이 있으면 허용한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("PII 리소스의 모든 민감 컬럼이 마스킹되어야 한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("rowFilter는 허용 문법만 수용한다", () => {
  // 유효한 cases
  const valid1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'KR'"
`);
  expect(validateDeclaration(valid1)).toEqual([]);

  const valid2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "dept_id IN (1, 2)"
`);
  expect(validateDeclaration(valid2)).toEqual([]);

  const valid3 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "owner = current_user"
`);
  expect(validateDeclaration(valid3)).toEqual([]);

  const valid4 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 AND b <> 'x'"
`);
  expect(validateDeclaration(valid4)).toEqual([]);
});

test("rowFilter는 SQL injection을 거부한다", () => {
  const invalid1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "1=1; DROP TABLE customers"
`);
  expect(validateDeclaration(invalid1).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'KR' OR 1=1 --"
`);
  expect(validateDeclaration(invalid2).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid3 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region IN (SELECT x FROM y)"
`);
  expect(validateDeclaration(invalid3).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid4 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'a''b'"
`);
  expect(validateDeclaration(invalid4).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");
});

test("rowFilter는 AND와 OR을 섞는 것을 거부한다", () => {
  // AND와 OR을 섞으면 SQL 우선순위가 글로 읽히는 것과 달라진다
  const mixed1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "tenant_id = 'acme' AND status = 'active' OR status = 'archived'"
`);
  expect(validateDeclaration(mixed1).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const mixed2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 OR b = 2 AND c = 3"
`);
  expect(validateDeclaration(mixed2).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");
});

test("rowFilter는 한 종류의 연산자만 허용한다", () => {
  // AND 체인만
  const andChain = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 AND b = 2 AND c = 3"
`);
  expect(validateDeclaration(andChain)).toEqual([]);

  // OR 체인만
  const orChain = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 OR b = 2 OR c = 3"
`);
  expect(validateDeclaration(orChain)).toEqual([]);
});

test("상속을 확장한다 (결정론적 정렬)", () => {
  const d = base(`resources: []`);
  expect(expandRoles(d, "engineer")).toEqual(["analyst", "engineer"]);
  expect(expandRoles(d, "analyst")).toEqual(["analyst"]);
});
