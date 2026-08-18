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
