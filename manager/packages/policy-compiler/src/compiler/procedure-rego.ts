import { cmp } from "../compare.js";
import type { Declaration } from "../schema.js";
import { holdersOf } from "../validate.js";

const set = (values: string[]) => `{${[...new Set(values)].sort(cmp).map((v) => JSON.stringify(v)).join(", ")}}`;

export function compileProcedureGrants(d: Declaration): string {
  const lines: string[] = [];
  const grants = [...(d.procedureGrants ?? [])].sort((a, b) => cmp(
    JSON.stringify([a.catalog, [...a.tables].sort(cmp), [...a.procedures].sort(cmp), [...a.roles].sort(cmp)]),
    JSON.stringify([b.catalog, [...b.tables].sort(cmp), [...b.procedures].sort(cmp), [...b.roles].sort(cmp)]),
  ));
  for (const grant of grants) {
    const roles = [...new Set(grant.roles.flatMap((r) => holdersOf(d, r)))];
    const emit = (operation: string, guards: string[]) => lines.push(
      "# procedureGrants — exact table/procedure and optimize zero-column scan",
      "allow if {",
      `\t${operation}`,
      ...guards.map((guard) => `\t${guard}`),
      "\tsome g in groups",
      `\tg in ${set(roles)}`,
      "}", "",
    );
    // D-MAINT-2: query/catalog gates only; no adapter metadata SELECT is needed.
    // Cost: additional operations must be observed live; escape hatch: reviewed grants.
    emit('input.action.operation == "ExecuteQuery"', []);
    emit('input.action.operation in {"AccessCatalog", "FilterCatalogs"}', [
      `input.action.resource.catalog.name == ${JSON.stringify(grant.catalog)}`,
    ]);
    // D-MAINT-5: live Trino 483 uses functionName with uppercase procedure names.
    // Normalize case; missing functionName stays denied. Cost: live-shape fixtures;
    // escape hatch: review new captured inputs if the upstream contract changes.
    for (const table of [...grant.tables].sort(cmp)) {
      const [schemaName, tableName] = table.split(".");
      // D-MAINT-6: live optimize scans project no columns. Cost: listed-table row
      // counts (including PII customers); escape hatch: drop optimize or use non-Trino maintenance.
      if (grant.procedures.includes("optimize")) {
        emit('input.action.operation == "SelectFromColumns"', [
          `input.action.resource.table.catalogName == ${JSON.stringify(grant.catalog)}`,
          `input.action.resource.table.schemaName == ${JSON.stringify(schemaName)}`,
          `input.action.resource.table.tableName == ${JSON.stringify(tableName)}`,
          "is_array(input.action.resource.table.columns)",
          "count(input.action.resource.table.columns) == 0",
        ]);
      }
      emit('input.action.operation == "ExecuteTableProcedure"', [
        `input.action.resource.table.catalogName == ${JSON.stringify(grant.catalog)}`,
        `input.action.resource.table.schemaName == ${JSON.stringify(schemaName)}`,
        `input.action.resource.table.tableName == ${JSON.stringify(tableName)}`,
        `lower(input.action.resource.function.functionName) in ${set(grant.procedures)}`,
      ]);
    }
  }
  return lines.join("\n");
}
