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
test("하이픈을 포함한 롤 이름은 허용한다 (analysts 형태)", () => {
  const d = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
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

// 수정 라운드 1: data-team과 data_team은 둘 다 ROLE_NAME 화이트리스트를 통과하지만
// toPgRole()이 하이픈을 언더스코어로 바꾸므로 같은 PG 롤 data_team으로 조용히 합쳐진다.
test("정규화 후 같은 PG 롤이 되는 두 롤 이름을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: data-team
  - name: data_team
groups: []
resources: []
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("ROLE_NAME_COLLISION");
  const collision = errs.find((e) => e.code === "ROLE_NAME_COLLISION");
  expect(collision?.message).toContain("data-team");
  expect(collision?.message).toContain("data_team");
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

// 수정 라운드 6: 라운드 5부터 allowUnmasked 그랜트는 자신의 columnMask에 가드가 없다.
// 서로 다른 두 opted-out 그랜트가 같은 컬럼을 다른 방식으로 마스킹하고 보유자가 겹치면,
// 두 규칙이 모두 가드 없이 평가돼 OPA가 eval_conflict_error를 낸다(재검토 candidate L,
// 실측: HTTP 500). 컴파일 타임이 아니라 검증 시점에 막는다.
test("candidate L: 서로 다른 두 opted-out 그랜트가 같은 컬럼을 다른 방식으로 마스킹하고 보유자가 겹치면 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.conflict
    classification: pii
    sensitiveColumns: [ssn]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: partial }
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("CONFLICTING_MASK");
  const conflict = errs.find((e) => e.code === "CONFLICTING_MASK");
  // 저자가 파일에서 찾을 수 있는 정보 — 리소스, 컬럼, 두 그랜트를 롤 목록으로.
  expect(conflict?.message).toContain("lake.conflict");
  expect(conflict?.message).toContain("ssn");
  expect(conflict?.message).toContain("g1");
  expect(conflict?.message).toContain("g2");
});

test("이전에 HTTP 500을 냈던 선언이 이제 검증에서 막힌다 — 실제로 저자가 조치할 수 있는 메시지를 낸다", () => {
  // 재검토 candidate L의 선언 그대로. 라운드 5까지는 validateDeclaration이 이걸 통과시켰고
  // (양쪽 그랜트가 각자 allowUnmasked라 PII_UNMASKED를 개별적으로 피했다), 컴파일된 Rego는
  // multi가 이 컬럼을 조회할 때 opa eval_conflict_error(HTTP 500)를 냈다.
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.conflict
    classification: pii
    sensitiveColumns: [ssn]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: partial }
`);
  const errs = validateDeclaration(d);
  // 스퓨리어스 동반 에러가 없는지 확인한다 — CONFLICTING_MASK 하나만 나와야 한다.
  expect(errs.map((e) => e.code)).toEqual(["CONFLICTING_MASK"]);
});

test("candidate M: rowFilter는 같은 모양이어도 거부하지 않는다 (여러 필터가 함께 적용되는 것은 의도된 동작)", () => {
  // rowFilters는 Rego의 partial-set(contains) 규칙이라 여러 개가 동시에 참이어도 그냥
  // 집합으로 합쳐질 뿐 OPA가 충돌로 보지 않는다(complete rule과 다른 규칙 종류) — 실측 확인.
  // 두 그랜트를 모두 보유한 요청자가 두 필터 모두로 좁혀지는 것은 합리적인 동작이다.
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        rowFilter: "region = 'KR'"
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        rowFilter: "region = 'US'"
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

test("같은 종류(kind)로 마스킹하면 값이 같아 OPA가 충돌로 보지 않으므로 거부하지 않는다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.conflict
    classification: pii
    sensitiveColumns: [ssn]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

test("opted-out 그랜트와 일반 그랜트가 같은 컬럼을 마스킹해도, 겹치는 보유자는 항상 일반 쪽 가드에 걸리므로 거부하지 않는다", () => {
  const d = parseDeclaration(`
roles:
  - name: r1
  - name: r2
  - name: multi
    includes: [r1, r2]
groups: []
resources:
  - resource: lake.t
    classification: pii
    sensitiveColumns: [ssn]
    grants:
      - roles: [r1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [r2]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: partial }
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

test("opted-out 그랜트가 이 리소스에 하나도 없어도, 서로 다른 두 일반 그랜트가 같은 컬럼을 다른 방식으로 마스킹하고 보유자가 겹치면 거부한다", () => {
  // opted-out 여부와 무관한, 더 넓은 범위의 같은 실패 모양(가드가 아예 없는 두 그랜트가
  // 겹치는 보유자에게 동시에 평가된다) — 실측으로 같은 eval_conflict_error를 재현했다.
  const d = parseDeclaration(`
roles:
  - name: r1
  - name: r2
  - name: multi
    includes: [r1, r2]
groups: []
resources:
  - resource: lake.t2
    classification: internal
    grants:
      - roles: [r1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [r2]
        privileges: [select]
        columnMask: { ssn: partial }
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("CONFLICTING_MASK");
});

// 수정 라운드 7 — 이슈 1: 롤 상속이 아니라 '그룹'이 두 그랜트를 공동 보유시키는 경우.
// compileKeycloak은 그룹을 그 롤들을 담은 Keycloak 그룹으로 내보내므로, 멤버의 토큰에는
// 그 롤들이 전부 들어간다 — 재검토에서 opa eval로 eval_conflict_error(HTTP 500)까지 재현됨.
test("그룹이 두 롤을 함께 담으면(멤버 토큰에 둘 다 들어간다) 서로 다른 방식으로 마스킹하는 두 그랜트를 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
groups:
  - name: analytics
    roles: [g1, g2]
resources:
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        columnMask: { ssn: partial }
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("CONFLICTING_MASK");
  const conflict = errs.find((e) => e.code === "CONFLICTING_MASK");
  expect(conflict?.message).toContain("lake.conflict");
  expect(conflict?.message).toContain("ssn");
});

test("그룹이 두 opted-out 그랜트를 함께 담아도(롤 상속 없이) 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
groups:
  - name: analytics
    roles: [g1, g2]
resources:
  - resource: lake.conflict
    classification: pii
    sensitiveColumns: [ssn]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: partial }
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("CONFLICTING_MASK");
});

test("그룹이 담은 롤이 겹치지 않으면(각기 다른 컬럼) 그룹만으로 거짓 충돌을 만들지 않는다", () => {
  // 재검토 라운드 7 — 이슈 4: 두 마스킹을 같은 kind(hash/hash)로 두면 a.kind === b.kind
  // 가드만으로도 통과해, 이 테스트가 실제로 검증하려는 "컬럼별로 나눠 비교한다"는 동작을
  // 전혀 거치지 않고도 green이 된다(맵을 컬럼 하나로 뭉개는 뮤테이션을 넣어도 여전히
  // green — 실측). kind를 다르게(hash/partial) 둬야 컬럼 그룹핑이 실제로 둘을 분리한다는
  // 것을 검증한다: 컬럼이 뭉개지면 kind가 달라 CONFLICTING_MASK가 나야 정상이기 때문이다.
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
groups:
  - name: analytics
    roles: [g1, g2]
resources:
  - resource: lake.ok
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        columnMask: { email: partial }
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

// 재검토 라운드 7 — 이슈 1: 롤과 그룹은 Keycloak에서 별개 네임스페이스라 이름이 같아도
// 공존할 수 있다. 롤 'g1'과 이름이 같은 그룹 'g1'이 롤 'g2'를 담는 이 선언에서, 그룹 'g1'의
// 멤버 토큰에는 'g2'만 들어가고(그룹 이름 자체는 Rego 어디에도 매칭되지 않는다) 롤 'g1'을
// 가진 사용자와는 무관하다 — 실측(opa eval)으로 두 그랜트 모두 서로소 집합에 가드가 걸려
// 절대 같은 토큰에서 충돌하지 않음을 확인했다. holdersOfIncludingGroups가 그룹 이름을
// 태그 없이 롤 이름과 같은 문자열 집합에 섞으면 이 우연한 이름 일치를 거짓 공동 보유로
// 오인해 CONFLICTING_MASK를 잘못 낸다.
test("그룹 이름이 무관한 롤 이름과 우연히 같아도 거짓 CONFLICTING_MASK를 만들지 않는다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
groups:
  - name: g1
    roles: [g2]
resources:
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        columnMask: { ssn: partial }
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

// 재검토 라운드 7 — 이슈 2: 라운드 6은 resourceUnmasked(opt-out 제외 집합) 계산과 per-grant
// holders 계산 둘 다 holdersOfIncludingGroups를 써야 한다고 요구했지만, 그중 resourceUnmasked
// 쪽만 holdersOf로 되돌리는 뮤테이션을 넣어도 기존 스위트 전체가 green이었다(회귀 가드 없음).
// 이 테스트는 그 뮤테이션이 들어오면 실패한다: 그룹 analytics=[g1,g2,g3]에서 g1/g2는 서로
// 다른 방식으로 마스킹하는 일반 그랜트이고, g3는 allowUnmasked인 opted-out 그랜트다 —
// resourceUnmasked가 그룹까지 확장해 g1/g2 보유자를 걸러내야(그룹 analytics가 g3도 담으므로
// g1/g2 보유자는 이 리소스에서 이미 unmasked 가드에 걸린 것과 같다) 거짓 충돌이 나지
// 않는다. resourceUnmasked가 holdersOf로 되돌아가면 그룹은 opt-out 집합에 안 잡히고
// g1/g2의 overlap이 그대로 남아 CONFLICTING_MASK가 거짓 발생한다.
test("opt-out 제외 집합도 그룹까지 확장해야 한다 — 그룹이 opt-out 롤과 일반 롤을 함께 담으면 거짓 충돌을 만들지 않는다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: g3
groups:
  - name: analytics
    roles: [g1, g2, g3]
resources:
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        columnMask: { ssn: hash }
      - roles: [g2]
        privileges: [select]
        columnMask: { ssn: partial }
      - roles: [g3]
        privileges: [select]
        allowUnmasked: true
        columnMask: { ssn: hash }
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("CONFLICTING_MASK");
});

// 수정 라운드 7 — 이슈 2: 같은 'schema.table'을 리소스 엔트리 둘로 나눠 선언하면 그랜트가
// 서로 다른 엔트리에 흩어져 CONFLICTING_MASK가 비교조차 하지 못한다 — 재검토에서 opa eval로
// eval_conflict_error까지 재현됨. 엔트리 중복 자체를 거부해 이 우회를 막는다.
test("같은 리소스를 두 엔트리로 나눠 선언하면 DUPLICATE_RESOURCE로 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
        columnMask: { ssn: hash }
  - resource: lake.conflict
    classification: internal
    grants:
      - roles: [g2]
        privileges: [select]
        columnMask: { ssn: partial }
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("DUPLICATE_RESOURCE");
  const dup = errs.find((e) => e.code === "DUPLICATE_RESOURCE");
  expect(dup?.message).toContain("lake.conflict");
});

test("서로 다른 리소스 이름은 DUPLICATE_RESOURCE를 유발하지 않는다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
groups: []
resources:
  - resource: lake.a
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
  - resource: lake.b
    classification: internal
    grants:
      - roles: [g1]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).not.toContain("DUPLICATE_RESOURCE");
});
