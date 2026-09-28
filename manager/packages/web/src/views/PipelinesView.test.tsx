import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { PipelinesView } from './PipelinesView';

const mocks = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
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
    status: 'healthy',
    correlation: { confidence: 0.55, method: 'inferred' },
    lastUpdatedAt: '2026-09-21T05:40:00.000Z',
  },
];

describe('PipelinesView', () => {
  beforeEach(() => {
    mocks.pipelines = [...testPipelines];
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
