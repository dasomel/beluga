import { describe, expect, it } from 'vitest';
import type { Resource, Service } from '@beluga-manager/domain-api/schema';
import {
  COMPOSITION_COMPONENTS,
  COMPOSITION_FLOWS,
  COMPOSITION_FLOW_STYLE,
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
    expect(compositionSummary(states)).toEqual({ service: 0, resources: 0, missing: 0, unobserved: COMPOSITION_COMPONENTS.length });
  });

  it('ignores resources whose ids are not Kubernetes workload ids', () => {
    const states = resolveComposition([], [{ ...resource('kubernetes:iam/Deployment/keycloak'), id: 'k8s-pod-keycloak' }]);
    expect(states.find((state) => state.component.id === 'keycloak')!.source).toBe('unobserved');
  });
});

describe('measured absence vs blind spot', () => {
  const scanned = [resource('kubernetes:streaming/Deployment/flink-cluster')]; // streaming was read

  it('reports a workload absent from a completely read namespace as missing (unavailable)', () => {
    const debezium = resolveComposition([], scanned).find((state) => state.component.id === 'debezium')!;
    expect(debezium.source).toBe('missing');
    expect(debezium.status).toBe('unavailable');
  });

  it('keeps it unobserved when the resource list came with warnings', () => {
    const debezium = resolveComposition([], scanned, undefined, true).find((state) => state.component.id === 'debezium')!;
    expect(debezium.source).toBe('unobserved');
  });

  it('flags whether the component namespace was read completely', () => {
    const states = resolveComposition([], scanned);
    expect(states.find((state) => state.component.id === 'flink')!.namespaceRead).toBe(true);
    expect(states.find((state) => state.component.id === 'keycloak')!.namespaceRead).toBe(false);
    expect(resolveComposition([], scanned, undefined, true).find((state) => state.component.id === 'flink')!.namespaceRead).toBe(false);
  });

  it('keeps components of unread namespaces unobserved', () => {
    expect(resolveComposition([], scanned).find((state) => state.component.id === 'keycloak')!.source).toBe('unobserved');
  });
});

describe('declared flows and layout', () => {
  it('labels consumer requests to Trino as query and draws no Argo CD or Manager edges', () => {
    for (const source of ['superset', 'airflow', 'openmetadata']) {
      expect(COMPOSITION_FLOWS.find((flow) => flow.source === source && flow.target === 'trino')?.kind).toBe('query');
    }
    for (const id of ['argocd', 'manager']) {
      expect(COMPOSITION_FLOWS.some((flow) => flow.source === id || flow.target === id)).toBe(false);
    }
  });

  it("lists Manager's read adapters as declared components instead of edges", () => {
    const manager = COMPOSITION_COMPONENTS.find((component) => component.id === 'manager')!;
    expect(manager.reads).toEqual(['trino', 'lakekeeper', 'flink', 'argocd']);
    const ids = COMPOSITION_COMPONENTS.map((component) => component.id);
    for (const id of manager.reads!) expect(ids).toContain(id);
  });

  it('gives every component its own grid cell', () => {
    const cells = COMPOSITION_COMPONENTS.map((component) => `${component.cell.column},${component.cell.row}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('routes every flow left to right into the very next column (no backwards, skipped or through-node edges)', () => {
    const byId = new Map(COMPOSITION_COMPONENTS.map((component) => [component.id, component] as const));
    for (const flow of COMPOSITION_FLOWS) {
      expect(byId.get(flow.target)!.cell.column, `${flow.source} -> ${flow.target}`).toBe(byId.get(flow.source)!.cell.column + 1);
    }
  });

  it('keeps the data path on one row, from PostgreSQL to SeaweedFS', () => {
    const path = ['postgres', 'debezium', 'kafka', 'flink', 'lakekeeper', 'seaweedfs'];
    const cells = path.map((id) => COMPOSITION_COMPONENTS.find((component) => component.id === id)!.cell);
    expect(new Set(cells.map((cell) => cell.row)).size).toBe(1);
    expect(cells.map((cell) => cell.column)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('gives each flow kind a distinct colour AND a distinct dash pattern (never colour alone)', () => {
    const styles = Object.values(COMPOSITION_FLOW_STYLE);
    expect(new Set(styles.map((style) => style.accent)).size).toBe(styles.length);
    expect(new Set(styles.map((style) => style.dash)).size).toBe(styles.length);
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
