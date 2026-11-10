import { cmp } from "../compare.js";
import type { Declaration, SchemaOperation } from "../schema.js";
import { holdersOf } from "../validate.js";

// Trino 483 OpaAccessControl.java: CreateSchema/ShowTables/FilterSchemas use schema;
// all other operations here use table (FilterColumns includes table.columns).
const SHAPE: Record<SchemaOperation, "schema" | "table"> = {
  CreateSchema: "schema", ShowTables: "schema", FilterSchemas: "schema",
  CreateTable: "table", DropTable: "table", RenameTable: "table", SetTableProperties: "table",
  InsertIntoTable: "table", DeleteFromTable: "table", SelectFromColumns: "table",
  CreateView: "table", DropView: "table", CreateViewWithSelectFromColumns: "table",
  ShowColumns: "table", ShowCreateTable: "table", FilterTables: "table", FilterColumns: "table",
};

function set(values: string[]): string {
  return `{${[...new Set(values)].sort(cmp).map((v) => JSON.stringify(v)).join(", ")}}`;
}

/** Additive only: declarations without schemaGrants retain byte-identical Rego. */
export function compileSchemaGrants(d: Declaration): string {
  const lines: string[] = [];
  const effective = (roles: string[]) => [...new Set(roles.flatMap((r) => holdersOf(d, r)))].sort(cmp);
  const emit = (operations: string[], roles: string[], guards: string[]) => {
    if (roles.length === 0) return;
    lines.push(
      "# schemaGrants — scoped operations and discovery",
      "allow if {",
      `\tinput.action.operation in ${set(operations)}`,
      ...guards.map((g) => `\t${g}`),
      "\tsome g in groups",
      `\tg in ${set(roles)}`,
      "}",
      "",
    );
  };
  const resourceGuards = (catalog: string, shape: "schema" | "table", schemas: string[]) => [
    `input.action.resource.${shape}.catalogName == ${JSON.stringify(catalog)}`,
    `input.action.resource.${shape}.schemaName in ${set(schemas)}`,
  ];

  const grants = [...(d.schemaGrants ?? [])].sort((a, b) =>
    cmp(JSON.stringify([a.catalog, [...a.schemas].sort(cmp), [...a.roles].sort(cmp), [...a.operations].sort(cmp)]),
      JSON.stringify([b.catalog, [...b.schemas].sort(cmp), [...b.roles].sort(cmp), [...b.operations].sort(cmp)])));
  for (const grant of grants) {
    const roles = effective(grant.roles);
    for (const operation of [...grant.operations].sort(cmp)) {
      const guards = resourceGuards(grant.catalog, SHAPE[operation], grant.schemas);
      // D2 (#95): a rename authorizes both ends in this grant's set, including catalog.
      // Cost: sets cannot be joined implicitly; escape hatch: explicitly regroup schemas.
      if (operation === "RenameTable") {
        guards.push(
          `input.action.targetResource.table.catalogName == ${JSON.stringify(grant.catalog)}`,
          `input.action.targetResource.table.schemaName in ${set(grant.schemas)}`,
        );
      }
      emit([operation], roles, guards);
    }

    // D3 (#95): query/catalog gates do not grant table access. information_schema SELECT
    // needs FilterSchemas/Tables/Columns below to restrict returned metadata. Cost: these
    // gates accompany each schema grant; escape hatch: separate discovery declarations.
    emit(["ExecuteQuery"], roles, []);
    emit(["AccessCatalog", "FilterCatalogs", "ShowSchemas"], roles, [
      `input.action.resource.catalog.name == ${JSON.stringify(grant.catalog)}`,
    ]);
    emit(["FilterSchemas", "ShowTables"], roles,
      resourceGuards(grant.catalog, "schema", ["information_schema"]));
    emit(["SelectFromColumns", "FilterTables", "FilterColumns", "ShowColumns", "ShowCreateTable"], roles,
      resourceGuards(grant.catalog, "table", ["information_schema"]));

    // SELECT sources outside the output schemas need exact-table discovery too.
    // CreateViewWithSelectFromColumns checks the SOURCE, never the new view target;
    // expose it only to schema-grant view builders who independently hold source SELECT.
    for (const resource of [...d.resources].sort((a, b) => cmp(a.resource, b.resource))) {
      if ((resource.engine ?? "trino") !== "trino") continue;
      const readers = effective(resource.grants.filter((g) => g.privileges.includes("select")).flatMap((g) => g.roles));
      const sourceRoles = roles.filter((r) => readers.includes(r));
      const [schema, table] = resource.resource.split(".") as [string, string];
      emit(["FilterSchemas", "ShowTables"], sourceRoles, resourceGuards(grant.catalog, "schema", [schema]));
      const operations = ["FilterTables", "FilterColumns", "ShowColumns", "ShowCreateTable"];
      if (grant.operations.includes("CreateViewWithSelectFromColumns")) operations.push("CreateViewWithSelectFromColumns");
      emit(operations, sourceRoles, [
        ...resourceGuards(grant.catalog, "table", [schema]),
        `input.action.resource.table.tableName == ${JSON.stringify(table)}`,
      ]);
    }
  }
  return lines.join("\n");
}
