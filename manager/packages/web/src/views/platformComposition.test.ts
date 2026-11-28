import { describe, expect, it } from 'vitest';
import type { Resource, Service } from '@beluga-manager/domain-api/schema';
import {
  COMPOSITION_COMPONENTS,
  COMPOSITION_FLOWS,
  COMPOSITION_LAYERS,
  compositionSummary,
  resolveComposition,
  worstStatus,
} from './platformComposition';

const resource = (id: string, status: Resource['status'] = 'healthy'): Resource => ({
  id,
  kind: id.includes('/Job/') ? 'Job' : 'Workload',
  name: id.split('/').pop()!,
  namespace: id.split(':')[1]!.split('/')[0]!,
  status,
  relatedServiceId: null,
  relatedPipelineId: null,
  relatedEventIds: [],
  logsUrl: null,
});

const service = (id: string, status: Service['status'], endpoint: string | null = null) =>
  ({ id, name: id, type: 'trino', version: null, status, endpoint, capabilities: [], capabilityCategories: [], namespace: null, workloadRef: null, keyMetrics: [], dependencies: [], lastCheckedAt: '2026-11-28T00:00:00.000Z', staleAfterMs: 60000 }) as unknown as Service;

describe('platform composition catalog', () => {
  it('has unique component ids, known layers and flows between declared components only', () => {
    const ids = COMPOSITION_COMPONENTS.map((component) => component.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const component of COMPOSITION_COMPONENTS) expect(COMPOSITION_LAYERS).toContain(component.layer);
    for (const flow of COMPOSITION_FLOWS) {
      expect(ids).toContain(flow.source);
      expect(ids).toContain(flow.target);
      expect(flow.source).not.toBe(flow.target);
    }
    // Every layer is populated, so the diagram has no empty columns.
    for (const layer of COMPOSITION_LAYERS) expect(COMPOSITION_COMPONENTS.some((component) => component.layer === layer)).toBe(true);
  });
});

describe('resolveComposition', () => {
  it('prefers the registered service status and endpoint', () => {
    const states = resolveComposition(
      [service('svc-trino', 'degraded', 'https://trino.local.beluga.internal')],
      [resource('kubernetes:analytics/Deployment/trino-coordinator')],
    );
    const trino = states.find((state) => state.component.id === 'trino')!;
    expect(trino.source).toBe('service');
    expect(trino.status).toBe('degraded');
    expect(trino.endpoint).toBe('https://trino.local.beluga.internal');
    expect(trino.resources.map((r) => r.id)).toEqual(['kubernetes:analytics/Deployment/trino-coordinator']);
  });

  it('falls back to the worst status of matching workloads (namespace + Kind/name)', () => {
    const states = resolveComposition([], [
      resource('kubernetes:streaming/Deployment/debezium-connect', 'healthy'),
      resource('kubernetes:analytics/Deployment/debezium-connect', 'unavailable'), // wrong namespace: ignored
    ]);
    const debezium = states.find((state) => state.component.id === 'debezium')!;
    expect(debezium.source).toBe('resources');
    expect(debezium.status).toBe('healthy');
    expect(debezium.resources).toHaveLength(1);
  });

  it('marks components without any live data as unobserved, never healthy', () => {
    const states = resolveComposition([], []);
    const keycloak = states.find((state) => state.component.id === 'keycloak')!;
    expect(keycloak.source).toBe('unobserved');
    expect(keycloak.status).toBe('unknown');
    expect(compositionSummary(states)).toEqual({ service: 0, resources: 0, unobserved: COMPOSITION_COMPONENTS.length });
  });

  it('ignores resources whose ids are not Kubernetes workload ids', () => {
    const states = resolveComposition([], [{ ...resource('kubernetes:iam/Deployment/keycloak'), id: 'k8s-pod-keycloak' }]);
    expect(states.find((state) => state.component.id === 'keycloak')!.source).toBe('unobserved');
  });
});

describe('worstStatus', () => {
  it('orders healthy < unknown < stale < degraded < unavailable and treats empty as unknown', () => {
    expect(worstStatus([])).toBe('unknown');
    expect(worstStatus(['healthy', 'stale'])).toBe('stale');
    expect(worstStatus(['degraded', 'unavailable', 'healthy'])).toBe('unavailable');
    expect(worstStatus(['healthy'])).toBe('healthy');
  });
});
