import { expect, test } from "vitest";
import { compilePgDdl } from "../src/compiler/pgddl.js";
import { parseDeclaration } from "../src/schema.js";

const decl = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups: []
resources:
  - resource: public.orders
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
`);

test("선언의 하이픈을 PG 롤의 언더스코어로 변환한다", () => {
  expect(compilePgDdl(decl)).toContain("CREATE ROLE beluga_analyst WITH NOLOGIN INHERIT");
  expect(compilePgDdl(decl)).not.toContain("beluga-analyst");
});

test("롤을 멱등하게 생성한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("pg_roles WHERE rolname = 'beluga_analyst'");
  expect(sql).toContain("CREATE ROLE beluga_analyst WITH NOLOGIN INHERIT");
});

test("상속을 GRANT role TO role로 표현한다", () => {
  expect(compilePgDdl(decl)).toContain("GRANT beluga_analyst TO beluga_engineer;");
});

test("권한을 GRANT로 부여한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("GRANT SELECT ON TABLE public.orders TO beluga_analyst;");
  expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO beluga_engineer;");
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
