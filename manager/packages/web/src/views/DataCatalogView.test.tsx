import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAsset, DataAssetDetail } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { DataCatalogView, toCatalogTable } from './DataCatalogView';

const mocks = vi.hoisted(() => ({
  dataAssets: [] as DataAsset[],
  dataAssetsLoading: false,
  dataAssetsError: false,
  dataAssetsErrorObj: null as unknown,
  tableDetail: null as DataAssetDetail | null,
  tableDetailLoading: false,
  tableDetailError: false,
  tableDetailErrorObj: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  useDataAssets: () => ({
    data: mocks.dataAssetsError
      ? undefined
      : {
          data: mocks.dataAssets,
          meta: { total: mocks.dataAssets.length, page: 1, pageSize: 100 },
        },
    isLoading: mocks.dataAssetsLoading,
    isError: mocks.dataAssetsError,
    error: mocks.dataAssetsErrorObj,
  }),
  useDataAsset: (id: string | null | undefined) => ({
    data: mocks.tableDetailError || !id ? undefined : mocks.tableDetail,
    isLoading: mocks.tableDetailLoading,
    isError: mocks.tableDetailError,
    error: mocks.tableDetailErrorObj,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testTableAssets: DataAsset[] = [
  {
    id: 'asset-table-orders',
    name: 'analytics.orders',
    kind: 'table',
    serviceId: 'svc-iceberg',
    status: 'healthy',
  },
  {
    id: 'asset-table-orders-enriched',
    name: 'analytics.orders_enriched',
    kind: 'table',
    serviceId: 'svc-iceberg',
    status: 'stale',
  },
  {
    id: 'asset-topic-events',
    name: 'events.raw',
    kind: 'topic',
    serviceId: 'svc-kafka',
    status: 'healthy',
  },
];

const testTableDetail: DataAssetDetail = {
  id: 'asset-table-orders',
  name: 'analytics.orders',
  kind: 'table',
  serviceId: 'svc-iceberg',
  status: 'healthy',
  format: 'Iceberg v2 (Parquet)',
  location: 's3://beluga-lake/warehouse/analytics/orders',
  metadataSummary: {
    snapshotCount: 84,
    lastUpdated: '2026-09-28T09:30:00.000Z',
    partitionSpec: 'order_date',
  },
  columns: [
    { name: 'order_id', type: 'BIGINT', nullable: false, comment: 'Primary key' },
    { name: 'order_date', type: 'DATE', nullable: false, comment: 'Partition key' },
    { name: 'note', type: 'VARCHAR', nullable: true, comment: 'Optional note' },
  ],
};

describe('DataCatalogView', () => {
  beforeEach(() => {
    mocks.dataAssets = [...testTableAssets];
    mocks.dataAssetsLoading = false;
    mocks.dataAssetsError = false;
    mocks.dataAssetsErrorObj = null;
    mocks.tableDetail = { ...testTableDetail };
    mocks.tableDetailLoading = false;
    mocks.tableDetailError = false;
    mocks.tableDetailErrorObj = null;
  });

  it('renders loading state when data assets are loading', () => {
    mocks.dataAssetsLoading = true;
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when data assets fail to load', () => {
    mocks.dataAssetsError = true;
    mocks.dataAssetsErrorObj = new Error('Network error');
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Network error');
  });

  it('renders table navigator filtering only table assets (ignoring topics)', () => {
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    expect(html).toContain('analytics.orders');
    expect(html).toContain('analytics.orders_enriched');
    expect(html).not.toContain('events.raw');
  });

  it('renders table detail panel with location, format, metadata summary, and columns', () => {
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    // Table name and format
    expect(html).toContain('analytics.orders');
    expect(html).toContain('Iceberg v2 (Parquet)');
    expect(html).toContain('s3://beluga-lake/warehouse/analytics/orders');

    // Metadata summary
    expect(html).toContain('84');
    expect(html).toContain('order_date');

    // Column table headers
    expect(html).toContain(tEn.catalog.columnName);
    expect(html).toContain(tEn.catalog.dataType);
    expect(html).toContain(tEn.catalog.nullable);
    expect(html).toContain(tEn.catalog.partition);
    expect(html).toContain(tEn.catalog.description);

    // Columns
    expect(html).toContain('order_id');
    expect(html).toContain('BIGINT');
    expect(html).toContain('Primary key');
    expect(html).toContain('note');
    expect(html).toContain('VARCHAR');

    // Sample query template
    expect(html).toContain(tEn.catalog.queryTemplate);
    expect(html).toContain('SELECT');
    expect(html).toContain('FROM beluga_lake.analytics.orders');

    // Columns count
    expect(html).toContain('3 col(s)');
  });

  it('renders detail loading state when detail is loading', () => {
    mocks.tableDetailLoading = true;
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders detail error state when detail query fails', () => {
    mocks.tableDetailError = true;
    mocks.tableDetailErrorObj = new Error('Table detail 404');
    const html = renderToStaticMarkup(<DataCatalogView t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Table detail 404');
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<DataCatalogView t={tKo} locale="ko-KR" />);
    expect(html).toContain('데이터 카탈로그');
    expect(html).toContain(tKo.catalog.lakekeeperCatalog);
    expect(html).toContain(tKo.catalog.snapshots);
    expect(html).toContain(tKo.catalog.partitionSpec);
    expect(html).toContain(tKo.catalog.lastUpdated);
    expect(html).toContain(tKo.catalog.columns);
    expect(html).toContain('3개 컬럼');
    expect(html).toContain(tKo.catalog.queryTemplate);
  });

  it('toCatalogTable correctly parses catalog, schema, table, and partition info', () => {
    const table = toCatalogTable(testTableDetail);
    expect(table.catalog).toBe('beluga_lake');
    expect(table.schema).toBe('analytics');
    expect(table.table).toBe('orders');
    expect(table.format).toBe('Iceberg v2 (Parquet)');
    expect(table.location).toBe('s3://beluga-lake/warehouse/analytics/orders');
    expect(table.snapshotCount).toBe(84);
    expect(table.columns).toHaveLength(3);
    expect(table.columns[0]).toEqual({
      name: 'order_id',
      type: 'BIGINT',
      comment: 'Primary key',
      isPartition: false,
    });
    expect(table.columns[1]).toEqual({
      name: 'order_date',
      type: 'DATE',
      comment: 'Partition key',
      isPartition: true,
    });
  });
});
