import type { Declaration, MaskKind } from "../schema.js";
import { expandRoles } from "../validate.js";

const MASK_EXPR: Record<MaskKind, (col: string) => string> = {
  hash: (col) => `to_hex(sha256(cast(${col} as varbinary)))`,
  partial: (col) => `concat(substr(${col}, 1, 2), '***')`,
  null: () => `null`,
};

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
  const resources = [...d.resources].sort((a, b) => a.resource.localeCompare(b.resource));

  for (const res of resources) {
    const { schema, table } = splitResource(res.resource);
    for (const grant of [...res.grants].sort((a, b) => a.roles.join().localeCompare(b.roles.join()))) {
      const effective = [...new Set(grant.roles.flatMap((r) => holdersOf(d, r)))].sort();
      for (const priv of [...grant.privileges].sort()) {
        lines.push(
          `# ${res.resource} — ${priv} (${effective.join(", ")})`,
          "allow if {",
          `\tinput.action.operation == "${operationOf(priv)}"`,
          `\tinput.action.resource.table.schemaName == "${schema}"`,
          `\tinput.action.resource.table.tableName == "${table}"`,
          `\tsome g in groups`,
          `\tg in {${effective.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }

      if (grant.rowFilter) {
        lines.push(
          `# ${res.resource} — 행 필터`,
          "rowFilters contains {\"expression\": " + JSON.stringify(grant.rowFilter) + "} if {",
          `\tinput.action.resource.table.schemaName == "${schema}"`,
          `\tinput.action.resource.table.tableName == "${table}"`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }

      for (const [col, kind] of Object.entries(grant.columnMask ?? {}).sort()) {
        lines.push(
          `# ${res.resource}.${col} — 마스킹(${kind})`,
          "columnMask := {\"expression\": " + JSON.stringify(MASK_EXPR[kind](col)) + "} if {",
          `\tinput.action.resource.column.schemaName == "${schema}"`,
          `\tinput.action.resource.column.tableName == "${table}"`,
          `\tinput.action.resource.column.columnName == "${col}"`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }
    }
  }

  return lines.join("\n");
}

/** 이 롤을 실효적으로 갖는 롤들(자신 + 자신을 상속한 상위 롤) */
function holdersOf(d: Declaration, role: string): string[] {
  return d.roles.filter((r) => expandRoles(d, r.name).includes(role)).map((r) => r.name);
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
