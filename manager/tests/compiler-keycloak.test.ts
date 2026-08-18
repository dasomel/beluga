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

// 라운드 2 추가: localeCompare는 런타임 로케일/ICU 빌드에 의존한다. 이 환경에서 실측한 값:
// "Z_role".localeCompare("z_role") === 1 (즉 z_role이 먼저 온다), 순수 코드 포인트 비교로는
// 대문자가 소문자보다 앞선다("Z_role" < "z_role"). rego.ts는 이미 순수 비교로 고쳤는데
// keycloak.ts만 localeCompare로 남아있으면 두 컴파일러의 drift 비교가 로케일에 따라 어긋난다.
test("localeCompare 대신 순수 비교로 정렬해 로케일에 독립적이다 (realmRoles)", () => {
  const d2 = parseDeclaration(`
roles:
  - name: Z_role
  - name: z_role
groups: []
resources: []
`);
  const names = compileKeycloak(d2).realmRoles.map((r) => r.name);
  expect(names).toEqual(["Z_role", "z_role"]);
});

test("localeCompare 대신 순수 비교로 정렬해 로케일에 독립적이다 (groups)", () => {
  const d2 = parseDeclaration(`
roles:
  - name: r
groups:
  - name: Z_group
    roles: [r]
  - name: z_group
    roles: [r]
resources: []
`);
  const names = compileKeycloak(d2).groups.map((g) => g.name);
  expect(names).toEqual(["Z_group", "z_group"]);
});
