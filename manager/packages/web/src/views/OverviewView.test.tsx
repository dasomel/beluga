import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, Pipeline, Service } from '@beluga-manager/domain-api/schema';
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
