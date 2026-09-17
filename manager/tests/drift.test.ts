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
    engine: postgres
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`));

test("선언에만 있으면 미적용이다", () => {
  const { items } = diffState(desired, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({ kind: "unapplied", target: "keycloak.role/analyst", detail: "선언됨, 실제 없음" });
});

test("실제에만 있으면 수동 변경이다", () => {
  const { items } = diffState(desired, {
    keycloakRoles: ["analyst", "ghost-role"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toContainEqual({ kind: "manual", target: "keycloak.role/ghost-role", detail: "실제에만 존재 — 수동 변경 의심" });
});

test("일치하면 드리프트가 없다", () => {
  const { items } = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toEqual([]);
});

test("그룹의 롤 구성이 다르면 불일치다", () => {
  const { items } = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: [] },
    pgGrants: [],
  });
  expect(items.map((i) => i.kind)).toContain("mismatch");
});

test("실제에만 있는 그룹은 수동 변경이다", () => {
  const { items } = diffState(desired, {
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
  const { items } = diffState(desired, { keycloakGroups: { analysts: ["analyst"] }, pgGrants: [] });
  expect(items.some((i) => i.target.startsWith("keycloak.role/"))).toBe(false);
});

test("어댑터가 그룹을 읽지 않았으면(필드 없음) 그룹 비교를 건너뛴다", () => {
  const { items } = diffState(desired, { keycloakRoles: ["analyst"], pgGrants: [] });
  expect(items.some((i) => i.target.startsWith("keycloak.group/"))).toBe(false);
});

test("그룹이 실제로 비어 있으면(빈 객체, 필드는 있음) 미적용으로 보고한다", () => {
  const { items } = diffState(desired, { keycloakRoles: ["analyst"], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({ kind: "unapplied", target: "keycloak.group/analysts", detail: "선언됨, 실제 없음" });
});

test("PG 권한이 아무것도 조회되지 않았으면(필드 없음) PG 비교를 건너뛴다", () => {
  const { items } = diffState(desiredPg, { keycloakRoles: [], keycloakGroups: {} });
  expect(items.some((i) => i.target.startsWith("pg.grant/"))).toBe(false);
});

test("PG 권한이 선언에만 있으면 미적용이다", () => {
  const { items } = diffState(desiredPg, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({
    kind: "unapplied",
    target: "pg.grant/public.orders/analyst",
    detail: "선언됨, 실제 없음 — SELECT",
  });
});

test("PG 권한이 실제에만 있으면 수동 변경이다", () => {
  const { items } = diffState(desiredPg, {
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
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT, INSERT ON TABLE public.orders TO analyst;"],
  });
  // 표시 순서는 cmp()로 정렬된 정준(canonical) 순서다 — 알파벳순이라 INSERT가 SELECT보다 먼저 온다.
  expect(items).toContainEqual({
    kind: "mismatch",
    target: "pg.grant/public.orders/analyst",
    detail: "권한 집합이 다르다 — 선언: [SELECT], 실제: [INSERT, SELECT]",
  });
});

test("PG 권한이 일치하면 드리프트가 없다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO analyst;"],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

test("스키마 한정 식별자의 따옴표 차이는 PG 드리프트가 아니다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ['GRANT SELECT ON TABLE "public"."orders" TO "analyst";'],
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

// C1/M3 — PG 권한 축은 이전 라운드에서 결정론 검증이 비어 있었고(pgGrants: [] 고정),
// 바로 그 사각지대에서 last-write-wins 결함이 났다. 같은 (table,role) 키를 가리키는
// 여러 줄의 순서를 뒤집어도 병합된 권한 집합·출력이 완전히 같아야 한다.
test("PG GRANT 줄 순서와 무관하게 결정론적으로 병합·정렬된다", () => {
  const desiredBoth = compileAll(parseDeclaration(`
