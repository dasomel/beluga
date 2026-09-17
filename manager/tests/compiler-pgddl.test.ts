import { expect, test } from "vitest";
import { compilePgDdl } from "../src/compiler/pgddl.js";
import { parseDeclaration } from "../src/schema.js";

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
