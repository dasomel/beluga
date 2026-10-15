import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { getTranslations } from '../i18n/getTranslations';
import { DataTable } from './DataTable';

interface TestRow {
  id: string;
  name: string;
  status: string;
}

const columns: ColumnDef<TestRow, any>[] = [
  {
    accessorKey: 'id',
    header: 'ID',
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: 'name',
    header: 'Name',
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (info) => info.getValue(),
  },
];

const testData: TestRow[] = [
  { id: '1', name: 'Alpha', status: 'healthy' },
  { id: '2', name: 'Beta', status: 'degraded' },
];

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

describe('DataTable component', () => {
  it('renders data grid with headers, cells, and row count', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={testData}
        columns={columns}
        t={tEn}
        locale="en-US"
        ariaLabel="Test Data Grid"
      />,
    );

    // Headers
    expect(html).toContain('ID');
    expect(html).toContain('Name');
    expect(html).toContain('Status');

    // Data rows
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('healthy');
    expect(html).toContain('degraded');

    // Row count
    expect(html).toContain('2 row(s)');

    // Sticky header & role semantics
    expect(html).toContain('sticky top-0');
    expect(html).toContain('role="table"');
    expect(html).toContain('aria-label="Test Data Grid"');
  });

  it('renders empty state when data array is empty', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={[]}
        ariaLabel="Test grid"
        columns={columns}
        t={tEn}
        emptyMessage="Custom empty notice"
      />,
    );

    expect(html).toContain('Custom empty notice');
    expect(html).toContain('0 row(s)');
  });

  it('renders loading state when isLoading is true', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={[]}
        ariaLabel="Test grid"
        columns={columns}
        t={tEn}
        isLoading={true}
      />,
    );

    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when error is provided', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={[]}
        ariaLabel="Test grid"
        columns={columns}
        t={tEn}
        error={new Error('Data grid connection failed')}
      />,
    );

    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Data grid connection failed');
  });

  it('renders pagination controls when pagination prop is passed', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={testData}
        columns={columns}
        t={tEn}
        ariaLabel="Test grid"
        pagination={{
          page: 1,
          pageSize: 2,
          total: 10,
        }}
      />,
    );

    expect(html).toContain('Page 1 of 5');
    expect(html).toContain(`aria-label="${tEn.table.previousPage}"`);
    expect(html).toContain(`aria-label="${tEn.table.nextPage}"`);
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(
      <DataTable
        data={testData}
        columns={columns}
        t={tKo}
        locale="ko-KR"
        ariaLabel="Test grid"
        pagination={{
          page: 1,
          pageSize: 2,
          total: 10,
        }}
      />,
    );

    expect(html).toContain('2개 행');
    expect(html).toContain('5페이지 중 1페이지');
    expect(html).toContain(tKo.table.columnsVisibility);
    expect(html).toContain(`aria-label="${tKo.table.previousPage}"`);
    expect(html).toContain(`aria-label="${tKo.table.nextPage}"`);
  });

  it('has exactly one region and no menu role; column toggle is a disclosure button', () => {
    const html = renderToStaticMarkup(
      <DataTable data={testData} columns={columns} t={tEn} ariaLabel="Test grid" />,
    );
    expect(html.match(/role="region"/g)).toHaveLength(1);
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('aria-haspopup');
    expect(html).toContain('aria-expanded="false"');
  });

  it('sort buttons carry distinct accessible names that include the column (en-US and ko-KR)', () => {
    const en = renderToStaticMarkup(
      <DataTable data={testData} columns={columns} t={tEn} ariaLabel="g" />,
    );
    expect(en).toContain('aria-label="Sort by ID, currently not sorted"');
    expect(en).toContain('aria-label="Sort by Name, currently not sorted"');
    expect(en).toContain('aria-label="Sort by Status, currently not sorted"');
    const ko = renderToStaticMarkup(
      <DataTable data={testData} columns={columns} t={tKo} locale="ko-KR" ariaLabel="g" />,
    );
    expect(ko).toContain('aria-label="Name 기준 정렬, 현재 정렬 안 됨"');
  });

  const rows: TestRow[] = [
    { id: '1', name: 'B', status: 's' },
    { id: '2', name: 'a', status: 's' },
    { id: '3', name: null as unknown as string, status: 's' },
    { id: '4', name: 'x', status: 's' },
  ];
  const order = (html: string) => [...html.matchAll(/<td[^>]*>(\d)<\/td>/g)].map((m) => m[1]);

  it('sorts ascending with nulls last and reflects it in aria-sort and the button name', () => {
    const html = renderToStaticMarkup(
      <DataTable data={rows} columns={columns} t={tEn} ariaLabel="g" initialSorting={[{ id: 'name', desc: false }]} />,
    );
    expect(order(html)).toEqual(['2', '1', '4', '3']);
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('aria-label="Sort by Name, currently ascending"');
  });

  it('sorts descending with nulls still last', () => {
    const html = renderToStaticMarkup(
      <DataTable data={rows} columns={columns} t={tEn} ariaLabel="g" initialSorting={[{ id: 'name', desc: true }]} />,
    );
    expect(order(html)).toEqual(['4', '1', '2', '3']);
    expect(html).toContain('aria-sort="descending"');
  });
});

