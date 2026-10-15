import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline, Service } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { PipelinesView, buildPipelineCorrelationGraph, inferCorrelationNodeStatus, inferJobStatus } from './PipelinesView';

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
    correlationLinks: [
      {
        id: 'topic-feeds-job:t1->j1', source: { kind: 'kafka-topic', id: 't1' }, target: { kind: 'flink-job', id: 'j1' },
        relation: 'topic-feeds-job', confidence: 0.95, method: 'declared-label', evidence: ['label beluga.io/source-topic=orders.cdc'],
      },
      {
        id: 'dag-triggers-job:d1->j1', source: { kind: 'airflow-dag', id: 'd1' }, target: { kind: 'flink-job', id: 'j1' },
        relation: 'dag-triggers-job', confidence: 0.6, method: 'name-convention', evidence: ['<script>alert(1)</script>'],
      },
    ],
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
    correlationLinks: [],
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
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when pipelines fail to load', () => {
    mocks.isError = true;
    mocks.errorObj = new Error('Pipeline discovery failed');
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Pipeline discovery failed');
  });

  it('renders the topology cards for every pipeline and defaults the detail panel to the first one', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
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
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain('orders-sync');
    expect(html).toContain(tEn.pipelines.jobKinds.flink);
    expect(html).toContain(tEn.pipelines.runResults.failed);
    expect(html).toContain('Checkpoint timeout after 600s');
    expect(html).toContain('k8s-workload-flink');
  });

  it('renders correlation links with relation, confidence, inferred marker (even at 0.6) and escaped evidence', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.pipelines.correlationLinksLabel);
    expect(html).toContain(tEn.pipelines.correlationRelations['topic-feeds-job']);
    expect(html).toContain(tEn.pipelines.correlationRelations['dag-triggers-job']);
    expect(html).toContain('label beluga.io/source-topic=orders.cdc');
    expect(html).toContain(tEn.pipelines.lowConfidence);
    expect(html).toContain(tEn.pipelines.correlationMethods['name-convention']);
    expect(html).toContain(tEn.pipelines.correlationMethods['declared-label']);
    expect(html.split(tEn.pipelines.lowConfidence)).toHaveLength(2);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the pipeline correlation graph with specialist graph component', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.pipelines.correlationGraphTitle);
    expect(html).toContain(tEn.graph.graphView);
    expect(html).toContain(tEn.graph.tableView);
    expect(html).toContain('t1');
    expect(html).toContain('j1');
  });

  it('shows an empty correlation-links message in Korean for pipelines without links', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tKo} theme="light" initialPipelineId="pl-batch-reporting" />);
    expect(html).toContain(tKo.pipelines.noCorrelationLinks);
  });

  it('shows an empty-jobs message and Korean labels for pipelines without jobs', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tKo} theme="light" initialPipelineId="pl-batch-reporting" />);
    expect(html).toContain(tKo.pipelines.noJobs);
  });

  it('renders noRuns for a job with lastRun null and no failure alert', () => {
    mocks.pipelines = [{
      ...testPipelines[0]!,
      jobs: [{ id: 'j1', name: 'never-ran', kind: 'airflow', serviceId: 'svc-airflow', lastRun: null, relatedResourceIds: [] }],
    }];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain('never-ran');
    expect(html).toContain(tEn.pipelines.noRuns);
    expect(html).not.toContain('role="alert"');
  });

  it('renders a running job without finishedAt', () => {
    mocks.pipelines = [{
      ...testPipelines[0]!,
      jobs: [{
        id: 'j2', name: 'streaming-now', kind: 'flink', serviceId: 'svc-flink',
        lastRun: { result: 'running', startedAt: '2026-09-21T05:00:00.000Z', finishedAt: null, failureReason: null },
        relatedResourceIds: [],
      }],
    }];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain('streaming-now');
    expect(html).toContain(tEn.pipelines.runResults.running);
    expect(html).not.toContain('role="alert"');
  });

  it('does not render failureReason unless the last run failed', () => {
    mocks.pipelines = [{
      ...testPipelines[0]!,
      jobs: [{
        id: 'j3', name: 'ok-job', kind: 'cdc', serviceId: 'svc-flink',
        lastRun: { result: 'succeeded', startedAt: '2026-09-21T05:00:00.000Z', finishedAt: '2026-09-21T05:10:00.000Z', failureReason: 'stale reason' },
        relatedResourceIds: [],
      }],
    }];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).not.toContain('stale reason');
  });

  it('omits stage links when the matching service endpoint is unsafe', () => {
    mocks.services = [{ ...testServices[0]!, endpoint: 'javascript:alert(1)' }];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain('svc-kafka');
    expect(html).not.toContain('<a ');
  });

  it('selects the pipeline matching initialPipelineId for the detail panel', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" initialPipelineId="pl-batch-reporting" />);
    expect(html).toContain('svc-airflow');
    expect(html).toContain('inferred');
    expect(html).toContain('55%');
  });

  it('renders a not-found message when initialPipelineId does not match any pipeline', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" initialPipelineId="pl-missing" />);
    expect(html).toContain(tEn.pipelines.notFound);
    expect(html).toContain('pl-missing');
  });

  it('renders an empty topology grid without crashing when there are no pipelines', () => {
    mocks.pipelines = [];
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.pipelines.topologyTitle);
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<PipelinesView t={tKo} theme="light" />);
    expect(html).toContain(tKo.pipelines.title.replace('&', '&amp;'));
    expect(html).toContain(tKo.pipelines.stagesLabel);
    expect(html).toContain(tKo.pipelines.correlationLabel);
  });

  it('passes the theme through to the correlation graph (light and dark)', () => {
    const light = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    const dark = renderToStaticMarkup(<PipelinesView t={tEn} theme="dark" />);
    expect(light).toContain('class="react-flow light"');
    expect(light).not.toContain('class="react-flow dark"');
    expect(dark).toContain('class="react-flow dark"');
    expect(dark).not.toContain('class="react-flow light"');
  });
});

