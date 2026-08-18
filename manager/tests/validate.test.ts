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

test("allowUnmasked: true는 PII 마스킹 요구를 무시한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [engineer]
        privileges: [select]
        allowUnmasked: true
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("allowUnmasked: false는 PII 마스킹을 요구한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        allowUnmasked: false
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("allowUnmasked: true여도 sensitiveColumns이 없으면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [engineer]
        privileges: [select]
        allowUnmasked: true
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_NO_SENSITIVE_COLUMNS");
});

test("allowUnmasked: true와 부분 마스킹은 함께 사용할 수 있다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        allowUnmasked: true
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("상속을 확장한다 (결정론적 정렬)", () => {
  const d = base(`resources: []`);
  expect(expandRoles(d, "engineer")).toEqual(["analyst", "engineer"]);
  expect(expandRoles(d, "analyst")).toEqual(["analyst"]);
});

test("리소스 이름이 schema.table 식별자 형식이 아니면 거부한다 (수정 라운드 1)", () => {
  const d = base(`
resources:
  - resource: 'lake.tbl" or 1=1'
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("점이 없거나 두 개 이상인 리소스 이름을 거부한다", () => {
  const noDot = base(`
resources:
  - resource: onlyname
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(noDot).map((e) => e.code)).toContain("INVALID_IDENTIFIER");

  const twoDots = base(`
resources:
  - resource: lake.schema.table
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(twoDots).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("sensitiveColumns 항목이 식별자가 아니면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: ['email" }']
    grants:
      - roles: [engineer]
        privileges: [select]
        allowUnmasked: true
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("columnMask 키가 식별자가 아니면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          'email" }': hash
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

// 수정 라운드 3: 롤/그룹 이름도 Rego 코드에 그대로 내려간다 — 컬럼과 달리 하이픈은 허용해야 한다.
test("하이픈을 포함한 롤 이름은 허용한다 (beluga-analyst 형태)", () => {
  const d = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups: []
resources: []
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("올바른 형식이 아닌 롤 이름을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: 'r" }'
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("올바른 형식이 아닌 includes 항목을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: analyst
  - name: engineer
    includes: ['analyst" }']
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("올바른 형식이 아닌 그룹 이름을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: 'g" }'
    roles: [analyst]
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("올바른 형식이 아닌 그룹의 롤 항목을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: g
    roles: ['analyst" }']
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

test("올바른 형식이 아닌 그랜트 롤을 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: ['analyst" }']
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("INVALID_IDENTIFIER");
});

// 수정 라운드 1: beluga-analyst와 beluga_analyst는 둘 다 ROLE_NAME 화이트리스트를 통과하지만
// toPgRole()이 하이픈을 언더스코어로 바꾸므로 같은 PG 롤 beluga_analyst로 조용히 합쳐진다.
test("정규화 후 같은 PG 롤이 되는 두 롤 이름을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga_analyst
groups: []
resources: []
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("ROLE_NAME_COLLISION");
  const collision = errs.find((e) => e.code === "ROLE_NAME_COLLISION");
  expect(collision?.message).toContain("beluga-analyst");
  expect(collision?.message).toContain("beluga_analyst");
});

test("언더스코어만 있는 롤 이름은 다른 이름과 충돌하지 않으면 허용한다", () => {
  const d = parseDeclaration(`
roles:
  - name: data_team
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("ROLE_NAME_COLLISION");
});

test("하이픈과 언더스코어 버전이 같이 있으면 거부한다 (data-team / data_team)", () => {
  const d = parseDeclaration(`
roles:
  - name: data-team
  - name: data_team
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("ROLE_NAME_COLLISION");
});

// 수정 라운드 2: PostgreSQL은 따옴표 없는 식별자를 소문자로 접는다. Team-A로 CREATE ROLE하면
// 서버는 team_a를 만든다 — team_a라는 별도 선언과 같은 물리 롤이 된다.
test("대소문자만 다른 두 롤 이름을 거부한다 (Team-A / team_a)", () => {
  const d = parseDeclaration(`
roles:
  - name: Team-A
  - name: team_a
groups: []
resources: []
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("ROLE_NAME_COLLISION");
  const collision = errs.find((e) => e.code === "ROLE_NAME_COLLISION");
  expect(collision?.message).toContain("Team-A");
  expect(collision?.message).toContain("team_a");
});
