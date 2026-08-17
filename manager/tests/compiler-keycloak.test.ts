import { expect, test } from "vitest";
import { compileKeycloak } from "../src/compiler/keycloak.js";
import { parseDeclaration } from "../src/schema.js";

const d = parseDeclaration(`
roles:
  - name: beluga-engineer
    includes: [beluga-analyst]
  - name: beluga-analyst
groups:
  - name: engineers
    roles: [beluga-engineer]
resources: []
`);

test("컴포지트 롤을 만든다", () => {
  const spec = compileKeycloak(d);
  const engineer = spec.realmRoles.find((r) => r.name === "beluga-engineer");
  expect(engineer?.composite).toBe(true);
  expect(engineer?.composites).toEqual(["beluga-analyst"]);
});

test("상속이 없는 롤은 composite가 아니다", () => {
  const analyst = compileKeycloak(d).realmRoles.find((r) => r.name === "beluga-analyst");
  expect(analyst?.composite).toBe(false);
  expect(analyst?.composites).toEqual([]);
});

test("그룹에 롤을 매핑한다", () => {
  expect(compileKeycloak(d).groups).toEqual([{ name: "engineers", realmRoles: ["beluga-engineer"] }]);
});

test("결정론적이다 — 이름순으로 정렬된다", () => {
  const names = compileKeycloak(d).realmRoles.map((r) => r.name);
  expect(names).toEqual(["beluga-analyst", "beluga-engineer"]);
});
