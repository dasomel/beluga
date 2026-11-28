import { describe, expect, it } from 'vitest';
import type { Resource } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from '../components/graph';
import { COMPOSITION_GAP_X, COMPOSITION_GAP_Y, buildCompositionGraph, unreportedWorkloadLabel } from './CompositionPanel';
import { COMPOSITION_COMPONENTS, COMPOSITION_FLOWS, resolveComposition } from './platformComposition';

const t = getTranslations('en-US');
const workload = (id: string): Resource => ({
  id, kind: 'Workload', name: id.split('/').pop()!, namespace: id.split(':')[1]!.split('/')[0]!, status: 'healthy',
  relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null,
});

describe('buildCompositionGraph', () => {
  const states = resolveComposition([], [workload('kubernetes:streaming/Deployment/flink-cluster')]);
  const { nodes, edges } = buildCompositionGraph(states, t);

  it('draws every component and every declared flow', () => {
    expect(nodes.map((node) => node.id)).toEqual(COMPOSITION_COMPONENTS.map((component) => component.id));
    expect(edges).toHaveLength(COMPOSITION_FLOWS.length);
  });

  it('gives unobserved components no status (never implied healthy) and missing ones a status', () => {
    const keycloak = nodes.find((node) => node.id === 'keycloak')!;
    expect(keycloak.status).toBeUndefined();
    expect(keycloak.detail).toBe(t.architecture.compositionUnobserved);
    const debezium = nodes.find((node) => node.id === 'debezium')!;
    expect(debezium.status).toBe('unavailable');
    expect(debezium.detail).toBe(t.architecture.compositionSources.missing);
    expect(nodes.find((node) => node.id === 'flink')!.status).toBe('healthy');
  });

  it('draws declared flows dashed, never animated, coloured by kind and without canvas labels', () => {
    for (const edge of edges) {
      expect(edge.dashed).toBe(true);
      expect(edge.animated).toBe(false);
      expect(edge.accent).toBeTruthy();
      // The kind stays in the accessible name / table view.
      expect(edge.label).toBeTruthy();
      expect(edge.hideLabel).toBe(true);
    }
    expect(edges.find((edge) => edge.id === 'superset->trino')!.accent).toBe('violet');
    expect(edges.find((edge) => edge.id === 'kafka->flink')!.accent).toBe('blue');
    expect(edges.find((edge) => edge.id === 'trino->opa')!.accent).toBe('amber');
  });

  it('places nodes on the catalog grid: six columns, four rows', () => {
    for (const component of COMPOSITION_COMPONENTS) {
      expect(nodes.find((node) => node.id === component.id)!.position).toEqual({
        x: component.cell.column * (GRAPH_NODE_WIDTH + COMPOSITION_GAP_X),
        y: component.cell.row * (GRAPH_NODE_HEIGHT + COMPOSITION_GAP_Y),
      });
    }
    expect(Math.max(...COMPOSITION_COMPONENTS.map((component) => component.cell.column))).toBe(5);
    expect(Math.max(...COMPOSITION_COMPONENTS.map((component) => component.cell.row))).toBe(3);
  });
});

describe('unreportedWorkloadLabel', () => {
  it('says "not reported" only for a completely read namespace, otherwise "not observed"', () => {
    const states = resolveComposition([], [workload('kubernetes:analytics/Deployment/trino-coordinator')]);
    const trino = states.find((state) => state.component.id === 'trino')!; // trino-worker absent, analytics read
    const keycloak = states.find((state) => state.component.id === 'keycloak')!; // iam never read
    expect(unreportedWorkloadLabel(trino, t)).toBe(t.architecture.compositionNotReported);
    expect(unreportedWorkloadLabel(keycloak, t)).toBe(t.architecture.compositionUnobserved);
    const incomplete = resolveComposition([], [workload('kubernetes:analytics/Deployment/trino-coordinator')], undefined, true);
    expect(unreportedWorkloadLabel(incomplete.find((state) => state.component.id === 'trino')!, t)).toBe(t.architecture.compositionUnobserved);
  });
});
