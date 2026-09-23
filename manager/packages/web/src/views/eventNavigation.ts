import type { Event } from '@beluga-manager/domain-api/schema';

export interface EventNavigationTarget {
  tab: 'services' | 'pipelines';
  id: string;
}

export function getEventNavigationTargets(
  event: Pick<Event, 'relatedServiceId' | 'relatedPipelineId'>,
): EventNavigationTarget[] {
  const targets: EventNavigationTarget[] = [];
  if (event.relatedServiceId) {
    targets.push({ tab: 'services', id: event.relatedServiceId });
  }
  if (event.relatedPipelineId) {
    targets.push({ tab: 'pipelines', id: event.relatedPipelineId });
  }
  return targets;
}
