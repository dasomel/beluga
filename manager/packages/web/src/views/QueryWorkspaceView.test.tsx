import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAsset, QueryContext, QueryHistoryEntry } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { QueryWorkspaceView, copyToClipboard } from './QueryWorkspaceView';

const mocks = vi.hoisted(() => ({
  assets: [] as DataAsset[],
  assetsLoading: false,
  assetsError: false,
  context: undefined as QueryContext | undefined,
  contexts: {} as Record<string, QueryContext>,
  contextLoading: false,
  contextError: false,
  requestedId: undefined as string | null | undefined,
  historyEntries: [] as QueryHistoryEntry[],
  historyLoading: false,
  historyError: false,
  historyErrorObj: null as unknown,
  historyTotal: 0,
}));

vi.mock('../api/hooks', () => ({
  useDataAssets: () => ({
    data: mocks.assetsError ? undefined : { data: mocks.assets, meta: { total: mocks.assets.length, page: 1, pageSize: 100 } },
    isLoading: mocks.assetsLoading,
    isError: mocks.assetsError,
    error: mocks.assetsError ? new Error('assets down') : null,
  }),
  useQueryContext: (id: string | null | undefined) => {
    mocks.requestedId = id;
    return {
      data: mocks.contextError ? undefined : ((id && mocks.contexts[id]) || mocks.context),
      isLoading: mocks.contextLoading,
      isError: mocks.contextError,
      error: mocks.contextError ? new Error('context 404') : null,
    };
  },
  useQueryHistory: (page: number, pageSize: number) => ({
    data: mocks.historyError ? undefined : {
      data: mocks.historyEntries,
      meta: { total: mocks.historyTotal, page, pageSize },
      warnings: [],
    },
    isLoading: mocks.historyLoading,
    isError: mocks.historyError,
    error: mocks.historyErrorObj ?? (mocks.historyError ? new Error('history failed') : null),
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const asset = (id: string, name: string, kind: DataAsset['kind'] = 'table'): DataAsset => ({
  id,
  name,
  kind,
  serviceId: 'svc-iceberg',
  status: 'healthy',
});

const ordersContext: QueryContext = {
  assetId: 'asset-table-orders',
  catalog: 'beluga_lake',
  schema: 'analytics',
  table: 'orders',
  trinoServiceId: 'svc-trino',
  trinoUiUrl: 'https://trino.local.beluga.internal',
  sampleSql: 'SELECT * FROM "beluga_lake"."analytics"."orders" LIMIT 20',
  readOnly: true,
  rowLimit: 20,
};

describe('QueryWorkspaceView', () => {
  beforeEach(() => {
    mocks.assets = [asset('asset-topic-x', 'orders.events', 'topic'), asset('asset-table-orders', 'analytics.orders')];
    mocks.assetsLoading = false;
    mocks.assetsError = false;
    mocks.context = ordersContext;
    mocks.contexts = {};
    mocks.contextLoading = false;
    mocks.contextError = false;
    mocks.requestedId = undefined;
    mocks.historyEntries = [];
    mocks.historyLoading = false;
    mocks.historyError = false;
    mocks.historyErrorObj = null;
    mocks.historyTotal = 0;
  });

  it('success: shows the Trino target, starter SQL, copy button and Open in Trino link', () => {
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain('beluga_lake.analytics.orders');
    expect(html).toContain('SELECT * FROM &quot;beluga_lake&quot;.&quot;analytics&quot;.&quot;orders&quot; LIMIT 20');
    expect(html).toContain(tEn.query.copySql);
    expect(html).toContain(tEn.query.openInTrino);
    expect(html).toContain('href="https://trino.local.beluga.internal/"');
    expect(html).toContain(tEn.query.readOnlyBadge);
    // Defaults to the first *table* asset (topics are not queryable).
    expect(mocks.requestedId).toBe('asset-table-orders');
    expect(html).not.toContain('asset-topic-x');
  });

  it('does not pretend to execute queries: no Run button or mock results', () => {
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).not.toContain('Run Query');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Query Succeeded');
    expect(html).toContain(tEn.query.readOnlyNote);
  });

  it('requests the handed-off initialAssetId from the catalog', () => {
    mocks.assets = [asset('asset-table-a', 'a.a'), asset('asset-table-b', 'b.b')];
    renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} initialAssetId="asset-table-b" />);
    expect(mocks.requestedId).toBe('asset-table-b');
  });

  it('omits the Open in Trino link when the URL is not a safe http(s) URL', () => {
    mocks.context = { ...ordersContext, trinoUiUrl: 'javascript:alert(1)' };
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).not.toContain(tEn.query.openInTrino);
    expect(html).not.toContain('javascript:');
  });

  it('loading: shows the loading state while the asset list loads', () => {
    mocks.assetsLoading = true;
    mocks.assets = [];
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('loading: shows the loading state while the query context loads', () => {
    mocks.contextLoading = true;
    mocks.context = undefined;
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('error: shows the load error when the asset list fails', () => {
    mocks.assetsError = true;
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('assets down');
  });

  it('error: shows the load error when the query context fails', () => {
    mocks.contextError = true;
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('context 404');
  });

  it('empty: shows the empty state when there are no table assets', () => {
    mocks.assets = [asset('asset-topic-x', 'orders.events', 'topic')];
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(html).toContain(tEn.query.emptyState);
    expect(html).not.toContain(tEn.query.assetLabel);
  });

  it('renders Korean translations', () => {
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tKo} locale="ko-KR" />);
    expect(html).toContain(tKo.query.title);
    expect(html).toContain(tKo.query.openInTrino);
    expect(html).toContain(tKo.query.copySql);
    expect(html).toContain(tKo.query.readOnlyBadge);
    expect(html).toContain(tKo.query.historyTitle);
  });

  it('shows the context of the asset named by initialAssetId (distinct data per id)', () => {
    mocks.assets = [asset('asset-table-orders', 'analytics.orders'), asset('asset-table-users', 'analytics.users')];
    mocks.contexts = { 'asset-table-users': { ...ordersContext, assetId: 'asset-table-users', table: 'users' } };
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} initialAssetId="asset-table-users" />);
    expect(html).toContain('beluga_lake.analytics.users');
    expect(html).toContain('<option value="asset-table-users" selected');
  });

  it('falls back to the first table when initialAssetId is not a listed table asset', () => {
    renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} initialAssetId="asset-topic-x" />);
    expect(mocks.requestedId).toBe('asset-table-orders');
  });

  it('renders query history table with Query ID, SQL, and State columns when history is available', () => {
    mocks.historyEntries = [
      { id: 'query-101', sql: 'SELECT * FROM analytics.orders', state: 'FINISHED' },
      { id: 'query-102', sql: 'SELECT count(*) FROM analytics.users', state: 'FAILED' },
    ];
    mocks.historyTotal = 2;
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);

    expect(html).toContain(tEn.query.historyTitle);
    expect(html).toContain(tEn.query.historyColumns.id);
    expect(html).toContain(tEn.query.historyColumns.sql);
    expect(html).toContain(tEn.query.historyColumns.state);
    expect(html).toContain('query-101');
    expect(html).toContain('SELECT * FROM analytics.orders');
    expect(html).toContain('FINISHED');
    expect(html).toContain('query-102');
    expect(html).toContain('FAILED');
  });

  it('renders graceful notice when query history adapter returns 503 (no adapter wired)', () => {
    mocks.historyError = true;
    mocks.historyErrorObj = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);

    expect(html).toContain(tEn.query.historyTitle);
    expect(html).toContain(tEn.query.historyUnavailable);
    expect(html).not.toContain(tEn.common.loadError);
  });

  it('passes the app theme to the SQL editor', () => {
    expect(renderToStaticMarkup(<QueryWorkspaceView theme="dark" t={tEn} />)).toContain('data-theme="dark"');
    expect(renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />)).toContain('data-theme="light"');
  });

  it('warns that history may show other users\' queries and literals, in en-US and ko-KR', () => {
    mocks.historyEntries = [{ id: 'q1', sql: "SELECT 'secret-literal'", state: 'FINISHED' } as QueryHistoryEntry];
    mocks.historyTotal = 1;
    const en = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);
    expect(en).toContain(tEn.query.historyPrivacyNotice);
    expect(en).toContain('secret-literal'); // shown (masking is not guaranteed by the UI) ...
    expect(en).not.toMatch(/title="[^"]*secret-literal/); // ... but never copied into a title/tooltip
    const ko = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tKo} locale="ko-KR" />);
    expect(ko).toContain(tKo.query.historyPrivacyNotice);
  });

  it('renders empty notice when query history is empty', () => {
    mocks.historyEntries = [];
    mocks.historyTotal = 0;
    const html = renderToStaticMarkup(<QueryWorkspaceView theme="light" t={tEn} />);

    expect(html).toContain(tEn.query.historyTitle);
    expect(html).toContain(tEn.query.historyEmpty);
  });
});

describe('copyToClipboard', () => {
  it('resolves true when writeText succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(copyToClipboard('SELECT 1', { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('SELECT 1');
  });

  it('resolves false when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    await expect(copyToClipboard('SELECT 1', { writeText })).resolves.toBe(false);
  });

  it('resolves false when the Clipboard API is unavailable (insecure origin)', async () => {
    vi.stubGlobal('navigator', {});
    try {
      await expect(copyToClipboard('SELECT 1')).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
