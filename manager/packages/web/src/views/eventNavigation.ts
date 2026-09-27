import type { Event, Resource } from '@beluga-manager/domain-api/schema';

export interface EventNavigationTarget {
  tab: 'services' | 'pipelines' | 'operations';
  id: string;
  resource?: boolean;
  event?: boolean;
}

export function getResourceNavigationTargets(resource: Pick<Resource, 'relatedServiceId' | 'relatedPipelineId' | 'relatedEventIds'>): EventNavigationTarget[] {
  const targets: EventNavigationTarget[] = [];
  if (resource.relatedServiceId) targets.push({ tab: 'services', id: resource.relatedServiceId });
  if (resource.relatedPipelineId) targets.push({ tab: 'pipelines', id: resource.relatedPipelineId });
  for (const id of resource.relatedEventIds) targets.push({ tab: 'operations', id, event: true });
  return targets;
}

export function getEventNavigationTargets(
  event: Pick<Event, 'relatedServiceId' | 'relatedPipelineId'> & Partial<Pick<Event, 'relatedResourceId'>>,
): EventNavigationTarget[] {
  const targets: EventNavigationTarget[] = [];
  if (event.relatedServiceId) {
    targets.push({ tab: 'services', id: event.relatedServiceId });
  }
  if (event.relatedPipelineId) {
    targets.push({ tab: 'pipelines', id: event.relatedPipelineId });
  }
  if (event.relatedResourceId) targets.push({ tab: 'operations', id: event.relatedResourceId, resource: true });
  return targets;
}
