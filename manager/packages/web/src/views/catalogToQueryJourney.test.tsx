// Critical journey: Catalog -> Table -> Query (issue #30).
//
// The web test suite renders with `react-dom/server#renderToStaticMarkup` in a Node
// environment (see docs/development.md) -- there is no jsdom/testing-library, so the "Open in
// Query" button's onClick cannot be fired the way a browser interaction test would. Instead of
// re-deriving the expected SQL/table independently (which would miss a regression in the real
// handler or wiring), this test drives the two production functions that make up the handoff:
//
//   1. `handleOpenInQuerySelection` (packages/web/src/views/DataCatalogView.tsx) is the exact
//      function the "Open in Query" button's onClick calls. We call it directly with a real
//      onSelectQuery spy and assert what it was called with -- this fails if the handler's
//      payload construction regresses, or if it stops calling the callback.
//   2. `mapCatalogQueryTargetToWorkspaceProps` (packages/web/src/App.tsx) is the exact function
//      App.tsx uses to turn the asset id state set by `navigateToCatalogQuery` into
//      `QueryWorkspaceView` props. We feed the spy's captured payload straight into it and render
//      the result, proving the SQL and table identity survive the full production wiring chain
//      (DataCatalogView's click handler -> App's state mapping -> QueryWorkspaceView props) with
//      no network access.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAsset, DataAssetDetail } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { DataCatalogView, handleOpenInQuerySelection } from './DataCatalogView';
import { QueryWorkspaceView } from './QueryWorkspaceView';
import { mapCatalogQueryTargetToWorkspaceProps } from '../App';

const mocks = vi.hoisted(() => ({
  dataAssets: [] as DataAsset[],
  tableDetail: null as DataAssetDetail | null,
  requestedQueryContextId: undefined as string | null | undefined,
}));

vi.mock('../api/hooks', () => ({
  useDataAssets: (kind?: string) => {
    const items = kind ? mocks.dataAssets.filter((asset) => asset.kind === kind) : mocks.dataAssets;
    return {
      data: { data: items, meta: { total: items.length, page: 1, pageSize: 100 } },
      isLoading: false,
      isError: false,
    };
  },
  useDataAsset: (id: string | null | undefined) => ({
    data: id ? mocks.tableDetail : undefined,
    isLoading: false,
    isError: false,
  }),
  useQueryContext: (id: string | null | undefined) => {
    mocks.requestedQueryContextId = id;
    return {
      data: {
        assetId: id,
        catalog: 'beluga_lake',
        schema: 'analytics',
        table: 'orders',
        trinoServiceId: 'svc-trino',
        trinoUiUrl: 'https://trino.local.beluga.internal',
        sampleSql: 'SELECT * FROM "beluga_lake"."analytics"."orders" LIMIT 20',
        readOnly: true,
        rowLimit: 20,
      },
      isLoading: false,
      isError: false,
    };
  },
  useQueryHistory: () => ({
    data: { data: [], meta: { total: 0, page: 1, pageSize: 20 }, warnings: [] },
    isLoading: false,
    isError: false,
  }),
}));

const tEn = getTranslations('en-US');

// Schema-shaped fixture (not a verbatim copy of packages/domain-api/src/stub-data/dataAssets.ts's
// "asset-table-orders" -- deep-importing stub-data would cross the domain-api package's public
// surface, which only exports "./schema"). Trimmed to 3 columns instead of the stub's 7 since the
// column count is irrelevant to this handoff.
const ordersAsset: DataAsset = {
  id: 'asset-table-orders',
  name: 'analytics.orders',
  kind: 'table',
  serviceId: 'svc-iceberg',
  status: 'healthy',
};

const ordersDetail: DataAssetDetail = {
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
    { name: 'order_id', type: 'BIGINT', nullable: false, comment: 'Order primary key' },
    { name: 'order_date', type: 'DATE', nullable: false, comment: 'Order date partition key' },
    { name: 'created_at', type: 'TIMESTAMP(6) WITH TIME ZONE', nullable: false, comment: 'Record creation timestamp' },
  ],
};

describe('Critical journey: Catalog -> Table -> Query', () => {
  beforeEach(() => {
    mocks.dataAssets = [ordersAsset];
    mocks.tableDetail = { ...ordersDetail };
  });

  it('step 1: DataCatalogView renders the selected table with an Open-in-Query affordance', () => {
    const html = renderToStaticMarkup(
      <DataCatalogView theme="light" t={tEn} locale="en-US" onSelectQuery={vi.fn()} initialAssetId="asset-table-orders" />,
    );
    expect(html).toContain('analytics.orders');
    expect(html).toContain(tEn.catalog.openInQuery);
  });

  it('does not render the Open-in-Query affordance when the caller has not wired a handler', () => {
    const html = renderToStaticMarkup(
      <DataCatalogView theme="light" t={tEn} locale="en-US" initialAssetId="asset-table-orders" />,
    );
    expect(html).not.toContain(tEn.catalog.openInQuery);
  });

  it('step 2: the button\'s real click handler calls onSelectQuery with the table asset id', () => {
    const onSelectQuery = vi.fn();

    // This is the exact function packages/web/src/views/DataCatalogView.tsx's onClick invokes.
    handleOpenInQuerySelection(ordersDetail, onSelectQuery);

    expect(onSelectQuery).toHaveBeenCalledExactlyOnceWith('asset-table-orders');
  });

  it('step 3: App\'s real state-to-props mapping forwards that id into the Query Workspace, which requests its context', () => {
    const onSelectQuery = vi.fn();
    handleOpenInQuerySelection(ordersDetail, onSelectQuery);
    const [assetId] = onSelectQuery.mock.calls[0]!;

    // This is the exact function packages/web/src/App.tsx uses to wire the 'query' tab.
    const props = mapCatalogQueryTargetToWorkspaceProps(assetId);
    expect(props).toEqual({ initialAssetId: 'asset-table-orders' });

    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} locale="en-US" {...props} />);

    expect(mocks.requestedQueryContextId).toBe('asset-table-orders');
    expect(html).toContain('beluga_lake.analytics.orders');
    expect(html).toContain(tEn.query.openInTrino);
  });

  it('a null query target (no catalog selection yet) maps to undefined props', () => {
    expect(mapCatalogQueryTargetToWorkspaceProps(null)).toEqual({ initialAssetId: undefined });
  });
});
