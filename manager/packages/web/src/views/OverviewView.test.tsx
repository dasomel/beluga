import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAsset, Event, Pipeline, Service } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { OverviewView } from './OverviewView';

const mocks = vi.hoisted(() => ({
  services: [] as Service[],
  pipelines: [] as Pipeline[],
  events: [] as Event[],
  eventsLoading: false,
  eventsError: false,
  eventsErrorObj: null as unknown,
  health: { status: 'healthy', version: '1' } as { status: string; version: string },
  dataAssets: [] as DataAsset[],
  dataAssetsLoading: false,
  dataAssetsError: false,
  dataAssetsErrorObj: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  useServices: () => ({ data: { data: mocks.services, warnings: [], meta: { total: mocks.services.length } }, isLoading: false, isError: false }),
  usePipelines: () => ({ data: { data: mocks.pipelines, warnings: [], meta: { total: mocks.pipelines.length } }, isLoading: false, isError: false }),
  useDomainApiHealth: () => ({ data: mocks.health, isLoading: false, isError: false }),
  useEvents: () => ({
    data: mocks.eventsError ? undefined : { data: mocks.events, warnings: [], meta: { total: mocks.events.length } },
    isLoading: mocks.eventsLoading,
    isError: mocks.eventsError,
    error: mocks.eventsErrorObj,
  }),
  // Mirrors the real hook: `meta.total` reflects the *filtered* (by `kind`) count across all
  // pages, not `mocks.dataAssets.length` of the current page, so tests can exercise total counts
  // beyond a single page's worth of items.
  useDataAssetsCount: (kind?: DataAsset['kind']) => ({
    data: mocks.dataAssetsError
      ? undefined
      : {
          data: [],
          warnings: [],
          meta: { total: (kind ? mocks.dataAssets.filter((asset) => asset.kind === kind) : mocks.dataAssets).length },
        },
    isLoading: mocks.dataAssetsLoading,
    isError: mocks.dataAssetsError,
    error: mocks.dataAssetsErrorObj,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testEvents: Event[] = [
  {
    id: 'evt-1',
    timestamp: '2026-09-21T05:00:00.000Z',
    severity: 'error',
    message: 'Health probe timed out',
    relatedServiceId: 'svc-observability',
    relatedPipelineId: null,
    relatedResourceId: null,
  },
  {
    id: 'evt-2',
    timestamp: '2026-09-21T04:55:00.000Z',
    severity: 'warning',
    message: 'Under-replicated partitions detected',
    relatedServiceId: 'svc-kafka',
    relatedPipelineId: null,
    relatedResourceId: null,
  },
  {
    id: 'evt-3',
    timestamp: '2026-09-21T04:50:00.000Z',
    severity: 'warning',
    message: 'Checkpoint status stale',
    relatedServiceId: 'svc-flink',
    relatedPipelineId: null,
    relatedResourceId: null,
  },
  {
    id: 'evt-4',
    timestamp: '2026-09-21T04:45:00.000Z',
    severity: 'info',
    message: 'Service health check completed',
    relatedServiceId: 'svc-trino',
    relatedPipelineId: null,
    relatedResourceId: null,
  },
  {
    id: 'evt-5',
    timestamp: '2026-09-21T04:40:00.000Z',
    severity: 'info',
    message: 'Correlation re-evaluated',
    relatedServiceId: null,
    relatedPipelineId: null,
    relatedResourceId: null,
  },
  {
    id: 'evt-6',
    timestamp: '2026-09-21T04:35:00.000Z',
    severity: 'info',
    message: 'Platform heartbeat',
    relatedServiceId: null,
    relatedPipelineId: null,
    relatedResourceId: null,
  },
];

describe('OverviewView Recent Events card', () => {
  beforeEach(() => {
    mocks.services = [];
    mocks.pipelines = [];
    mocks.events = [...testEvents];
    mocks.eventsLoading = false;
    mocks.eventsError = false;
    mocks.eventsErrorObj = null;
  });

  it('renders Recent Events card with title, action button, and latest 5 events', () => {
    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    expect(html).toContain(tEn.overview.recentEvents);
    expect(html).toContain(tEn.overview.viewAllInOperations);
    // Shows latest 5 events
    expect(html).toContain('Health probe timed out');
    expect(html).toContain('Under-replicated partitions detected');
    expect(html).toContain('Checkpoint status stale');
    expect(html).toContain('Service health check completed');
    expect(html).toContain('Correlation re-evaluated');
    // 6th older event should not appear in the 5 recent events list
    expect(html).not.toContain('Platform heartbeat');
  });

  it('renders localized severity badges and formatted timestamps', () => {
    const htmlEn = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );
    expect(htmlEn).toContain(tEn.severity.error);
    expect(htmlEn).toContain(tEn.severity.warning);
    expect(htmlEn).toContain(tEn.severity.info);

    const htmlKo = renderToStaticMarkup(
      <OverviewView t={tKo} locale="ko-KR" onNavigate={() => undefined} />,
    );
    expect(htmlKo).toContain(tKo.overview.recentEvents);
    expect(htmlKo).toContain(tKo.overview.viewAllInOperations);
    expect(htmlKo).toContain(tKo.severity.error);
    expect(htmlKo).toContain(tKo.severity.warning);
  });

  it('highlights error and warning counts', () => {
    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );
    // 1 error, 2 warnings
    expect(html).toContain('1 error(s)');
    expect(html).toContain('2 warning(s)');
  });

  it('renders empty state when there are no events', () => {
    mocks.events = [];
    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );
    expect(html).toContain(tEn.overview.emptyEvents);
    expect(html).toContain('0 error(s)');
    expect(html).toContain('0 warning(s)');
  });

  it('isolates events query error so that rest of Overview continues to render normally', () => {
    mocks.eventsError = true;
    mocks.eventsErrorObj = new Error('Failed to load events');

    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    // KPI cards and pipeline flow still render normally
    expect(html).toContain(tEn.overview.totalServices);
    expect(html).toContain(tEn.overview.activePipelines);
    expect(html).toContain(tEn.overview.pipelineFlow);

    // Recent Events card renders its own ErrorState
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Failed to load events');

    // Recent events list or empty state is not rendered
    expect(html).not.toContain(tEn.overview.emptyEvents);
  });

  it('isolates events query loading state so that rest of Overview continues to render normally', () => {
    mocks.eventsLoading = true;

    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    // KPI cards and pipeline flow still render normally
    expect(html).toContain(tEn.overview.totalServices);
    expect(html).toContain(tEn.overview.activePipelines);
    expect(html).toContain(tEn.overview.pipelineFlow);

    // Recent Events card renders LoadingState
    expect(html).toContain(tEn.common.loading);
  });
});

describe('OverviewView catalog tables KPI', () => {
  beforeEach(() => {
    mocks.services = [];
    mocks.pipelines = [];
    mocks.events = [];
    mocks.eventsLoading = false;
    mocks.eventsError = false;
    mocks.eventsErrorObj = null;
    mocks.dataAssets = [
      { id: 'asset-table-orders', name: 'analytics.orders', kind: 'table', serviceId: 'svc-iceberg', status: 'healthy' },
      { id: 'asset-table-orders-enriched', name: 'analytics.orders_enriched', kind: 'table', serviceId: 'svc-iceberg', status: 'stale' },
      { id: 'asset-topic-events-raw', name: 'events.raw', kind: 'topic', serviceId: 'svc-kafka', status: 'degraded' },
      { id: 'asset-schema-analytics', name: 'analytics', kind: 'schema', serviceId: 'svc-iceberg', status: 'healthy' },
    ];
    mocks.dataAssetsLoading = false;
    mocks.dataAssetsError = false;
    mocks.dataAssetsErrorObj = null;
  });

  it('derives the KPI count from kind=table data assets returned by the API, not a hardcoded number', () => {
    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    expect(html).toContain(tEn.overview.catalogTables);
    // 2 of the 4 stub assets are kind=table; the other 2 (topic, schema) are excluded
    expect(html).toContain('>2<');
    expect(html).toContain('4 data assets total');
  });

  it('reads meta.total (not data.length of a single page) so counts beyond one page are correct', () => {
    // Regression guard: 120 more kind=table assets than any single LIST_PAGE_SIZE page would hold.
    // If the KPI/caption still read `data.length` off a capped page (the bug this regresses), the
    // table count would be stuck at whatever fit on one page instead of the true total.
    const manyTables: DataAsset[] = Array.from({ length: 120 }, (_, i) => ({
      id: `asset-table-extra-${i}`,
      name: `analytics.extra_${i}`,
      kind: 'table',
      serviceId: 'svc-iceberg',
      status: 'healthy',
    }));
    mocks.dataAssets = [...mocks.dataAssets, ...manyTables];

    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    expect(html).toContain('>122<');
    expect(html).toContain('124 data assets total');
  });

  it('shows a local skeleton on the KPI card while loading, without affecting the rest of the dashboard', () => {
    mocks.dataAssetsLoading = true;

    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    // Rest of Overview still renders normally
    expect(html).toContain(tEn.overview.totalServices);
    expect(html).toContain(tEn.overview.pipelineFlow);
    expect(html).toContain(tEn.overview.recentEvents);

    // KPI card label is present but no count/caption is rendered yet
    expect(html).toContain(tEn.overview.catalogTables);
    expect(html).not.toContain('4 data assets total');
    expect(html).not.toContain(tEn.overview.catalogTablesUnavailable);
  });

  it('shows the KPI card unavailable fallback on error, without blanking the rest of the dashboard', () => {
    mocks.dataAssetsError = true;
    mocks.dataAssetsErrorObj = new Error('Failed to load data assets');

    const html = renderToStaticMarkup(
      <OverviewView t={tEn} locale="en-US" onNavigate={() => undefined} />,
    );

    // A data-assets outage does not blank the rest of Overview -- health/services/pipelines
    // still render normally.
    expect(html).toContain(tEn.overview.totalServices);
    expect(html).toContain(tEn.overview.activePipelines);
    expect(html).toContain(tEn.overview.pipelineFlow);
    expect(html).toContain(tEn.overview.recentEvents);

    // KPI card itself shows a scoped unavailable fallback instead of a count
    expect(html).toContain(tEn.overview.catalogTables);
    expect(html).toContain(tEn.overview.catalogTablesUnavailable);
    expect(html).not.toContain('4 data assets total');
  });

  it('localizes the KPI unavailable fallback to Korean', () => {
    mocks.dataAssetsError = true;
    mocks.dataAssetsErrorObj = new Error('Failed to load data assets');

    const html = renderToStaticMarkup(
      <OverviewView t={tKo} locale="ko-KR" onNavigate={() => undefined} />,
    );

    expect(html).toContain(tKo.overview.catalogTablesUnavailable);
  });
});
