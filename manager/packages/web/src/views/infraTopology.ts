import type { Resource, ResourceKind } from '@beluga-manager/domain-api/schema';
import type { EventNavigationTarget } from './eventNavigation';

export interface InfraNode {
  id: string;
  resource: Resource;
  column: number;
  row: number;
}

export interface InfraEdge {
  id: string;
  source: string;
  target: string;
}

const KIND_ORDER: readonly ResourceKind[] = ['Namespace', 'Workload', 'Pod', 'Service', 'Endpoint', 'Job', 'PersistentVolumeClaim'];

// The only resource->resource field in the Resource schema is `namespace`
// (the owning Namespace's name). Workload->Pod, Service->Pod and PVC->Pod links have no backing
// field, so they are intentionally NOT drawn -- uncertain relations are never authoritative.
// Resources whose namespace is null or has no Namespace resource are kept as unlinked nodes.
export function buildInfraTopology(resources: readonly Resource[]): { nodes: InfraNode[]; edges: InfraEdge[] } {
  const namespaceIdByName = new Map<string, string>();
  for (const resource of resources) {
    if (resource.kind === 'Namespace' && !namespaceIdByName.has(resource.name)) {
      namespaceIdByName.set(resource.name, resource.id);
    }
  }

  const rowByKind = new Map<ResourceKind, number>();
  const seen = new Set<string>();
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];
  const ordered = KIND_ORDER.flatMap((kind) => resources.filter((resource) => resource.kind === kind));

  for (const resource of ordered) {
    if (seen.has(resource.id)) continue;
    seen.add(resource.id);
    const row = rowByKind.get(resource.kind) ?? 0;
    rowByKind.set(resource.kind, row + 1);
    nodes.push({ id: resource.id, resource, column: KIND_ORDER.indexOf(resource.kind), row });

    const namespaceId = resource.kind !== 'Namespace' && resource.namespace ? namespaceIdByName.get(resource.namespace) : undefined;
    if (namespaceId) edges.push({ id: `${namespaceId}->${resource.id}`, source: namespaceId, target: resource.id });
  }

  return { nodes, edges };
}

// Exact target the node drill-down button hands to App's navigation: Operations, focused on the resource.
export function getInfraResourceTarget(resource: Pick<Resource, 'id'>): EventNavigationTarget {
  return { tab: 'operations', id: resource.id, resource: true };
}
