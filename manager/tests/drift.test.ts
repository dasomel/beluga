import { expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { diffState } from "../src/drift.js";
import { parseDeclaration } from "../src/schema.js";

const desired = compileAll(parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: analysts
    roles: [analyst]
resources: []
`));

const desiredPg = compileAll(parseDeclaration(`
roles:
  - name: analyst
groups: []
resources:
  - resource: public.orders
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`));

test("선언에만 있으면 미적용이다", () => {
  const items = diffState(desired, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({ kind: "unapplied", target: "keycloak.role/analyst", detail: "선언됨, 실제 없음" });
});

test("실제에만 있으면 수동 변경이다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst", "ghost-role"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toContainEqual({ kind: "manual", target: "keycloak.role/ghost-role", detail: "실제에만 존재 — 수동 변경 의심" });
});

test("일치하면 드리프트가 없다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toEqual([]);
});

test("그룹의 롤 구성이 다르면 불일치다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: [] },
    pgGrants: [],
  });
  expect(items.map((i) => i.kind)).toContain("mismatch");
});

test("실제에만 있는 그룹은 수동 변경이다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: ["analyst"], "ghost-group": [] },
    pgGrants: [],
  });
  expect(items).toContainEqual({
    kind: "manual",
    target: "keycloak.group/ghost-group",
    detail: "실제에만 존재 — 수동 변경 의심",
  });
});

// 없음(undefined) vs 비어 있음([] / {}) 구분 — 어댑터가 그 시스템을 아예 읽지 않은 것과
// 실제로 비어 있다고 확인된 것은 다른 사실이다.
test("어댑터가 롤을 읽지 않았으면(필드 없음) 롤 비교를 건너뛴다", () => {
  const items = diffState(desired, { keycloakGroups: { analysts: ["analyst"] }, pgGrants: [] });
  expect(items.some((i) => i.target.startsWith("keycloak.role/"))).toBe(false);
});

test("어댑터가 그룹을 읽지 않았으면(필드 없음) 그룹 비교를 건너뛴다", () => {
  const items = diffState(desired, { keycloakRoles: ["analyst"], pgGrants: [] });
  expect(items.some((i) => i.target.startsWith("keycloak.group/"))).toBe(false);
});

test("그룹이 실제로 비어 있으면(빈 객체, 필드는 있음) 미적용으로 보고한다", () => {
  const items = diffState(desired, { keycloakRoles: ["analyst"], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({ kind: "unapplied", target: "keycloak.group/analysts", detail: "선언됨, 실제 없음" });
});

test("PG 권한이 아무것도 조회되지 않았으면(필드 없음) PG 비교를 건너뛴다", () => {
  const items = diffState(desiredPg, { keycloakRoles: [], keycloakGroups: {} });
  expect(items.some((i) => i.target.startsWith("pg.grant/"))).toBe(false);
});

test("PG 권한이 선언에만 있으면 미적용이다", () => {
  const items = diffState(desiredPg, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({
    kind: "unapplied",
    target: "pg.grant/public.orders/analyst",
    detail: "선언됨, 실제 없음 — SELECT",
  });
});

test("PG 권한이 실제에만 있으면 수동 변경이다", () => {
  const items = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO ghost;"],
  });
  expect(items).toContainEqual({
    kind: "manual",
    target: "pg.grant/public.orders/ghost",
    detail: "실제에만 존재 — 수동 변경 의심 (SELECT)",
  });
});

test("PG 권한 집합이 다르면 불일치다", () => {
  const items = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT, INSERT ON TABLE public.orders TO analyst;"],
  });
  expect(items).toContainEqual({
    kind: "mismatch",
    target: "pg.grant/public.orders/analyst",
    detail: "권한 집합이 다르다 — 선언: [SELECT], 실제: [SELECT, INSERT]",
  });
});

test("PG 권한이 일치하면 드리프트가 없다", () => {
  const items = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO analyst;"],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

// 결정론 — 실제 시스템 조회 결과의 배열/객체 키 순서는 보장되지 않는다. 같은 집합이면
// 순서가 달라도 항상 같은 출력이어야 한다.
test("실제 상태의 입력 순서와 무관하게 결정론적으로 정렬된다", () => {
  const actual1 = {
    keycloakRoles: ["analyst", "ghost-role", "another-ghost"],
    keycloakGroups: {},
    pgGrants: [],
  };
  const actual2 = {
    keycloakRoles: ["another-ghost", "ghost-role", "analyst"],
    keycloakGroups: {},
    pgGrants: [],
  };
  expect(diffState(desired, actual1)).toEqual(diffState(desired, actual2));
});