roles:
  - name: analyst
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select, insert]
`));
  const actual1 = {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: [
      "GRANT SELECT ON TABLE public.orders TO analyst;",
      "GRANT INSERT ON TABLE public.orders TO analyst;",
    ],
  };
  const actual2 = {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: [
      "GRANT INSERT ON TABLE public.orders TO analyst;",
      "GRANT SELECT ON TABLE public.orders TO analyst;",
    ],
  };
  const r1 = diffState(desiredBoth, actual1);
  const r2 = diffState(desiredBoth, actual2);
  expect(r1).toEqual(r2);
  // 병합 후에는 선언(SELECT, INSERT)과 완전히 같은 집합이므로 드리프트가 없어야 한다.
  expect(r1.items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

// C1 핵심 재현 — 같은 (table,role)에 대해 실제 상태가 권한 하나당 한 줄씩(PG
// information_schema.role_table_grants의 자연스러운 산출 형태) 여러 줄로 나뉘어
// 와도, 합치면 선언과 논리적으로 같은 권한 집합이라면 드리프트를 보고하지 않아야 한다.
test("같은 (table,role)의 GRANT 줄이 여러 개면 권한을 합집합으로 병합한다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO analyst;"],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

// C2 핵심 재현 — 인식 못 한 실제 GRANT 문장(스키마/시퀀스 대상 등)은 조용히 사라지지
// 않고 반드시 보고돼야 한다. 승인되지 않은 권한이 여기 숨어 있을 수 있기 때문이다.
test("인식 못 한 실제 GRANT 문장은 조용히 사라지지 않고 보고된다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: [
      "GRANT SELECT, INSERT ON TABLE public.orders TO analyst;",
      "GRANT ALL ON SCHEMA public TO ghost;",
      "GRANT USAGE ON SEQUENCE public.s TO ghost;",
    ],
  });
  expect(items).not.toEqual([]);
  const unparsed = items.filter((i) => i.target === "pg.grant/unparsed");
  expect(unparsed).toHaveLength(2);
  expect(unparsed.map((i) => i.kind)).toEqual(["manual", "manual"]);
  expect(unparsed.some((i) => i.detail.includes("GRANT ALL ON SCHEMA public TO ghost;"))).toBe(true);
  expect(unparsed.some((i) => i.detail.includes("GRANT USAGE ON SEQUENCE public.s TO ghost;"))).toBe(true);
});

// C2 — TABLE 키워드 생략형은 SQL 표준상 유효한 테이블 권한 문장이라 정상 파싱돼야
// 한다(단순 미해석 처리로 밀어내면 안 된다).
test("TABLE 키워드가 생략된 GRANT 문장도 테이블 권한으로 인식한다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON public.orders TO analyst;"],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
  expect(items.some((i) => i.target === "pg.grant/unparsed")).toBe(false);
});

// C2 — WITH GRANT OPTION은 권한 상승 그 자체라 가장 놓쳐서는 안 되는 신호다. 조용히
// 사라지지 않고, 선언에는 없는 권한이므로 drift로 드러나야 한다.
test("WITH GRANT OPTION이 붙은 실제 권한은 조용히 사라지지 않고 drift로 드러난다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO analyst WITH GRANT OPTION;"],
  });
  expect(items).toContainEqual({
    kind: "mismatch",
    target: "pg.grant/public.orders/analyst",
    detail: "권한 집합이 다르다 — 선언: [SELECT], 실제: [GRANT OPTION, SELECT]",
  });
});

// I1 — 순서·공백·대소문자에 강건해야 한다. 정규화된 집합끼리 비교하면 아래는 전부
// "드리프트 없음"이어야 한다.
test("PG 권한 비교는 순서·공백·대소문자에 무관하다", () => {
  const variants = [
    "GRANT INSERT, SELECT ON TABLE public.orders TO analyst;", // 순서 뒤집힘
    "GRANT  SELECT,   INSERT ON TABLE public.orders TO analyst;", // 여분 공백
    "grant select, insert on table public.orders to analyst;", // 소문자
    "GRANT SELECT, INSERT ON TABLE public.orders TO analyst", // 세미콜론 없음
  ];
  for (const line of variants) {
    const desiredBoth = compileAll(parseDeclaration(`
roles:
  - name: analyst
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select, insert]
`));
    const { items } = diffState(desiredBoth, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [line] });
    expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
  }
});

// I1 — 따옴표로 감싼 식별자도 같은 물리 대상으로 정규화돼야 한다(어댑터가
// pg_dump 계열 직렬화로 식별자를 따옴표로 감싸 반환하는 경우).
test("따옴표로 감싼 식별자는 따옴표 없는 선언과 같은 대상으로 취급된다", () => {
  const { items } = diffState(desiredPg, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: [`GRANT SELECT ON TABLE "public"."orders" TO "analyst";`],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

// M1 — 계약 고정: 실제(actual) 상태는 PG 네이티브(접힌) 롤 이름을 보고해야 한다.
// 선언 측 롤 이름(Team-A)과 실제 측 폴드된 이름(team_a)이 같은 물리 롤을 가리키면
// 드리프트가 없어야 한다. toPgRole은 drift.ts가 아니라 pgddl.ts(선언 컴파일 시점)에서
// 이미 적용돼 있고, PG 카탈로그도 접힌 이름을 돌려주므로 drift.ts는 재정규화하지 않는다.
test("선언 롤 이름과 실제(PG 폴드된) 롤 이름이 대소문자만 다르면 드리프트가 없다", () => {
  const desiredFoldCase = compileAll(parseDeclaration(`
roles:
  - name: Team-A
groups: []
resources:
  - resource: public.orders
    engine: postgres
    classification: internal
    grants:
      - roles: [Team-A]
        privileges: [select]
`));
  const { items } = diffState(desiredFoldCase, {
    keycloakRoles: [],
    keycloakGroups: {},
    pgGrants: ["GRANT SELECT ON TABLE public.orders TO team_a;"],
  });
  expect(items.filter((i) => i.target.startsWith("pg.grant/"))).toEqual([]);
});

// I2 — diffState는 "읽지 못했다"를 표현할 수 있어야 한다. checked가 실제로 대조된
// 카테고리를 담아, 호출자가 "드리프트 0"과 "이 카테고리는 미조회"를 구분할 수 있다.
test("checked는 실제로 대조한 카테고리만 담는다", () => {
  const r1 = diffState(desiredPg, { keycloakRoles: [] });
  expect(r1.checked).toEqual(["keycloakRoles"]);

  const r2 = diffState(desiredPg, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(r2.checked).toEqual(["keycloakRoles", "keycloakGroups", "pgGrants"]);

  const r3 = diffState(desiredPg, {});
  expect(r3.checked).toEqual([]);
  expect(r3.items).toEqual([]);
});
