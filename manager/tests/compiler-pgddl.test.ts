import { expect, test } from "vitest";
import { compilePgDdl } from "../src/compiler/pgddl.js";
import { parseDeclaration } from "../src/schema.js";
import { validateDeclaration } from "../src/validate.js";

const decl = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
      - roles: [engineers]
        privileges: [select, insert, update, delete]
`);

// 롤 이름 자체(analysts/engineers)에는 하이픈이 없어 toPgRole()이 항등에 가깝다 — 하이픈이
// 실제로 언더스코어로 바뀌는 케이스는 아래 "Team-A → team_a" 테스트가 별도로 검증한다.
test("선언의 롤 이름으로 CREATE ROLE을 생성한다", () => {
  expect(compilePgDdl(decl)).toContain("CREATE ROLE analysts WITH NOLOGIN INHERIT");
});

test("롤을 멱등하게 생성한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("pg_roles WHERE rolname = 'analysts'");
  expect(sql).toContain("CREATE ROLE analysts WITH NOLOGIN INHERIT");
});

test("상속을 GRANT role TO role로 표현한다", () => {
  expect(compilePgDdl(decl)).toContain("GRANT analysts TO engineers;");
});

test("권한을 GRANT로 부여한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("GRANT SELECT ON TABLE public.orders TO analysts;");
  expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO engineers;");
});

test("PostgreSQL 리소스만 스키마·테이블·시퀀스 권한으로 컴파일한다", () => {
  const mixed = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
groups: []
resources:
  - resource: lake.events
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
      - roles: [engineers]
        privileges: [select, insert]
  - resource: public.customers
    engine: postgres
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [engineers]
        privileges: [select, insert]
        allowUnmasked: true
`);
  const sql = compilePgDdl(mixed);
  expect(sql).toContain("GRANT USAGE ON SCHEMA public TO analysts;");
  expect(sql).toContain("GRANT USAGE ON SCHEMA public TO engineers;");
  expect(sql).toContain("GRANT SELECT ON TABLE public.orders TO analysts;");
  expect(sql).toContain("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO engineers;");
  expect(sql).not.toContain("lake.events");
  expect(sql).not.toContain("REVOKE");
  expect(sql).not.toContain("ALTER DEFAULT PRIVILEGES");
});

test("ALTER DEFAULT PRIVILEGES를 만들지 않는다 (§10.1 기본 거부)", () => {
  expect(compilePgDdl(decl)).not.toContain("ALTER DEFAULT PRIVILEGES");
});

test("결정론적이다", () => {
  expect(compilePgDdl(decl)).toBe(compilePgDdl(decl));
});

// 수정 라운드 2: PostgreSQL은 따옴표 없는 식별자를 소문자로 접는다. CREATE ROLE Team_A는 실제로는
// team_a를 만드므로, 컴파일러가 서버가 실제로 갖게 될 이름을 정직하게 출력해야 드리프트 비교가 맞는다.
test("대문자가 섞인 롤 이름을 PG가 실제로 접는 소문자로 출력한다 (Team-A → team_a)", () => {
  const upper = parseDeclaration(`
roles:
  - name: Team-A
groups: []
resources: []
`);
  const sql = compilePgDdl(upper);
  expect(sql).toContain("CREATE ROLE team_a WITH NOLOGIN INHERIT");
  expect(sql).not.toContain("Team-A");
  expect(sql).not.toContain("Team_A");
});

// beluga #107(D-3): LOGIN 계정 + CONNECT 그랜트 자동화
const withLogin = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
      - roles: [engineers]
        privileges: [select, insert]
logins:
  - name: beluga-analyst
    memberOf: [analysts]
    database: shop
  - name: beluga-engineer
    memberOf: [engineers]
    database: shop
`);

test("LOGIN 계정 이름의 하이픈을 보존해 큰따옴표 식별자로 생성한다", () => {
  const sql = compilePgDdl(withLogin);
  expect(sql).toContain("CREATE ROLE \"beluga-analyst\" WITH LOGIN INHERIT");
  expect(sql).toContain("CREATE ROLE \"beluga-engineer\" WITH LOGIN INHERIT");
  expect(sql).toContain("pg_roles WHERE rolname = 'beluga-analyst'");
});

test("LOGIN 계정을 memberOf 정책 롤에 GRANT로 바인딩한다", () => {
  const sql = compilePgDdl(withLogin);
  expect(sql).toContain('GRANT analysts TO "beluga-analyst";');
  expect(sql).toContain('GRANT engineers TO "beluga-engineer";');
});

test("테이블 그랜트로부터 CONNECT ON DATABASE를 유도한다", () => {
  const sql = compilePgDdl(withLogin);
  expect(sql).toContain("GRANT CONNECT ON DATABASE shop TO analysts;");
  expect(sql).toContain("GRANT CONNECT ON DATABASE shop TO engineers;");
});

test("logins가 없는 기존 선언은 LOGIN 섹션을 만들지 않는다 (additive-only)", () => {
  expect(compilePgDdl(decl)).not.toContain("WITH LOGIN INHERIT");
  expect(compilePgDdl(decl)).not.toContain("CONNECT ON DATABASE");
});

test("LOGIN 컴파일도 결정론적이다", () => {
  expect(compilePgDdl(withLogin)).toBe(compilePgDdl(withLogin));
});

test("memberOf가 선언되지 않은 롤을 참조하면 UNKNOWN_ROLE 검증 에러를 낸다", () => {
  const bad = parseDeclaration(`
