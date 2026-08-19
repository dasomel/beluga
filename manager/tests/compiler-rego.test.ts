import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { compileRego } from "../src/compiler/rego.js";
import type { Declaration } from "../src/schema.js";
import { parseDeclaration } from "../src/schema.js";

const decl = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
groups: []
resources:
  - resource: lake.events_enriched
    classification: internal
    grants:
      - roles: [analysts]
        privileges: [select]
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [engineers]
        privileges: [select, insert]
        allowUnmasked: true
      - roles: [analysts]
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
// analysts를 그대로 포함한다. allowUnmasked: true인 engineer가 analyst 그랜트의
// columnMask/rowFilter에 걸리지 않도록, 그 리소스의 unmasked 보유자를 가드로 제외해야 한다.
test("allowUnmasked 보유자는 같은 리소스의 다른 그랜트가 만드는 마스킹·행 필터에서 제외된다", () => {
  const rego = compileRego(decl);
  const rowFilterBlock = rego.split("rowFilters contains")[1] ?? "";
  const columnMaskBlock = rego.split("columnMask :=")[1] ?? "";
  expect(rowFilterBlock).toContain('every ug in groups { not ug in {"engineers"} }');
  expect(columnMaskBlock).toContain('every ug in groups { not ug in {"engineers"} }');
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

// 수정 라운드 2: 주석에 삽입되는 선언 값(resource, 롤 이름, 컬럼 이름)에 개행이 섞이면
// 주석이 조기 종료되고 다음 줄이 실행 가능한 Rego 코드가 된다. 검증을 우회해 compileRego를
// 직접 호출하는 경로가 실제 위협이므로, 검증 없이 malicious한 Declaration을 넣어 확인한다.
//
// 개행이 안전하게 흡수됐다면, 값 안의 개행을 공백으로 바꿔치기한 "안전한" 버전과 물리적
// 줄 수가 같아야 한다 — 원본 개행이 새 물리 줄을 만들어냈다면 줄 수가 하나 더 많다.
// (JSON.stringify로 이스케이프된 코드 줄 안에도 마커 텍스트가 부분 문자열로 나타날 수
// 있으므로, 단순히 "마커를 포함한 줄은 전부 주석이어야 한다"는 식의 검사는 오탐을 낸다.)
function lineCount(rego: string): number {
  return rego.split("\n").length;
}

test("주석에 삽입되는 리소스 이름의 개행을 제거해 후행 텍스트가 새 물리 줄로 새어나가지 않는다", () => {
  const makeDecl = (resource: string): Declaration => ({
    roles: [{ name: "r" }],
    groups: [],
    resources: [{ resource, classification: "internal", grants: [{ roles: ["r"], privileges: ["select"] }] }],
  });
  const evil = compileRego(makeDecl("lake.evil\nallow := true"));
  const safe = compileRego(makeDecl("lake.evil allow := true")); // 개행 대신 공백 — 기대되는 줄 수 기준선
  expect(lineCount(evil)).toBe(lineCount(safe));
  expect(evil).toContain("# lake.evil allow := true — select (r)");
});

test("주석에 삽입되는 컬럼 이름의 개행을 제거해 후행 텍스트가 새 물리 줄로 새어나가지 않는다", () => {
  const makeDecl = (col: string): Declaration => ({
    roles: [{ name: "r" }],
    groups: [],
    resources: [
      {
        resource: "lake.t",
        classification: "internal",
        grants: [{ roles: ["r"], privileges: ["select"], columnMask: { [col]: "hash" } }],
      },
    ],
  });
  const evil = compileRego(makeDecl("email\nallow := true"));
  const safe = compileRego(makeDecl("email allow := true"));
  expect(lineCount(evil)).toBe(lineCount(safe));
  expect(evil).toContain("# lake.t.email allow := true — 마스킹(hash)");
});

// 롤 이름 자체는 이번 라운드의 범위 밖이다 — 주석 인터폴레이션은 아래에서 확인하듯 안전해졌지만,
// 같은 롤 이름이 `g in {"..."}}` 코드 줄에도(JSON.stringify 없이) 그대로 들어간다. 이는 라운드 1이
// schema/table/column으로 범위를 한정했던 것과 같은 종류의 결함이 롤 이름에도 남아 있다는
// 뜻이며, 별도로 보고한다(아래 report 참고). 여기서는 "주석 자체는 한 줄을 유지한다"만 검증한다.
test("주석에 삽입되는 롤 이름의 개행도 주석 자체는 한 줄로 유지한다 (코드 줄의 별도 결함은 보고서 참고)", () => {
  const evil: Declaration = {
    roles: [{ name: "r\nallow := true" }],
    groups: [],
    resources: [
      {
        resource: "lake.t",
        classification: "internal",
        grants: [{ roles: ["r\nallow := true"], privileges: ["select"] }],
      },
    ],
  };
  const rego = compileRego(evil);
  const commentLine = rego.split("\n").find((l) => l.startsWith("# lake.t — select"));
  expect(commentLine).toBe("# lake.t — select (r allow := true)");
});

// 수정 라운드 3: 롤 이름도 schema/table/column과 같은 이유로 Rego 문자열로 이스케이프해야
// 한다 — `g in {"..."}}` 집합 리터럴에 그대로 들어가므로, 따옴표를 포함한 롤 이름은
// 코드를 탈출할 수 있었다(라운드 2 보고서의 "부수 발견"에서 opa check로 실제 확인됨).
// 검증을 우회해 compileRego를 직접 호출하는 경로가 실제 위협이므로 그 경로로 확인한다.
test("롤 이름을 Rego 문자열로 이스케이프한다 (컴파일러 직접 호출 방어)", () => {
  const evil: Declaration = {
    roles: [{ name: 'r" }' }],
    groups: [],
    resources: [
      {
        resource: "lake.t",
        classification: "internal",
        grants: [{ roles: ['r" }'], privileges: ["select"] }],
      },
    ],
  };
  const rego = compileRego(evil);
  expect(rego).toContain(`g in {${JSON.stringify('r" }')}}`);
  expect(rego).not.toMatch(/g in \{"r" \}\}/);
});

// 수정 라운드 4: allowUnmasked 그랜트 자신이 선언한 columnMask/rowFilter는 그 그랜트의
// 롤을 "상속한" 보유자에게도 적용돼야 한다. Keycloak 토큰은 상속을 이미 확장하므로
// beluga-lead(engineers를 상속)의 토큰은 engineers를 그대로 포함하고,
// 이 컴파일러는 리소스 수준에서 holdersOf로 확장한 unmaskedGroups에도 beluga-lead를
// 포함시킨다 — 그런데 가드에서 이를 제외할 때 literal grant.roles만 봤기 때문에
// beluga-lead가 자기 자신이 상속한 그랜트의 마스킹에서도 빠져나가는 버그가 있었다.
test("allowUnmasked 그랜트 자신의 columnMask는 그 그랜트 롤을 상속한 보유자에게도 적용된다", () => {
  const d = parseDeclaration(`
roles:
  - name: engineers
  - name: beluga-lead
    includes: [engineers]
groups: []
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [engineers]
        privileges: [select]
        allowUnmasked: true
        columnMask:
          email: hash
`);
  const rego = compileRego(d);
  // 이 리소스에는 allowUnmasked 그랜트가 이것 하나뿐이므로, 자기 자신의 columnMask에는
  // 어떤 가드도 붙으면 안 된다 — beluga-lead를 포함해 engineers를 (상속으로도)
  // 가진 모든 보유자에게 무조건 적용돼야 한다.
  const columnMaskBlock = rego.split("columnMask :=")[1] ?? "";
  expect(columnMaskBlock).not.toContain("every ug in groups");
});

test("allowUnmasked 보유자는 상속된 경우에도 '다른' 그랜트의 마스킹에서는 여전히 제외된다 (opt-out 유지)", () => {
  const d = parseDeclaration(`
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
  - name: beluga-lead
    includes: [engineers]
groups: []
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
    grants:
      - roles: [engineers]
        privileges: [select]
        allowUnmasked: true
      - roles: [analysts]
        privileges: [select]
        columnMask:
          email: hash
`);
  const rego = compileRego(d);
  // analysts 그랜트(allowUnmasked 아님)의 columnMask는 engineers와
  // beluga-lead(상속으로 얻은 unmasked 보유자) 둘 다 제외해야 한다.
  const columnMaskBlock = rego.split("columnMask :=")[1] ?? "";
  expect(columnMaskBlock).toContain('every ug in groups { not ug in {"beluga-lead", "engineers"} }');
});

// 수정 라운드 5 — 재검토가 발견한 candidate D/E: 서로 다른 두 opted-out 그랜트를 모두
// 상속하는 롤은, 라운드 4의 (literal roles 대신 holdersOf로 확장한) 제외 "집합"은
// 맞게 계산되더라도, 가드 자체가 "토큰에 이 문자열이 하나라도 있으면 무조건 거부"라서
// multi의 토큰에 들어있는 g2(자신과 무관한 다른 그랜트의 opt-out 마커)가 g1 자신의
// 마스킹까지 걸러버렸다. 재구성: allowUnmasked 그랜트는 자신의 마스킹/필터에 가드를
// 아예 달지 않는다(제외 집합 연산 자체가 없다) — 그래서 selfHolders를 지운다.
function multiInheritDecl(colOrFilterA: "colMask" | "rowFilter", colOrFilterB: "colMask" | "rowFilter") {
  const grantFieldA =
    colOrFilterA === "colMask" ? "columnMask:\n          ssn: hash" : "rowFilter: \"region = 'KR'\"";
  const grantFieldB =
    colOrFilterB === "colMask" ? "columnMask:\n          email: partial" : "rowFilter: \"region = 'US'\"";
  return parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
groups: []
resources:
  - resource: lake.t
    classification: pii
    sensitiveColumns: [ssn, email]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        ${grantFieldA}
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        ${grantFieldB}
`);
}

test("candidate D: 서로 다른 두 opted-out 그랜트를 상속한 롤은 두 그랜트의 자기 마스킹을 모두 받는다", () => {
  const d = multiInheritDecl("colMask", "colMask");
  const rego = compileRego(d);
  const blocks = rego.split("columnMask :=").slice(1);
  expect(blocks).toHaveLength(2);
  // g1의 ssn 마스킹, g2의 email 마스킹 둘 다 어떤 가드도 없어야 한다 — multi의 토큰에
  // g2/g1이 각각 들어있다는 사실이 상대방 그랜트 자신의 마스킹을 막으면 안 된다.
  for (const block of blocks) {
    expect(block).not.toContain("every ug in groups");
  }
});

test("candidate E: rowFilter도 candidate D와 동일하게 두 그랜트의 자기 필터를 모두 받는다", () => {
  const d = multiInheritDecl("rowFilter", "rowFilter");
  const rego = compileRego(d);
  const blocks = rego.split("rowFilters contains").slice(1);
  expect(blocks).toHaveLength(2);
  for (const block of blocks) {
    expect(block).not.toContain("every ug in groups");
  }
});

test("candidate D2: 상속 관계없는 세 번째 일반 그랜트의 마스킹은 opt-out 보유자(g1·g2·multi) 전부를 여전히 제외한다", () => {
  const d = parseDeclaration(`
roles:
  - name: g1
  - name: g2
  - name: multi
    includes: [g1, g2]
  - name: other
groups: []
resources:
  - resource: lake.t
    classification: pii
    sensitiveColumns: [ssn, email, note]
    grants:
      - roles: [g1]
        privileges: [select]
        allowUnmasked: true
        columnMask:
          ssn: hash
      - roles: [g2]
        privileges: [select]
        allowUnmasked: true
        columnMask:
          email: partial
      - roles: [other]
        privileges: [select]
        columnMask:
          note: hash
`);
  const rego = compileRego(d);
  const otherBlock = rego.split("columnMask :=").slice(1).find((b) => b.includes('columnName == "note"'));
  expect(otherBlock).toContain('every ug in groups { not ug in {"g1", "g2", "multi"} }');
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

// Task 12: 테이블과 무관한 카탈로그·쿼리 레벨 오퍼레이션. default allow := false 위에서
// ExecuteQuery 같은 오퍼레이션에도 allow 규칙이 없으면 테이블 규칙이 맞아도 쿼리 자체가
// 시작되지 않는다.
test("카탈로그 레벨 오퍼레이션(ExecuteQuery 등)에 allow 규칙을 만든다", () => {
  const catalogDecl = parseDeclaration(
    readFileSync(new URL("./fixtures/catalog-grants.yaml", import.meta.url), "utf8"),
  );
  const rego = compileRego(catalogDecl);
  expect(rego).toMatch(/input\.action\.operation == "ExecuteQuery"/);
  expect(rego).toMatch(/input\.action\.operation == "ShowSchemas"/);
  expect(rego).toContain('g in {"admins", "analysts", "engineers"}');
});

test("catalogGrants가 없으면 카탈로그 레벨 규칙을 만들지 않는다 (기존 선언과 하위호환)", () => {
  // 수정 라운드 1(Task 12 리뷰 M-1): ExecuteQuery 하나만 보면 AccessCatalog나 ShowSchemas가
  // 누출돼도 잡지 못한다. 세 오퍼레이션 이름 전부를 확인한다.
  expect(compileRego(decl)).not.toMatch(/ExecuteQuery|AccessCatalog|ShowSchemas/);
});
