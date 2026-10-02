import { describe, expect, it } from 'vitest';
import type { Pipeline } from '@beluga-manager/domain-api/schema';
import { getStageNavigationTargets } from './architectureNavigation';

const pipelines: Pipeline[] = [
  {
    id: 'pl-real', name: 'Real pipeline',
    stages: [{ serviceId: 'svc-real', serviceType: 'kafka', status: 'healthy', detail: null }],
    jobs: [], correlationLinks: [], status: 'healthy', correlation: { confidence: 1, method: 'declared' }, lastUpdatedAt: '2026-09-21T05:50:00.000Z',
  },
];

const sharedPipelines: Pipeline[] = [
  ...pipelines,
  {
    id: 'pl-second', name: 'Second pipeline',
    stages: [{ serviceId: 'svc-real', serviceType: 'trino', status: 'healthy', detail: null }],
    jobs: [], correlationLinks: [], status: 'healthy', correlation: { confidence: 1, method: 'declared' }, lastUpdatedAt: '2026-09-21T05:50:00.000Z',
  },
  {
    ...pipelines[0]!, name: 'Duplicate id entry',
  },
];

describe('getStageNavigationTargets', () => {
  it('returns only targets backed by current service and pipeline data', () => {
    expect(getStageNavigationTargets('svc-real', new Set(['svc-real']), pipelines)).toEqual([
      { tab: 'services', id: 'svc-real' },
      { tab: 'pipelines', id: 'pl-real', pipelineName: 'Real pipeline' },
    ]);
  });

  it('omits actions when a stage has no matching real ids', () => {
    expect(getStageNavigationTargets('svc-missing', new Set(), pipelines)).toEqual([]);
  });

  it('omits service navigation when only a pipeline stage matches', () => {
    expect(getStageNavigationTargets('svc-real', new Set(), pipelines)).toEqual([
      { tab: 'pipelines', id: 'pl-real', pipelineName: 'Real pipeline' },
    ]);
  });

  it('labels each matching pipeline and keeps pipeline data order', () => {
    expect(getStageNavigationTargets('svc-real', new Set(), sharedPipelines)).toEqual([
      { tab: 'pipelines', id: 'pl-real', pipelineName: 'Real pipeline' },
      { tab: 'pipelines', id: 'pl-second', pipelineName: 'Second pipeline' },
    ]);
  });

  it('moves the scoped pipeline first and deduplicates repeated pipeline ids', () => {
    expect(getStageNavigationTargets('svc-real', new Set(['svc-real']), sharedPipelines, 'pl-second')).toEqual([
      { tab: 'services', id: 'svc-real' },
      { tab: 'pipelines', id: 'pl-second', pipelineName: 'Second pipeline' },
      { tab: 'pipelines', id: 'pl-real', pipelineName: 'Real pipeline' },
    ]);
  });
});