roles:
  - name: analysts
groups: []
resources: []
logins:
  - name: beluga-analyst
    memberOf: [ghost]
    database: shop
`);
  const errors = validateDeclaration(bad);
  expect(errors).toContainEqual(
    expect.objectContaining({ code: "UNKNOWN_ROLE", message: expect.stringContaining("beluga-analyst") }),
  );
});

test("LOGIN 이름이 선언된 롤의 toPgRole() 결과와 같으면 레거시 별칭 충돌로 거부한다", () => {
  const bad = parseDeclaration(`
roles:
  - name: beluga_analyst
groups: []
resources: []
logins:
  - name: beluga_analyst
    memberOf: [beluga_analyst]
    database: shop
`);
  const errors = validateDeclaration(bad);
  expect(errors).toContainEqual(expect.objectContaining({ code: "LOGIN_NAME_COLLISION" }));
});

test("LOGIN 이름의 하이픈이 정책 롤(toPgRole 결과)과 다르면 충돌로 보지 않는다", () => {
  const ok = parseDeclaration(`
roles:
  - name: beluga-analyst
groups: []
resources: []
logins:
  - name: beluga-analyst-login
    memberOf: [beluga-analyst]
    database: shop
`);
  const errors = validateDeclaration(ok);
  expect(errors.filter((e) => e.code === "LOGIN_NAME_COLLISION")).toHaveLength(0);
});

// 보안 리뷰: login.database가 화이트리스트 없이 pgddl.ts의 GRANT CONNECT ON DATABASE에
// 그대로 이스케이프 없이 꽂혀 들어가 SQL 인젝션/권한 상승으로 이어졌다(D20).
test("악의적인 login.database 값은 INVALID_IDENTIFIER로 거부된다", () => {
  const malicious = parseDeclaration(`
roles:
  - name: analysts
groups: []
resources: []
logins:
  - name: beluga-analyst
    memberOf: [analysts]
    database: "shop TO PUBLIC; ALTER ROLE analysts WITH SUPERUSER; --"
`);
  const errors = validateDeclaration(malicious);
  expect(errors).toContainEqual(
    expect.objectContaining({ code: "INVALID_IDENTIFIER", message: expect.stringContaining("database") }),
  );
});

test("database에 login이 없는 롤은 그 database의 CONNECT를 받지 않는다 (over-grant 방지)", () => {
  const scoped = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
      - roles: [engineers]
        privileges: [select]
logins:
  - name: beluga-analyst
    memberOf: [analysts]
    database: shop
`);
  const sql = compilePgDdl(scoped);
  expect(sql).toContain("GRANT CONNECT ON DATABASE shop TO analysts;");
  expect(sql).not.toContain("GRANT CONNECT ON DATABASE shop TO engineers;");
});

// 2차 보안 리뷰 Defect A: login.database는 LOGIN_NAME(하이픈 허용)이 아니라 IDENTIFIER로
// 검증해야 한다. 하이픈이 섞이면 pgddl.ts가 따옴표 없이 그대로 꽂아 넣어 SQL 문법 오류가
// 나고, 대소문자가 섞이면 Postgres의 unquoted-identifier 소문자 폴딩으로 실제 DB명과
// 어긋난다.
test("login.database에 하이픈이 있으면 INVALID_IDENTIFIER로 거부된다 (IDENTIFIER, LOGIN_NAME 아님)", () => {
  const hyphenated = parseDeclaration(`
roles:
  - name: analysts
groups: []
resources: []
logins:
  - name: beluga-analyst
    memberOf: [analysts]
    database: shop-prod
`);
  const errors = validateDeclaration(hyphenated);
  expect(errors).toContainEqual(
    expect.objectContaining({ code: "INVALID_IDENTIFIER", message: expect.stringContaining("database") }),
  );
});

// 2차 보안 리뷰 Defect B: CONNECT 유도가 memberOf 직접 멤버십만 보고 includes 상속을
// 놓치면, 테이블 그랜트를 가진 롤이 아니라 그 롤을 includes하는 상위 롤에 속한 LOGIN이
// CONNECT를 못 받아 접속 자체가 불가능해진다.
test("CONNECT 유도가 includes 상속을 따라간다 (analysts includes readers, readers가 테이블 그랜트 보유)", () => {
  const inherited = parseDeclaration(`
roles:
  - name: readers
  - name: analysts
    includes: [readers]
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [readers]
        privileges: [select]
logins:
  - name: alice
    memberOf: [analysts]
    database: shop
`);
  const sql = compilePgDdl(inherited);
  expect(sql).toContain("GRANT CONNECT ON DATABASE shop TO readers;");
});
