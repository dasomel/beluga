import { describe, expect, it } from 'vitest';
import type { Resource } from '@beluga-manager/domain-api/schema';
import { buildInfraTopology } from './infraTopology';

function resource(overrides: Partial<Resource> & Pick<Resource, 'id' | 'kind' | 'name'>): Resource {
  return {
    namespace: null,
    status: 'healthy',
    relatedServiceId: null,
    relatedPipelineId: null,
    relatedEventIds: [],
    logsUrl: null,
    ...overrides,
  };
}

describe('buildInfraTopology', () => {
  it('returns an empty graph for no resources', () => {
    expect(buildInfraTopology([])).toEqual({ nodes: [], edges: [] });
  });

  it('links resources to their namespace only, never inferring workload-to-pod edges', () => {
    const { nodes, edges } = buildInfraTopology([
      resource({ id: 'pod', kind: 'Pod', name: 'p-0', namespace: 'ns' }),
      resource({ id: 'ns', kind: 'Namespace', name: 'ns' }),
      resource({ id: 'wl', kind: 'Workload', name: 'w', namespace: 'ns', relatedServiceId: 'svc-x' }),
      resource({ id: 'svc', kind: 'Service', name: 's', namespace: 'ns' }),
      resource({ id: 'pvc', kind: 'PersistentVolumeClaim', name: 'v', namespace: 'ns' }),
    ]);
    expect(nodes.map((node) => node.id)).toEqual(['ns', 'wl', 'pod', 'svc', 'pvc']);
    expect(edges.map((edge) => edge.id)).toEqual(['ns->wl', 'ns->pod', 'ns->svc', 'ns->pvc']);
  });

  it('keeps orphans (null or unknown namespace, duplicate ids) as unlinked nodes without throwing', () => {
    const { nodes, edges } = buildInfraTopology([
      resource({ id: 'a', kind: 'Pod', name: 'a', namespace: 'missing' }),
      resource({ id: 'b', kind: 'Workload', name: 'b', namespace: null }),
      resource({ id: 'b', kind: 'Workload', name: 'b-dup', namespace: null }),
    ]);
    expect(nodes.map((node) => node.id)).toEqual(['b', 'a']);
    expect(edges).toEqual([]);
  });
});
