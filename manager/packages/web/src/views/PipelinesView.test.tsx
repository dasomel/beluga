import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline, Service } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { PipelinesView } from './PipelinesView';

const mocks = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
  services: [] as Service[],
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
  useServices: () => ({
    data: { data: mocks.services, warnings: [], meta: { total: mocks.services.length } },
    isLoading: false,
    isError: false,
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
    jobs: [
      {
        id: 'job-flink-orders-sync', name: 'orders-sync', kind: 'flink', serviceId: 'svc-flink',
        lastRun: { result: 'failed', startedAt: '2026-09-21T05:00:00.000Z', finishedAt: '2026-09-21T05:42:00.000Z', failureReason: 'Checkpoint timeout after 600s' },
        relatedResourceIds: ['k8s-workload-flink'],
      },
    ],
    status: 'degraded',
    correlation: { confidence: 0.97, method: 'declared' },
    lastUpdatedAt: '2026-09-21T05:50:00.000Z',
  },
  {
    id: 'pl-batch-reporting',
    name: 'Airflow Batch Reporting',
    stages: [
      { serviceId: 'svc-airflow', serviceType: 'airflow', status: 'healthy', detail: null },
    ],
    jobs: [],
    status: 'healthy',
    correlation: { confidence: 0.55, method: 'inferred' },
    lastUpdatedAt: '2026-09-21T05:40:00.000Z',
  },
];

const testServices: Service[] = [
  {
    id: 'svc-kafka', name: 'Kafka', type: 'kafka', version: '1', status: 'degraded',
    endpoint: 'https://kafka.example.test', capabilities: [], capabilityCategories: ['streaming'], dependencies: [],
    namespace: null, workloadRef: null, keyMetrics: [],
    lastCheckedAt: '2026-09-21T05:50:00.000Z', staleAfterMs: 60_000,
  },
  {
    id: 'svc-iceberg', name: 'Iceberg', type: 'iceberg', version: '1', status: 'healthy',
    endpoint: null, capabilities: [], capabilityCategories: ['lakehouse'], dependencies: [],
    namespace: null, workloadRef: null, keyMetrics: [],
    lastCheckedAt: '2026-09-21T05:50:00.000Z', staleAfterMs: 60_000,
  },
];

describe('PipelinesView', () => {
  beforeEach(() => {
    mocks.pipelines = [...testPipelines];
    mocks.services = [...testServices];
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.errorObj = null;
  });

  it('renders loading state when pipelines are loading', () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when pipelines fail to load', () => {
    mocks.isError = true;
    mocks.errorObj = new Error('Pipeline discovery failed');
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Pipeline discovery failed');
  });

  it('renders the topology cards for every pipeline and defaults the detail panel to the first one', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain('Kafka to Iceberg Lakehouse Ingest');
    expect(html).toContain('Airflow Batch Reporting');
    // Detail panel defaults to the first pipeline's stages
    expect(html).toContain('svc-kafka');
    expect(html).toContain('Under-replicated partitions on 2 brokers');
    expect(html).toContain('declared');
    expect(html).toContain('97%');
    expect(html).toContain('href="https://kafka.example.test/"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain(tEn.services.openUi);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('renders jobs with last run result, failure reason and related resources', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain('orders-sync');
    expect(html).toContain(tEn.pipelines.jobKinds.flink);
    expect(html).toContain(tEn.pipelines.runResults.failed);
    expect(html).toContain('Checkpoint timeout after 600s');
    expect(html).toContain('k8s-workload-flink');
  });

  it('shows an empty-jobs message and Korean labels for pipelines without jobs', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tKo} initialPipelineId="pl-batch-reporting" />);
    expect(html).toContain(tKo.pipelines.noJobs);
  });

  it('omits stage links when the matching service endpoint is unsafe', () => {
    mocks.services = [{ ...testServices[0]!, endpoint: 'javascript:alert(1)' }];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain('svc-kafka');
    expect(html).not.toContain('<a ');
  });

  it('selects the pipeline matching initialPipelineId for the detail panel', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} initialPipelineId="pl-batch-reporting" />);
    expect(html).toContain('svc-airflow');
    expect(html).toContain('inferred');
    expect(html).toContain('55%');
  });

  it('renders a not-found message when initialPipelineId does not match any pipeline', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} initialPipelineId="pl-missing" />);
    expect(html).toContain(tEn.pipelines.notFound);
    expect(html).toContain('pl-missing');
  });

  it('renders an empty topology grid without crashing when there are no pipelines', () => {
    mocks.pipelines = [];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} />);
    expect(html).toContain(tEn.pipelines.topologyTitle);
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tKo} />);
    expect(html).toContain(tKo.pipelines.title.replace('&', '&amp;'));
    expect(html).toContain(tKo.pipelines.stagesLabel);
    expect(html).toContain(tKo.pipelines.correlationLabel);
  });
});
