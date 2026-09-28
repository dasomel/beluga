import type { Event } from '@beluga-manager/domain-api/schema';
import type { EventNavigationTarget } from './eventNavigation';

export interface EventSeverityCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/**
 * Sorts events descending by timestamp (newest first).
 * Valid ISO datetimes always rank before unparsable timestamps.
 * Unparsable timestamps are placed last in stable order.
 * Does not mutate the input array.
 */
export function sortEventsByTimestampDesc(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const timeB = Date.parse(b.timestamp);
    const timeA = Date.parse(a.timestamp);
    const validB = !Number.isNaN(timeB);
    const validA = !Number.isNaN(timeA);

    if (validA && validB) {
      return timeB - timeA;
    }
    if (validA) {
      return -1;
    }
    if (validB) {
      return 1;
    }
    return 0;
  });
}

/**
 * Returns the latest N events by timestamp.
 * Limit defaults to 5. Clamps negative limits to 0.
 */
export function selectRecentEvents(events: readonly Event[], limit: number = 5): Event[] {
  const safeLimit = Math.max(0, limit);
  return sortEventsByTimestampDesc(events).slice(0, safeLimit);
}

/**
 * Counts occurrences of each severity ('error', 'warning', 'info') in the events list.
 */
export function countEventSeverities(events: readonly Event[]): EventSeverityCounts {
  let error = 0;
  let warning = 0;
  let info = 0;

  for (const event of events) {
    if (event.severity === 'error') {
      error++;
    } else if (event.severity === 'warning') {
      warning++;
    } else if (event.severity === 'info') {
      info++;
    }
  }

  return {
    error,
    warning,
    info,
    total: events.length,
  };
}

/**
 * Returns an EventNavigationTarget that routes to the Operations tab focused on a specific event.
 */
export function createEventFocusTarget(eventId: string): EventNavigationTarget {
  return {
    tab: 'operations',
    id: eventId,
    event: true,
  };
}
