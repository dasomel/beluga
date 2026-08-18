import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { compileRego } from "../src/compiler/rego.js";
import type { Declaration } from "../src/schema.js";
import { parseDeclaration } from "../src/schema.js";

const decl = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups: []
resources:
  - resource: lake.events_enriched
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [beluga-engineer]
        privileges: [select, insert]
        allowUnmasked: true
      - roles: [beluga-analyst]
        privileges: [select]
        columnMask:
          email: hash
        rowFilter: "region = 'KR'"
`);

test("골든 출력과 일치한다", () => {
  const expected = readFileSync(new URL("./golden/trino.rego", import.meta.url), "utf8");
  expect(compileRego(decl)).toBe(expected);
});

test("결정론적이다 — 두 번 호출해도 같다", () => {
  expect(compileRego(decl)).toBe(compileRego(decl));
});

test("deny 규칙을 만들지 않는다 (allow-by-role)", () => {
  expect(compileRego(decl)).not.toMatch(/^\s*deny\b/m);
});

test("실제 Trino OPA 입력 경로(identity.groups)를 읽는다", () => {
  const rego = compileRego(decl);
  expect(rego).toContain('"context", "identity", "groups"');
  expect(rego).not.toContain("extraCredentials");
});

// 수정 라운드 1 — 이슈 1: Keycloak은 상속을 토큰 발급 시 이미 확장하므로 engineer의 토큰은
// beluga-analyst를 그대로 포함한다. allowUnmasked: true인 engineer가 analyst 그랜트의
// columnMask/rowFilter에 걸리지 않도록, 그 리소스의 unmasked 보유자를 가드로 제외해야 한다.
test("allowUnmasked 보유자는 같은 리소스의 다른 그랜트가 만드는 마스킹·행 필터에서 제외된다", () => {
  const rego = compileRego(decl);
  const rowFilterBlock = rego.split("rowFilters contains")[1] ?? "";
  const columnMaskBlock = rego.split("columnMask :=")[1] ?? "";
  expect(rowFilterBlock).toContain('every ug in groups { not ug in {"beluga-engineer"} }');
  expect(columnMaskBlock).toContain('every ug in groups { not ug in {"beluga-engineer"} }');
});

// 수정 라운드 1 — 이슈 2: 검증기가 식별자를 걸러내지만, 컴파일러 자체도 방어해야 한다
// (직접 호출 시 검증을 우회할 수 있음). schema/table/column은 Rego 문자열 리터럴로
// 이스케이프되어야 위와 같은 페이로드가 코드로 탈출하지 못한다.
test("스키마·테이블·컬럼 이름을 Rego 문자열로 이스케이프한다 (컴파일러 직접 호출 방어)", () => {
  const evil: Declaration = {
    roles: [{ name: "r" }],
    groups: [],
    resources: [
      {
        resource: 'lake.tbl" }\n\tallow',
        classification: "internal",
        grants: [{ roles: ["r"], privileges: ["select"] }],
      },
    ],
  };
  const rego = compileRego(evil);
  expect(rego).toContain(`input.action.resource.table.tableName == ${JSON.stringify('tbl" }\n\tallow')}`);
  expect(rego).not.toMatch(/tableName == "tbl" \}/);
});

test("localeCompare 대신 순수 비교를 사용해 로케일에 독립적으로 정렬한다", () => {
  // ICU 로케일에 따라 대소문자/특수문자 순서가 달라지는 문자열로 정렬 안정성을 확인한다.
  // localeCompare였다면 로케일별로 "Z_a" vs "z_A" 순서가 뒤집힐 수 있었다.
  const d = parseDeclaration(`
roles:
  - name: r
groups: []
resources:
  - resource: z.Z_a
    classification: internal
    grants:
      - roles: [r]
        privileges: [select]
  - resource: a.z_A
    classification: internal
    grants:
      - roles: [r]
        privileges: [select]
`);
  const idxA = compileRego(d).indexOf("a.z_A");
  const idxZ = compileRego(d).indexOf("z.Z_a");
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxZ).toBeGreaterThan(idxA);
});
