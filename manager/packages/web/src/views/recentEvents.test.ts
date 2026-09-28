import { describe, expect, it } from 'vitest';
import type { Event } from '@beluga-manager/domain-api/schema';
import {
  countEventSeverities,
  createEventFocusTarget,
  selectRecentEvents,
  sortEventsByTimestampDesc,
} from './recentEvents';

const mockEvents: Event[] = [
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

describe('sortEventsByTimestampDesc', () => {
  it('returns empty array when given empty array', () => {
    expect(sortEventsByTimestampDesc([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = Object.freeze([...mockEvents]);
    const sorted = sortEventsByTimestampDesc(input);
    expect(sorted).not.toBe(input);
    expect(sorted.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6']);
  });

  it('sorts shuffled events by timestamp descending (newest first)', () => {
    const shuffled = [mockEvents[3]!, mockEvents[0]!, mockEvents[5]!, mockEvents[1]!, mockEvents[4]!, mockEvents[2]!];
    const sorted = sortEventsByTimestampDesc(shuffled);
    expect(sorted.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6']);
  });

  it('ranks valid timestamps before invalid timestamps even if invalid value is lexicographically higher', () => {
    const mixed: Event[] = [
      { ...mockEvents[0]!, id: 'garbage-z', timestamp: 'zzz-not-a-date' },
      { ...mockEvents[0]!, id: 'valid-older', timestamp: '2026-09-20T00:00:00.000Z' },
      { ...mockEvents[0]!, id: 'garbage-a', timestamp: 'aaa-not-a-date' },
      { ...mockEvents[0]!, id: 'valid-newer', timestamp: '2026-09-21T12:00:00.000Z' },
    ];
    const sorted = sortEventsByTimestampDesc(mixed);
    expect(sorted.map((e) => e.id)).toEqual([
      'valid-newer',
      'valid-older',
      'garbage-z',
      'garbage-a',
    ]);
  });

  it('keeps invalid timestamps last and maintains stable order among them', () => {
    const invalids: Event[] = [
      { ...mockEvents[0]!, id: 'inv-1', timestamp: 'zzz' },
      { ...mockEvents[0]!, id: 'inv-2', timestamp: 'aaa' },
      { ...mockEvents[0]!, id: 'inv-3', timestamp: 'mmm' },
    ];
    const sorted = sortEventsByTimestampDesc(invalids);
    expect(sorted.map((e) => e.id)).toEqual(['inv-1', 'inv-2', 'inv-3']);
  });
});

describe('selectRecentEvents', () => {
  it('returns empty array when events list is empty', () => {
    expect(selectRecentEvents([])).toEqual([]);
  });

  it('defaults to returning the latest 5 events', () => {
    const selected = selectRecentEvents(mockEvents);
    expect(selected).toHaveLength(5);
    expect(selected.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);
  });

  it('returns all events if count is less than 5', () => {
    const subset = mockEvents.slice(0, 3);
    const selected = selectRecentEvents(subset);
    expect(selected).toHaveLength(3);
    expect(selected.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('respects custom limit and clamps non-positive limits to 0', () => {
    expect(selectRecentEvents(mockEvents, 2).map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(selectRecentEvents(mockEvents, 0)).toEqual([]);
    expect(selectRecentEvents(mockEvents, -1)).toEqual([]);
  });

  it('does not allow invalid timestamps to outrank valid ones in recent selection', () => {
    const events: Event[] = [
      { ...mockEvents[0]!, id: 'invalid-top', timestamp: 'zzz' },
      { ...mockEvents[0]!, id: 'valid-1', timestamp: '2026-09-21T05:00:00.000Z' },
      { ...mockEvents[0]!, id: 'valid-2', timestamp: '2026-09-21T04:00:00.000Z' },
    ];
    const selected = selectRecentEvents(events, 2);
    expect(selected.map((e) => e.id)).toEqual(['valid-1', 'valid-2']);
  });
});

describe('countEventSeverities', () => {
  it('returns all zeros for empty events', () => {
    expect(countEventSeverities([])).toEqual({
      error: 0,
      warning: 0,
      info: 0,
      total: 0,
    });
  });

  it('accurately counts error, warning, info, and total across all events', () => {
    expect(countEventSeverities(mockEvents)).toEqual({
      error: 1,
      warning: 2,
      info: 3,
      total: 6,
    });
  });

  it('handles events containing only one severity', () => {
    const errorOnly: Event[] = [
      { ...mockEvents[0]!, id: 'err-1', severity: 'error' },
      { ...mockEvents[0]!, id: 'err-2', severity: 'error' },
    ];
    expect(countEventSeverities(errorOnly)).toEqual({
      error: 2,
      warning: 0,
      info: 0,
      total: 2,
    });
  });
});

describe('createEventFocusTarget', () => {
  it('creates an EventNavigationTarget for focusing a specific event in Operations', () => {
    expect(createEventFocusTarget('evt-42')).toEqual({
      tab: 'operations',
      id: 'evt-42',
      event: true,
    });
  });
});
