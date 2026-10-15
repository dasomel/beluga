import type { Pipeline } from '@beluga-manager/domain-api/schema';
import type { EventNavigationTarget } from './eventNavigation';

export function getStageNavigationTargets(
  serviceId: string,
  serviceIds: ReadonlySet<string>,
  pipelines: readonly Pipeline[],
  preferredPipelineId?: string,
): EventNavigationTarget[] {
  const targets: EventNavigationTarget[] = [];
  if (serviceIds.has(serviceId)) targets.push({ tab: 'services', id: serviceId });

  const matchedPipelines = pipelines.filter((pipeline) =>
    pipeline.stages.some((stage) => stage.serviceId === serviceId),
  );
  const orderedPipelines = preferredPipelineId
    ? [
        ...matchedPipelines.filter((pipeline) => pipeline.id === preferredPipelineId),
        ...matchedPipelines.filter((pipeline) => pipeline.id !== preferredPipelineId),
      ]
    : matchedPipelines;
  const seenPipelineIds = new Set<string>();
  for (const pipeline of orderedPipelines) {
    if (!seenPipelineIds.has(pipeline.id)) {
      targets.push({ tab: 'pipelines', id: pipeline.id, pipelineName: pipeline.name });
      seenPipelineIds.add(pipeline.id);
    }
  }

  return targets;
}
