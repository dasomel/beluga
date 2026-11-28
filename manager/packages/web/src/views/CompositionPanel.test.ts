import { describe, expect, it } from 'vitest';
import type { Resource } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { GRAPH_GAP_X, GRAPH_NODE_WIDTH } from '../components/graph';
import { buildCompositionGraph, unreportedWorkloadLabel } from './CompositionPanel';
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

  it('draws declared flows dashed and never animated', () => {
    for (const edge of edges) {
      expect(edge.dashed).toBe(true);
      expect(edge.animated).toBe(false);
      expect(edge.label).toBeTruthy();
    }
  });

  it('keeps the layout four columns wide (fits without horizontal scrolling)', () => {
    const maxX = Math.max(...nodes.map((node) => node.position!.x));
    expect(maxX).toBe(3 * (GRAPH_NODE_WIDTH + GRAPH_GAP_X));
    // Second band sits strictly below the first band.
    const firstBand = nodes.filter((node) => ['apisix', 'keycloak', 'openldap', 'opa', 'openfga', 'postgres', 'debezium', 'kafka', 'flink'].includes(node.id));
    const secondBand = nodes.filter((node) => !firstBand.includes(node));
    expect(Math.min(...secondBand.map((node) => node.position!.y))).toBeGreaterThan(Math.max(...firstBand.map((node) => node.position!.y)));
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
