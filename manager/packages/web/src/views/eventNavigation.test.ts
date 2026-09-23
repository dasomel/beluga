import { describe, expect, it } from 'vitest';
import { getEventNavigationTargets } from './eventNavigation';

describe('getEventNavigationTargets', () => {
  it('provides no navigation for an event without related resources', () => {
    expect(getEventNavigationTargets({ relatedServiceId: null, relatedPipelineId: null })).toEqual([]);
  });

  it('opens Services for a service-only event', () => {
    expect(getEventNavigationTargets({ relatedServiceId: 'svc-flink', relatedPipelineId: null }))
      .toEqual([{ tab: 'services', id: 'svc-flink' }]);
  });

  it('opens Pipelines for a pipeline-only event', () => {
    expect(getEventNavigationTargets({ relatedServiceId: null, relatedPipelineId: 'pl-ingest' }))
      .toEqual([{ tab: 'pipelines', id: 'pl-ingest' }]);
  });

  it('keeps both destinations independently actionable, even when IDs match', () => {
    expect(getEventNavigationTargets({ relatedServiceId: 'shared-id', relatedPipelineId: 'shared-id' }))
      .toEqual([
        { tab: 'services', id: 'shared-id' },
        { tab: 'pipelines', id: 'shared-id' },
      ]);
  });

  it('preserves opaque resource IDs without translating or URL-encoding them', () => {
    expect(getEventNavigationTargets({ relatedServiceId: 'svc/처리 #1', relatedPipelineId: 'pl/A?B' }))
      .toEqual([
        { tab: 'services', id: 'svc/처리 #1' },
        { tab: 'pipelines', id: 'pl/A?B' },
      ]);
  });

  it('ignores empty references defensively without mutating the event', () => {
    const event = Object.freeze({ relatedServiceId: '', relatedPipelineId: '' });
    expect(getEventNavigationTargets(event)).toEqual([]);
    expect(event).toEqual({ relatedServiceId: '', relatedPipelineId: '' });
  });
});
