import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRecord, Event, Resource } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { OperationsView } from './OperationsView';

const mocks = vi.hoisted(() => ({
  events: [] as Event[],
  eventsLoading: false,
  eventsError: false,
  eventsErrorObj: null as unknown,
  resources: [] as Resource[],
  resourcesLoading: false,
  resourcesError: false,
  resourcesErrorObj: null as unknown,
  decisions: [] as DecisionRecord[],
  decisionsLoading: false,
  decisionsError: false,
  decisionsErrorObj: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  useEvents: () => ({
    data: mocks.eventsError ? undefined : { data: mocks.events, warnings: [], meta: { total: mocks.events.length } },
    isLoading: mocks.eventsLoading,
    isError: mocks.eventsError,
    error: mocks.eventsErrorObj,
  }),
  useResources: () => ({
    data: mocks.resourcesError ? undefined : { data: mocks.resources, warnings: [], meta: { total: mocks.resources.length } },
    isLoading: mocks.resourcesLoading,
    isError: mocks.resourcesError,
    error: mocks.resourcesErrorObj,
  }),
  useDecisions: () => ({
    data: mocks.decisionsError ? undefined : { data: mocks.decisions, warnings: [], meta: { total: mocks.decisions.length } },
    isLoading: mocks.decisionsLoading,
    isError: mocks.decisionsError,
    error: mocks.decisionsErrorObj,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');
const noop = () => undefined;

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
];

const testResources: Resource[] = [
  {
    id: 'k8s-workload-flink',
    kind: 'Workload',
    name: 'flink-cluster',
    namespace: 'data-platform',
    status: 'stale',
    cpuUsage: '850m',
    memoryUsage: '2Gi',
    relatedServiceId: 'svc-flink',
    relatedPipelineId: 'pl-lakehouse-ingest',
    relatedEventIds: ['evt-1'],
    logsUrl: 'https://logs.local.beluga.internal/flink',
  },
];

const testDecisions: DecisionRecord[] = [
  {
    id: 'decision-fresh',
    snapshotId: 'snapshot-fresh-001',
    correlationId: 'correlation-decision-fresh',
    evaluatedAt: '2026-09-28T09:00:00.000Z',
    result: {
      decision: 'NORMAL',
      confidence: 0.92,
      abstained: false,
      provider: 'rule-provider',
      providerVersion: '0.1.0',
      policyVersion: '0.1.0',
      decidedAt: '2026-09-28T09:00:00.100Z',
      evidenceRefs: [],
    },
    inputSignals: [{ name: 'k8s.pod.cpu', observedAt: '2026-09-28T08:59:30.000Z', freshAtEvaluation: true }],
    freshnessPolicy: { maxAgeMs: 60_000 },
    relatedResourceId: 'k8s-pod-flink-jobmanager',
    relatedServiceId: 'svc-flink',
    relatedPipelineId: 'pl-lakehouse-ingest',
  },
  {
    id: 'decision-empty',
    snapshotId: 'snapshot-empty-001',
    correlationId: 'correlation-decision-empty',
    evaluatedAt: '2026-09-28T08:55:00.000Z',
    result: {
      decision: 'NORMAL',
      confidence: 0,
      abstained: true,
      abstainCode: 'NO_TELEMETRY',
      provider: 'rule-provider',
      providerVersion: '0.1.0',
      policyVersion: '0.1.0',
      decidedAt: '2026-09-28T08:55:00.100Z',
      evidenceRefs: [],
    },
    inputSignals: [],
    freshnessPolicy: { maxAgeMs: 60_000 },
    relatedResourceId: null,
    relatedServiceId: 'svc-trino',
    relatedPipelineId: null,
  },
];

describe('OperationsView events tab (default section)', () => {
  beforeEach(() => {
    mocks.events = [...testEvents];
    mocks.eventsLoading = false;
    mocks.eventsError = false;
    mocks.eventsErrorObj = null;
    mocks.resources = [...testResources];
    mocks.resourcesLoading = false;
    mocks.resourcesError = false;
    mocks.resourcesErrorObj = null;
    mocks.decisions = [...testDecisions];
    mocks.decisionsLoading = false;
    mocks.decisionsError = false;
    mocks.decisionsErrorObj = null;
  });

  it('renders loading state when events are loading', () => {
    mocks.eventsLoading = true;
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when events fail to load', () => {
    mocks.eventsError = true;
    mocks.eventsErrorObj = new Error('Event stream unavailable');
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Event stream unavailable');
  });

  it('renders empty state when there are no events', () => {
    mocks.events = [];
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(html).toContain(tEn.operations.emptyState);
  });

  it('renders the event list with related-service navigation targets', () => {
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(html).toContain('Health probe timed out');
    expect(html).toContain('svc-observability');
  });

  it('shows the event source only when present, never inventing one', () => {
    mocks.events = [{ ...testEvents[0]!, id: 'evt-a', source: 'job' }, { ...testEvents[0]!, id: 'evt-b' }];
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(html).toContain(tEn.operations.eventSources.job);
    expect(html.split(tEn.operations.eventSourceLabel + ':').length - 1).toBe(1);
  });
});

describe('OperationsView resources tab', () => {
  beforeEach(() => {
    mocks.resources = [...testResources];
    mocks.resourcesLoading = false;
    mocks.resourcesError = false;
    mocks.resourcesErrorObj = null;
  });

  it('renders loading state when resources are loading', () => {
    mocks.resourcesLoading = true;
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} initialResourceId="k8s-workload-flink" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when resources fail to load', () => {
    mocks.resourcesError = true;
    mocks.resourcesErrorObj = new Error('Resource inventory unavailable');
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} initialResourceId="k8s-workload-flink" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Resource inventory unavailable');
  });

  it('renders empty state when there are no resources', () => {
    mocks.resources = [];
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} initialResourceId="anything" />);
    expect(html).toContain(tEn.operations.emptyResourcesState);
  });

  it('renders the resource table with a view-logs affordance when a resource has a safe logs URL', () => {
    const html = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} initialResourceId="k8s-workload-flink" />);
    expect(html).toContain('flink-cluster');
    expect(html).toContain('data-platform');
    expect(html).toContain('850m');
    expect(html).toContain(tEn.operations.viewLogs);
  });

  it('renders the kind filter, new kind labels and PVC storage fields in both locales', () => {
    mocks.resources = [
      ...testResources,
      { ...testResources[0]!, id: 'k8s-job-x', kind: 'Job', name: 'job-x' },
      { ...testResources[0]!, id: 'k8s-pvc-x', kind: 'PersistentVolumeClaim', name: 'pvc-x', capacity: '10Gi', storageClass: 'fast' },
    ];
    for (const t of [tEn, tKo]) {
      const html = renderToStaticMarkup(<OperationsView t={t} onNavigate={noop} initialResourceId="k8s-job-x" />);
      expect(html).toContain(t.operations.kindFilterLabel);
      expect(html).toContain(`<option value="Endpoint">${t.operations.kindNames.Endpoint}</option>`);
      expect(html).toContain(`<option value="Job">${t.operations.kindNames.Job}</option>`);
      expect(html).toContain('10Gi');
      expect(html).toContain('fast');
    }
  });
});

