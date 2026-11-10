// 내장 system 카탈로그의 테이블 브라우징 요청은 schema/table 모양으로만 들어온다.
// runtime은 실행 중인 쿼리·노드를 노출하므로 metadata와 jdbc만 열어야 한다.
const SYSTEM_METADATA_SCHEMA_GUARD_PATH: Record<"schema" | "table", string> = {
  schema: "input.action.resource.schema.schemaName",
  table: "input.action.resource.table.schemaName",
};

const catalogPath = (shape: "catalog" | "schema" | "table") =>
  `input.action.resource.${shape}.${shape === "catalog" ? "name" : "catalogName"}`;

export function compileSystemMetadata(effective: string[], effectiveComment: string): string[] {
  const lines: string[] = [];
  const systemCatalogOperations: Array<[string, "catalog" | "schema"]> = [
    ["AccessCatalog", "catalog"],
    ["FilterCatalogs", "catalog"],
    ["ShowSchemas", "catalog"],
    ["FilterSchemas", "schema"],
  ];
  for (const [op, shape] of systemCatalogOperations) {
    lines.push(
      `# Trino 내장 system 카탈로그 — ${op} (${effectiveComment}, Superset 메타데이터 검증용)`,
      "allow if {",
      `\tinput.action.operation == ${JSON.stringify(op)}`,
      `\t${catalogPath(shape)} == "system"`,
      `\tsome g in groups`,
      `\tg in {${effective.map((r) => JSON.stringify(r)).join(", ")}}`,
      "}",
      "",
    );
  }

  const systemMetadataOperations: Array<[string, "schema" | "table"]> = [
    ["ShowTables", "schema"],
    ["FilterTables", "table"],
    ["ShowColumns", "table"],
    ["FilterColumns", "table"],
    ["SelectFromColumns", "table"],
  ];
  for (const [op, shape] of systemMetadataOperations) {
    lines.push(
      `# Trino 내장 system 메타데이터 — ${op} (${effectiveComment}, metadata/jdbc만; runtime 제외)`,
      "allow if {",
      `\tinput.action.operation == ${JSON.stringify(op)}`,
      `\t${catalogPath(shape)} == "system"`,
      `\t${SYSTEM_METADATA_SCHEMA_GUARD_PATH[shape]} in {"jdbc", "metadata"}`,
      `\tsome g in groups`,
      `\tg in {${effective.map((r) => JSON.stringify(r)).join(", ")}}`,
      "}",
      "",
    );
  }
  return lines;
}
