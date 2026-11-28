import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline, Resource } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { ArchitectureView } from './ArchitectureView';
import { getStageNavigationTargets } from './architectureNavigation';
import { getInfraResourceTarget } from './infraTopology';

const mocks = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
  serviceIds: [] as string[],
  resources: [] as Resource[],
  resourcesError: false,
  resourceWarnings: [] as { code: string; message: string }[],
  resourcesTotal: null as number | null,
  servicesError: false,
  isLoading: false,
  isError: false,
  errorObj: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  usePipelines: () => ({
    data: mocks.isError ? undefined : { data: mocks.pipelines, warnings: [], meta: { total: mocks.pipelines.length } },
    isLoading: mocks.isLoading,
    isError: mocks.isError,
    error: mocks.errorObj,
  }),
  useResources: () => ({
    data: mocks.resourcesError ? undefined : { data: mocks.resources, warnings: mocks.resourceWarnings, meta: { total: mocks.resourcesTotal ?? mocks.resources.length } },
    isLoading: false,
    isError: mocks.resourcesError,
    error: mocks.resourcesError ? new Error('resources down') : null,
  }),
  useServices: () => ({
    data: mocks.servicesError ? undefined : { data: mocks.serviceIds.map((id) => ({ id })), warnings: [], meta: { total: mocks.serviceIds.length } },
    isLoading: false,
    isError: mocks.servicesError,
    error: mocks.servicesError ? new Error('services down') : null,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testPipelines: Pipeline[] = [
  {
    id: 'pl-lakehouse-ingest',
    name: 'Kafka to Iceberg Lakehouse Ingest',
    stages: [
      { serviceId: 'svc-kafka', serviceType: 'kafka', status: 'degraded', detail: 'Under-replicated partitions on 2 brokers' },
      { serviceId: 'svc-iceberg', serviceType: 'iceberg', status: 'healthy', detail: null },
    ],
    jobs: [],
    status: 'degraded',
    correlationLinks: [],
    correlation: { confidence: 0.97, method: 'declared' },
    lastUpdatedAt: '2026-09-21T05:50:00.000Z',
  },
  {
    id: 'pl-batch-reporting',
    name: 'Airflow Batch Reporting',
    stages: [{ serviceId: 'svc-airflow', serviceType: 'airflow', status: 'healthy', detail: null }],
    jobs: [],
    status: 'healthy',
    correlationLinks: [],
    correlation: { confidence: 0.55, method: 'inferred' },
    lastUpdatedAt: '2026-09-21T05:40:00.000Z',
  },
];

const testResources: Resource[] = [
  { id: 'k8s-namespace-data', kind: 'Namespace', name: 'data-platform', namespace: null, status: 'healthy', relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null },
  { id: 'k8s-pod-flink', kind: 'Pod', name: 'flink-jobmanager-0', namespace: 'data-platform', status: 'degraded', relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null },
];

describe('ArchitectureView', () => {
  beforeEach(() => {
    mocks.resources = [...testResources];
    mocks.pipelines = [...testPipelines];
    mocks.serviceIds = ['svc-kafka', 'svc-iceberg'];
    mocks.resourcesError = false;
    mocks.resourceWarnings = [];
    mocks.resourcesTotal = null;
    mocks.servicesError = false;
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.errorObj = null;
  });

  it('renders loading state when pipelines are loading', () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when pipelines fail to load', () => {
    mocks.isError = true;
    mocks.errorObj = new Error('Pipeline discovery failed');
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Pipeline discovery failed');
  });

  it('renders the pipeline switcher and the data-pipeline-topology graph for the first pipeline', () => {
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tEn.architecture.dataPipelineTopology);
    expect(html).toContain('Kafka to Iceberg Lakehouse Ingest');
    expect(html).toContain('Airflow Batch Reporting');
    // Graph nodes for the default (first) pipeline's stages
    expect(html).toContain('svc-kafka');
    expect(html).toContain('svc-iceberg');
  });

  it('offers navigation only to services and pipelines backed by loaded data', () => {
    const serviceIds = new Set(mocks.serviceIds);
    expect(getStageNavigationTargets('svc-kafka', serviceIds, mocks.pipelines, testPipelines[0]?.id)).toEqual([
      { tab: 'services', id: 'svc-kafka' },
      { tab: 'pipelines', id: 'pl-lakehouse-ingest', pipelineName: 'Kafka to Iceberg Lakehouse Ingest' },
    ]);
    expect(getStageNavigationTargets('svc-airflow', serviceIds, mocks.pipelines, testPipelines[1]?.id)).toEqual([
      { tab: 'pipelines', id: 'pl-batch-reporting', pipelineName: 'Airflow Batch Reporting' },
    ]);
  });

  it('enables the infrastructure perspective as a pressed-state tab', () => {
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tEn.architecture.infrastructureTopology);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-pressed="false"');
  });

  it('shows resource nodes with names and status when the infrastructure tab is active', () => {
    const html = renderToStaticMarkup(
      <ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} initialPerspective="infrastructure" />,
    );
    expect(html).toContain('data-platform');
    expect(html).toContain('flink-jobmanager-0');
    expect(html).toContain(tEn.common.degraded);
    expect(html).not.toContain('svc-kafka');
  });

  it('shows an empty state when there are no resources', () => {
    mocks.resources = [];
    const html = renderToStaticMarkup(
      <ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} initialPerspective="infrastructure" />,
    );
    expect(html).toContain(tEn.architecture.infrastructureEmpty);
  });

  it('drills down from a resource node to the Operations resource', () => {
    expect(getInfraResourceTarget(testResources[1]!)).toEqual({ tab: 'operations', id: 'k8s-pod-flink', resource: true });
  });

  it('renders nothing beyond the header when there are no pipelines', () => {
    mocks.pipelines = [];
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tEn.architecture.title);
    expect(html).not.toContain(tEn.architecture.clickNodeHint);
  });

  it('shows the current-composition perspective with live status sources and unobserved components', () => {
    mocks.serviceIds = [];
    mocks.resources = [
      { id: 'kubernetes:streaming/Deployment/debezium-connect', kind: 'Workload', name: 'debezium-connect', namespace: 'streaming', status: 'healthy', relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null },
    ];
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toContain(tEn.architecture.currentComposition);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(tEn.architecture.compositionHint);
    expect(html).toContain('Debezium');
    expect(html).toContain('Keycloak');
    // streaming was read: its other components are measured absences, the rest are unobserved.
    expect(html).toMatch(/data-testid="composition-count-missing"[^>]*>2</);
    expect(html).toMatch(/data-testid="composition-count-unobserved"[^>]*>15</);
    expect(html).toContain(tEn.architecture.compositionLegend);
    expect(html).toMatch(/data-testid="composition-count-resources"[^>]*>1</);
  });

  it('shows an error instead of an all-unobserved panel when resources fail to load', () => {
    mocks.resourcesError = true;
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toContain('resources down');
    expect(html).not.toContain(tEn.architecture.compositionLegend);
    expect(html).not.toContain('composition-count-unobserved');
  });

  it('shows an error instead of the panel when services fail to load', () => {
    mocks.servicesError = true;
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toContain('services down');
    expect(html).not.toContain('composition-count-unobserved');
  });

  it('claims no absence when the resource list has warnings or is truncated', () => {
    const streamingOnly: Resource = { id: 'kubernetes:streaming/Deployment/debezium-connect', kind: 'Workload', name: 'debezium-connect', namespace: 'streaming', status: 'healthy', relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null };
    mocks.serviceIds = [];
    mocks.resources = [streamingOnly];
    mocks.resourceWarnings = [{ code: 'UPSTREAM_UNAVAILABLE', message: 'partial read' }];
    let html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toMatch(/data-testid="composition-count-missing"[^>]*>0</);
    mocks.resourceWarnings = [];
    mocks.resourcesTotal = 250; // more items exist than the page returned
    html = renderToStaticMarkup(<ArchitectureView t={tEn} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toMatch(/data-testid="composition-count-missing"[^>]*>0</);
  });

  it('renders the composition perspective in Korean', () => {
    const html = renderToStaticMarkup(<ArchitectureView t={tKo} theme="light" onNavigateToEventTarget={() => {}} initialPerspective="composition" />);
    expect(html).toContain('현재 구성');
    expect(html).toContain(tKo.architecture.compositionLayers.lake);
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<ArchitectureView t={tKo} theme="dark" onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(tKo.architecture.title);
    expect(html).toContain(tKo.architecture.dataPipelineTopology);
    expect(html).toContain(tKo.architecture.clickNodeHint);
  });

  it.each(['light', 'dark'] as const)('renders the pipeline stage graph in %s mode', (theme) => {
    const html = renderToStaticMarkup(<ArchitectureView t={tEn} theme={theme} onNavigateToEventTarget={vi.fn()} />);
    expect(html).toContain(`class="react-flow ${theme}"`);
    expect(html).not.toContain(`class="react-flow ${theme === 'dark' ? 'light' : 'dark'}"`);
  });

  it.each(['light', 'dark'] as const)('renders the infrastructure topology graph in %s mode', (theme) => {
    const html = renderToStaticMarkup(
      <ArchitectureView t={tEn} theme={theme} onNavigateToEventTarget={vi.fn()} initialPerspective="infrastructure" />,
    );
    expect(html).toContain(`class="react-flow ${theme}"`);
    expect(html).not.toContain(`class="react-flow ${theme === 'dark' ? 'light' : 'dark'}"`);
  });
});