describe('OperationsView decisions tab', () => {
  beforeEach(() => {
    mocks.decisions = [...testDecisions];
    mocks.decisionsLoading = false;
    mocks.decisionsError = false;
    mocks.decisionsErrorObj = null;
  });

  // NOTE (coverage gap, documented in docs/development.md): the decisions section is only
  // reachable by clicking the in-component tab button (`setSection('decisions')`), and there is
  // no `initial*` prop to seed it the way `initialResourceId`/`initialEventId` seed the other two
  // sections. This suite's renderToStaticMarkup pattern has no jsdom/testing-library, so it
  // cannot simulate that click. We can only assert the tab affordance renders; the decisions list
  // itself (role labels, confidence, abstain codes) is exercised indirectly by
  // `decisionLabels.test.ts`, which unit-tests the label-selection logic the decisions branch
  // calls, but not the OperationsView rendering of it.
  it('exposes a decisions tab button labelled for both locales', () => {
    const htmlEn = renderToStaticMarkup(<OperationsView t={tEn} onNavigate={noop} />);
    expect(htmlEn).toContain(tEn.operations.eventsTab);
    expect(htmlEn).toContain(tEn.operations.decisionsTab);

    const htmlKo = renderToStaticMarkup(<OperationsView t={tKo} onNavigate={noop} />);
    expect(htmlKo).toContain(tKo.operations.decisionsTab);
  });
});
