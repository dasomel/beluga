import { cmp } from "../compare.js";
import type { Declaration, MaskKind } from "../schema.js";
import { holdersOf } from "../validate.js";

const MASK_EXPR: Record<MaskKind, (col: string) => string> = {
  hash: (col) => `to_hex(sha256(cast(${col} as varbinary)))`,
  partial: (col) => `concat(substr(${col}, 1, 2), '***')`,
  null: () => `null`,
};

// 수정 라운드 2: 주석은 코드처럼 이스케이프되지 않는다 — 값에 개행이 섞이면 주석이
// 조기 종료되고 다음 줄이 실행 가능한 Rego 코드가 된다(검증을 우회해 compileRego를
// 직접 호출하는 경로에서 실제 위협). 선언에서 온 값이 주석에 들어가는 모든 지점에서 적용한다.
function sanitizeComment(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/** 리소스 문자열 "schema.table" → { schema, table } */
function splitResource(resource: string): { schema: string; table: string } {
  const idx = resource.lastIndexOf(".");
  if (idx < 0) throw new Error(`리소스는 'schema.table' 형식이어야 한다: ${resource}`);
  return { schema: resource.slice(0, idx), table: resource.slice(idx + 1) };
}

/**
 * 선언 → Trino OPA용 Rego.
 * allow-by-role만 생성한다(§5.3-3). 어떤 롤에도 허용되지 않으면 기본 거부다.
 */
export function compileRego(d: Declaration): string {
  const lines: string[] = [
    "# 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml",
    "package trino",
    "",
    "import rego.v1",
    "",
    "default allow := false",
    "",
    "# 요청자의 그룹 (Trino OPA 입력의 실제 경로 — 라이브 실측: identity 키는 groups/user 뿐)",
    "groups := object.get(input, [\"context\", \"identity\", \"groups\"], [])",
    "",
  ];

  // 리소스·롤을 이름순으로 돌아 결정론적 출력을 만든다
  const resources = [...d.resources].sort((a, b) => cmp(a.resource, b.resource));

  for (const res of resources) {
    const { schema, table } = splitResource(res.resource);
    const resourceComment = sanitizeComment(res.resource);

    // 수정 라운드 1 — 이슈 1: 이 리소스에서 allowUnmasked: true를 가진 그랜트의 실효 보유자
    // (상속 확장 포함). Keycloak은 토큰 발급 시 상속을 이미 확장하므로 engineer의 토큰은
    // beluga-analyst를 그대로 포함한다 — allow와 같은 holdersOf 확장을 써야 한다.
    // 이 집합에 속한 요청자는 이 리소스의 다른 그랜트가 만드는 컬럼 마스킹·행 필터에서 제외된다.
    const unmaskedGroups = [
      ...new Set(
        res.grants
          .filter((g) => g.allowUnmasked === true)
          .flatMap((g) => g.roles.flatMap((r) => holdersOf(d, r))),
      ),
    ].sort(cmp);

    for (const grant of [...res.grants].sort((a, b) => cmp(a.roles.join(), b.roles.join()))) {
      const effective = [...new Set(grant.roles.flatMap((r) => holdersOf(d, r)))].sort(cmp);

      // 수정 라운드 5: 라운드 4는 가드 "집합"에서 자신의 holdersOf를 뺐지만, 가드 자체는
      // 여전히 "토큰에 이 문자열이 하나라도 있으면 거부"라서 서로 다른 두 opted-out
      // 그랜트를 모두 상속한 롤(예: g1·g2 둘 다 상속하는 multi)은 g1 자신의 마스킹을
      // 렌더링할 때도 자기 토큰에 들어있는 g2(g1과 무관한 다른 그랜트의 opt-out 마커)
      // 때문에 걸러졌다 — "이 토큰 멤버가 이 규칙을 막는가"와 "이 토큰 멤버는 이 규칙과
      // 무관한 다른 롤일 뿐인가"를 가드가 구분하지 못했기 때문이다.
      //
      // 그랜트 단위로 다시 정의한다: allowUnmasked 그랜트는 자신의 마스킹/필터에 가드를
      // 아예 달지 않는다 — 직접이든 상속이든 이 그랜트를 보유한 사람은 항상 이 마스킹을
      // 받는다(role-membership 검사 `g in {grant.roles}` 자체가 Keycloak의 컴포지트
      // 토큰 확장 덕분에 상속까지 이미 커버한다). allowUnmasked가 아닌 그랜트(= 다른
      // 그랜트의 마스킹)만 unmaskedGroups 전체로 가드를 건다 — 제외 집합 연산이 아예
      // 없으므로 이 리소스의 다른 opted-out 그랜트가 토큰에 남긴 흔적과 뒤섞일 여지가
      // 없다.
      const unmaskedGuard =
        grant.allowUnmasked !== true && unmaskedGroups.length > 0
          ? `\tevery ug in groups { not ug in {${unmaskedGroups.map((r) => JSON.stringify(r)).join(", ")}} }`
          : null;

      for (const priv of [...grant.privileges].sort(cmp)) {
        lines.push(
          `# ${resourceComment} — ${priv} (${effective.map(sanitizeComment).join(", ")})`,
          "allow if {",
          `\tinput.action.operation == "${operationOf(priv)}"`,
          `\tinput.action.resource.table.schemaName == ${JSON.stringify(schema)}`,
          `\tinput.action.resource.table.tableName == ${JSON.stringify(table)}`,
          `\tsome g in groups`,
          `\tg in {${effective.map((r) => JSON.stringify(r)).join(", ")}}`,
          "}",
          "",
        );
      }

      if (grant.rowFilter) {
        const body = [
          `\tinput.action.resource.table.schemaName == ${JSON.stringify(schema)}`,
          `\tinput.action.resource.table.tableName == ${JSON.stringify(table)}`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => JSON.stringify(r)).join(", ")}}`,
          ...(unmaskedGuard ? [unmaskedGuard] : []),
        ];
        lines.push(
          `# ${resourceComment} — 행 필터`,
          "rowFilters contains {\"expression\": " + JSON.stringify(grant.rowFilter) + "} if {",
          ...body,
          "}",
          "",
        );
      }

      for (const [col, kind] of Object.entries(grant.columnMask ?? {}).sort()) {
        const body = [
          `\tinput.action.resource.column.schemaName == ${JSON.stringify(schema)}`,
          `\tinput.action.resource.column.tableName == ${JSON.stringify(table)}`,
          `\tinput.action.resource.column.columnName == ${JSON.stringify(col)}`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => JSON.stringify(r)).join(", ")}}`,
          ...(unmaskedGuard ? [unmaskedGuard] : []),
        ];
        lines.push(
          `# ${resourceComment}.${sanitizeComment(col)} — 마스킹(${kind})`,
          "columnMask := {\"expression\": " + JSON.stringify(MASK_EXPR[kind](col)) + "} if {",
          ...body,
          "}",
          "",
        );
      }
    }
  }

  return lines.join("\n");
}

function operationOf(priv: string): string {
  switch (priv) {
    case "select":
      return "SelectFromColumns";
    case "insert":
      return "InsertIntoTable";
    case "update":
      return "UpdateTableColumns";
    case "delete":
      return "DeleteFromTable";
    default:
      throw new Error(`알 수 없는 privilege: ${priv}`);
  }
}
