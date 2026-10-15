import type { CatalogTable } from '../data/mockData';

// Trino reserved keywords: https://trino.io/docs/current/language/reserved.html
// `user` is included as a defensive identifier guard alongside the documented reserved list.
const TRINO_RESERVED_WORDS = new Set([
  'alter', 'and', 'as', 'auto', 'between', 'by', 'case', 'cast', 'constraint', 'create',
  'cross', 'cube', 'current_catalog', 'current_date', 'current_path', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'deallocate',
  'delete', 'describe', 'distinct', 'drop', 'else', 'end', 'escape', 'except', 'exists',
  'extract', 'false', 'for', 'from', 'full', 'group', 'grouping', 'having', 'in', 'inner',
  'insert', 'intersect', 'into', 'is', 'join', 'json_array', 'json_exists', 'json_object',
  'json_query', 'json_table', 'json_value', 'left', 'like', 'listagg', 'localtime',
  'localtimestamp', 'natural', 'normalize', 'not', 'null', 'on', 'or', 'order', 'outer',
  'overlaps', 'prepare', 'recursive', 'right', 'rollup', 'select', 'skip', 'table', 'then',
  'trim', 'true', 'uescape', 'union', 'unnest', 'using', 'user', 'values', 'when', 'where',
  'with',
]);

function quoteIdentifier(identifier: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(identifier) && !TRINO_RESERVED_WORDS.has(identifier)
    ? identifier
    : `"${identifier.replaceAll('"', '""')}"`;
}

export function getCatalogTableName(table: Pick<CatalogTable, 'catalog' | 'schema' | 'table'>): string {
  return [table.catalog, table.schema, table.table].map(quoteIdentifier).join('.');
}

export function buildCatalogSampleSql(table: CatalogTable): string {
  const columns = table.columns.slice(0, 10).map(({ name }) => `  ${quoteIdentifier(name)}`);
  const timestampColumn = table.columns.find(({ name, type }) =>
    /timestamp|time/i.test(type) || /(?:_at|_time|timestamp)$/i.test(name),
  );
  const orderBy = timestampColumn ? `\nORDER BY ${quoteIdentifier(timestampColumn.name)} DESC` : '';

  return `SELECT\n${columns.join(',\n')}\nFROM ${getCatalogTableName(table)}${orderBy}\nLIMIT 20;`;
}
