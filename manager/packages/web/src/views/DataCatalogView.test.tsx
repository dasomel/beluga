import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAsset, DataAssetDetail } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { CatalogTreeNode, DataCatalogView, toCatalogTable } from './DataCatalogView';

const mocks = vi.hoisted(() => ({
  dataAssets: [] as DataAsset[],
  dataAssetsLoading: false,
  dataAssetsError: false,
  dataAssetsErrorObj: null as unknown,
  rootsError: false,
  tableDetail: null as DataAssetDetail | null,
  tableDetailLoading: false,
  tableDetailError: false,
  tableDetailErrorObj: null as unknown,
  children: {} as Record<string, DataAsset[]>,
  childrenLoading: false,
  childrenError: false,
  childrenRequests: [] as Array<[string, boolean]>,
}));

vi.mock('../api/hooks', () => ({
  useDataAssets: (kind?: string) => {
    const failed = mocks.dataAssetsError || (kind === 'catalog' && mocks.rootsError);
    const items = kind ? mocks.dataAssets.filter((asset) => asset.kind === kind) : mocks.dataAssets;
    return {
      data: failed ? undefined : { data: items, meta: { total: items.length, page: 1, pageSize: 100 } },
      isLoading: mocks.dataAssetsLoading,
      isError: failed,
      error: mocks.dataAssetsErrorObj ?? (failed ? new Error('roots boom') : null),
    };
  },
  useDataAssetChildren: (parentId: string, enabled: boolean) => {
    mocks.childrenRequests.push([parentId, enabled]);
    return {
      data: enabled && !mocks.childrenError ? { data: mocks.children[parentId] ?? [], meta: { total: 0, page: 1, pageSize: 100 } } : undefined,
      isLoading: enabled && mocks.childrenLoading,
      isError: enabled && mocks.childrenError,
      error: mocks.childrenError ? new Error('children boom') : null,
    };
  },
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
    mocks.rootsError = false;
    mocks.tableDetail = { ...testTableDetail };
    mocks.tableDetailLoading = false;
    mocks.tableDetailError = false;
    mocks.tableDetailErrorObj = null;
    mocks.children = {};
    mocks.childrenLoading = false;
    mocks.childrenError = false;
    mocks.childrenRequests = [];
  });

  it('renders loading state when data assets are loading', () => {
    mocks.dataAssetsLoading = true;
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when data assets fail to load', () => {
    mocks.dataAssetsError = true;
    mocks.dataAssetsErrorObj = new Error('Network error');
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Network error');
  });

  it('renders table navigator filtering only table assets (ignoring topics)', () => {
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
    expect(html).toContain('analytics.orders');
    expect(html).toContain('analytics.orders_enriched');
    expect(html).not.toContain('events.raw');
  });

  it('renders table detail panel with location, format, metadata summary, and columns', () => {
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
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

  it('SQL editor in the detail panel is named, follows the theme and has a copy-failure label', () => {
    const dark = renderToStaticMarkup(<DataCatalogView theme="dark" t={tEn} locale="en-US" />);
    expect(dark).toContain('data-theme="dark"');
    expect(dark).toContain(`aria-label="${tEn.catalog.editorAriaLabel}"`);
    expect(renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />)).toContain('data-theme="light"');
    // copyFailedLabel is a required SqlEditor prop; both locales must define the message.
    expect(tEn.catalog.copyFailed).not.toBe('');
    expect(tKo.catalog.copyFailed).not.toBe('');
    expect(tKo.catalog.editorAriaLabel).not.toBe(tEn.catalog.editorAriaLabel);
  });

  it('renders detail loading state when detail is loading', () => {
    mocks.tableDetailLoading = true;
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders detail error state when detail query fails', () => {
    mocks.tableDetailError = true;
    mocks.tableDetailErrorObj = new Error('Table detail 404');
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Table detail 404');
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tKo} locale="ko-KR" />);
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

  describe('lazy catalog tree', () => {
    const catalog: DataAsset = { id: 'asset-catalog-beluga_lake', name: 'beluga_lake', kind: 'catalog', serviceId: 'svc-iceberg', status: 'healthy' };
    const schema: DataAsset = { id: 'asset-schema-analytics', name: 'analytics', kind: 'schema', serviceId: 'svc-iceberg', status: 'healthy' };
    const render = (expanded: string[] = [], t = tEn) =>
      renderToStaticMarkup(
        <CatalogTreeNode asset={catalog} t={t} activeAssetId={null} onSelect={() => {}} defaultExpanded={new Set(expanded)} />,
      );

    it('renders catalog roots instead of the flat list and does not fetch children until expanded', () => {
      mocks.dataAssets = [catalog, ...testTableAssets];
      const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
      expect(html).toContain('beluga_lake');
      expect(html).toContain(`${tEn.catalog.treeExpand} beluga_lake`);
      expect(html).toContain('aria-expanded="false"');
      expect(mocks.childrenRequests.every(([, enabled]) => !enabled)).toBe(true);
    });

    it('renders orphan tables (no parentId) next to catalogs and hides nested/non-table assets', () => {
      const orphan: DataAsset = { ...testTableAssets[0]!, parentId: null };
      const nested: DataAsset = { ...testTableAssets[1]!, parentId: schema.id };
      mocks.dataAssets = [catalog, orphan, nested, testTableAssets[2]!];
      const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
      expect(html).toContain(`${tEn.catalog.treeExpand} beluga_lake`);
      expect(html).toContain('analytics.orders');
      expect(html).not.toContain('analytics.orders_enriched');
      expect(html).not.toContain('events.raw');
    });

    it('does not auto-select a table hidden inside a collapsed catalog', () => {
      const nested: DataAsset = { ...testTableAssets[0]!, parentId: schema.id };
      mocks.dataAssets = [catalog, nested];
      const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
      expect(html).toContain(tEn.catalog.emptyState);
      expect(html).not.toContain(tEn.catalog.queryTemplate);
    });

    it('still honours initialAssetId in tree mode', () => {
      mocks.dataAssets = [catalog];
      const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" initialAssetId="asset-table-orders" />);
      expect(html).toContain(tEn.catalog.queryTemplate);
    });

    it('renders an error state when the catalog root list fails', () => {
      mocks.rootsError = true;
      const html = renderToStaticMarkup(<DataCatalogView theme="light" t={tEn} locale="en-US" />);
      expect(html).toContain(tEn.common.loadError);
      expect(html).toContain('roots boom');
    });

    it('shows loading, error, and empty states for an expanded node', () => {
      mocks.childrenLoading = true;
      expect(render([catalog.id])).toContain(tEn.common.loading);
      mocks.childrenLoading = false;
      mocks.childrenError = true;
      const errHtml = render([catalog.id]);
      expect(errHtml).toContain(tEn.common.loadError);
      expect(errHtml).toContain('children boom');
      mocks.childrenError = false;
      expect(render([catalog.id], tKo)).toContain(tKo.catalog.treeEmpty);
    });

    it('renders fetched namespace children and nested table leaves without childCount', () => {
      mocks.children = { [catalog.id]: [schema], [schema.id]: [testTableAssets[0]!] };
      const collapsed = render();
      expect(collapsed).not.toContain('analytics');
      const html = render([catalog.id, schema.id]);
      expect(html).toContain(`${tEn.catalog.treeCollapse} beluga_lake`);
      expect(html).toContain('analytics');
      expect(html).toContain('analytics.orders');
      expect(html).not.toContain(tEn.catalog.treeEmpty);
      expect(mocks.childrenRequests).toContainEqual([schema.id, true]);
    });
  });
});