describe('correlation node status mapping (never healthy without evidence)', () => {
  const job = (lastRun: Pipeline['jobs'][number]['lastRun']) => ({
    id: 'job-1', name: 'orders-sync', kind: 'flink' as const, serviceId: 'svc-flink', lastRun, relatedResourceIds: [],
  });
  const run = (result: 'running' | 'succeeded' | 'failed' | 'unknown') => ({
    result, startedAt: '2026-09-21T05:00:00.000Z', finishedAt: null, failureReason: result === 'failed' ? 'boom' : null,
  });

  it('maps lastRun results explicitly', () => {
    expect(inferJobStatus(job(run('succeeded')))).toBe('healthy');
    expect(inferJobStatus(job(run('running')))).toBe('healthy');
    expect(inferJobStatus(job(run('failed')))).toBe('degraded');
    expect(inferJobStatus(job(run('unknown')))).toBe('unknown');
  });

  it('reports unknown for a job that has no lastRun', () => {
    expect(inferJobStatus(job(null))).toBe('unknown');
    expect(inferCorrelationNodeStatus({ stages: [], jobs: [job(null)] }, 'orders-sync')).toEqual({ status: 'unknown', detail: null });
  });

  it('matches jobs by id or name and carries the failure reason as detail', () => {
    const p = { stages: [], jobs: [job(run('failed'))] };
    expect(inferCorrelationNodeStatus(p, 'job-1')).toEqual({ status: 'degraded', detail: 'boom' });
    expect(inferCorrelationNodeStatus(p, 'orders-sync').status).toBe('degraded');
  });

  it('uses a stage status only for an exact serviceId match, never by service type', () => {
    const p = {
      stages: [{ serviceId: 'svc-kafka', serviceType: 'kafka' as const, status: 'degraded' as const, detail: 'lag' }],
      jobs: [],
    };
    expect(inferCorrelationNodeStatus(p, 'svc-kafka')).toEqual({ status: 'degraded', detail: 'lag' });
    // a Kafka TOPIC is not the Kafka service: no borrowing from the first kafka stage
    expect(inferCorrelationNodeStatus(p, 'orders.cdc')).toEqual({ status: 'unknown', detail: null });
  });

  it('builds graph nodes with unknown status and renders the text label for them', () => {
    const { nodes } = buildPipelineCorrelationGraph(testPipelines[0]!, tEn);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.status === 'unknown')).toBe(true); // fixtures reference j1/t1/d1: no evidence
    const html = renderToStaticMarkup(<PipelinesView t={tEn} theme="light" />);
    expect(html).toContain(tEn.status.unknown);
  });
});
