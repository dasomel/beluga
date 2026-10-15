import { describe, expect, it } from 'vitest';
import { catalogTablesData } from '../data/mockData';
import { buildCatalogSampleSql, getCatalogTableName } from './catalogSql';

const table = { catalog: 'beluga_lake', schema: 'default', table: 'orders' };

describe('catalog SQL identifiers', () => {
  it('leaves plain lowercase names unquoted', () => {
    expect(getCatalogTableName(table)).toBe('beluga_lake.default.orders');
  });

  it('quotes dotted, quoted, and uppercase names as individual identifiers', () => {
    expect(getCatalogTableName({ catalog: 'Lake.One', schema: 'O"Brien', table: 'Orders' }))
      .toBe('"Lake.One"."O""Brien"."Orders"');
  });

  it.each(['order', 'table', 'user', 'select', 'from', 'where', 'group', 'by'])
    ('quotes Trino reserved word %s', (identifier) => {
      expect(getCatalogTableName({ ...table, table: identifier })).toBe(`beluga_lake.default."${identifier}"`);
    });

  it('quotes snapshot table names containing a dollar sign', () => {
    expect(getCatalogTableName({ ...table, table: 'orders$snapshots' }))
      .toBe('beluga_lake.default."orders$snapshots"');
  });

  it('uses the quoted table name in the sample query', () => {
    expect(buildCatalogSampleSql({ ...catalogTablesData[0]!, table: 'orders$snapshots' }))
      .toContain('FROM beluga_lake.default."orders$snapshots"');
  });

  it.each(catalogTablesData.map((catalogTable) => [catalogTable.table, catalogTable] as const))
    ('builds a SELECT list from the catalog columns for %s', (_name, catalogTable) => {
      const sql = buildCatalogSampleSql(catalogTable);
      const selectList = sql.split('FROM ')[0]!.split('\n').slice(1).filter(Boolean);

      expect(selectList).toEqual(catalogTable.columns.map(({ name }) => `  ${name}`).map((column, index, columns) =>
        index === columns.length - 1 ? column : `${column},`));
      expect(sql).toContain(`FROM ${getCatalogTableName(catalogTable)}`);
    });

  it('limits sample queries to ten columns and orders only when a temporal column exists', () => {
    const noTemporalColumn = {
      ...catalogTablesData[1]!,
      columns: catalogTablesData[1]!.columns.map((column) => ({ ...column, type: 'VARCHAR' })),
    };
    const sql = buildCatalogSampleSql(noTemporalColumn);

    expect(sql).not.toContain('ORDER BY');
    expect(buildCatalogSampleSql(catalogTablesData[0]!)).toContain('ORDER BY created_at DESC');
    const limitedSql = buildCatalogSampleSql({
      ...catalogTablesData[0]!,
      columns: Array.from({ length: 12 }, (_, index) => ({ name: `column_${index}`, type: 'VARCHAR' })),
    });
    expect(limitedSql.split('FROM ')[0]!.split('\n').filter((line) => line.startsWith('  column_')))
      .toHaveLength(10);
  });

  it('escapes embedded double quotes in column identifiers', () => {
    const withQuotedColumn = {
      ...catalogTablesData[0]!,
      columns: [{ name: 'odd"column', type: 'VARCHAR' }],
    };

    expect(buildCatalogSampleSql(withQuotedColumn)).toContain('  "odd""column"');
  });
});
