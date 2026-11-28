import type { HealthStatus, Resource, Service } from '@beluga-manager/domain-api/schema';

// "Current composition" perspective (Architecture view).
//
// The component catalog and the edges below are the platform's *declared* design (beluga-platform /
// beluga-data charts, docs/architecture). Manager never observes these flows, so edges are always
// drawn as declared, and a component's status comes only from live Manager data: a registered
// service (GET /api/v1/services) or Kubernetes workloads (GET /api/v1/resources). Components the
// domain-api cannot read (its Kubernetes reader is scoped to a few namespaces) stay "unobserved"
// instead of being shown as healthy -- uncertain facts are never presented as authoritative.

export type CompositionLayerId = 'access' | 'identity' | 'ingest' | 'stream' | 'lake' | 'query' | 'consume' | 'operate';

export const COMPOSITION_LAYERS: readonly CompositionLayerId[] = [
  'access',
  'identity',
  'ingest',
  'stream',
  'lake',
  'query',
  'consume',
  'operate',
];

export interface CompositionComponent {
  id: string;
  name: string;
  layer: CompositionLayerId;
  namespace: string;
  /** `Kind/name` of the workloads that implement the component (Resource ids end with these). */
  workloads: readonly string[];
  /** Registered Manager service, when one exists. */
  serviceId?: string;
}

export type CompositionFlowKind = 'data' | 'query' | 'auth' | 'control';

export interface CompositionFlow {
  source: string;
  target: string;
  kind: CompositionFlowKind;
}

export const COMPOSITION_COMPONENTS: readonly CompositionComponent[] = [
  { id: 'apisix', name: 'APISIX', layer: 'access', namespace: 'platform-system', workloads: ['Deployment/apisix', 'Deployment/apisix-ingress-controller', 'Deployment/apisix-etcd'] },
  { id: 'keycloak', name: 'Keycloak', layer: 'identity', namespace: 'iam', workloads: ['Deployment/keycloak'] },
  { id: 'openldap', name: 'OpenLDAP', layer: 'identity', namespace: 'iam', workloads: ['Deployment/openldap'] },
  { id: 'opa', name: 'OPA', layer: 'identity', namespace: 'iam', workloads: ['Deployment/opa'] },
  { id: 'openfga', name: 'OpenFGA', layer: 'identity', namespace: 'iam', workloads: ['Deployment/openfga'] },
  { id: 'postgres', name: 'PostgreSQL', layer: 'ingest', namespace: 'database', workloads: [] },
  { id: 'debezium', name: 'Debezium', layer: 'ingest', namespace: 'streaming', workloads: ['Deployment/debezium-connect'] },
  { id: 'kafka', name: 'Kafka', layer: 'ingest', namespace: 'streaming', workloads: ['Deployment/strimzi-cluster-operator', 'Deployment/beluga-kafka-entity-operator'], serviceId: 'svc-kafka' },
  { id: 'flink', name: 'Flink', layer: 'stream', namespace: 'streaming', workloads: ['Deployment/flink-cluster', 'Deployment/flink-kubernetes-operator'], serviceId: 'svc-flink' },
  { id: 'lakekeeper', name: 'Lakekeeper', layer: 'lake', namespace: 'lakehouse', workloads: ['Deployment/lakekeeper'], serviceId: 'svc-iceberg' },
  { id: 'seaweedfs', name: 'SeaweedFS', layer: 'lake', namespace: 'storage', workloads: ['StatefulSet/seaweedfs'] },
  { id: 'trino', name: 'Trino', layer: 'query', namespace: 'analytics', workloads: ['Deployment/trino-coordinator', 'Deployment/trino-worker'], serviceId: 'svc-trino' },
  { id: 'superset', name: 'Superset', layer: 'consume', namespace: 'analytics', workloads: ['Deployment/superset'], serviceId: 'svc-superset' },
  { id: 'airflow', name: 'Airflow', layer: 'consume', namespace: 'orchestration', workloads: ['Deployment/airflow-webserver'], serviceId: 'svc-airflow' },
  { id: 'openmetadata', name: 'OpenMetadata', layer: 'consume', namespace: 'governance', workloads: ['Deployment/openmetadata', 'Deployment/opensearch'] },
  { id: 'manager', name: 'Manager', layer: 'operate', namespace: 'platform-system', workloads: ['Deployment/manager-web', 'Deployment/manager-domain-api'] },
  { id: 'observability', name: 'Grafana', layer: 'operate', namespace: 'platform-system', workloads: ['Deployment/grafana', 'StatefulSet/victoria-metrics', 'Deployment/vmalert', 'Deployment/alertmanager'], serviceId: 'svc-observability' },
  { id: 'argocd', name: 'Argo CD', layer: 'operate', namespace: 'argocd', workloads: ['Deployment/argocd-server', 'StatefulSet/argocd-application-controller', 'Deployment/argocd-repo-server'] },
];

export const COMPOSITION_FLOWS: readonly CompositionFlow[] = [
  // Data path: CDC -> Kafka -> Flink -> Iceberg (Lakekeeper + SeaweedFS) -> Trino -> BI/orchestration.
  { source: 'postgres', target: 'debezium', kind: 'data' },
  { source: 'debezium', target: 'kafka', kind: 'data' },
  { source: 'kafka', target: 'flink', kind: 'data' },
  { source: 'flink', target: 'lakekeeper', kind: 'data' },
  { source: 'lakekeeper', target: 'seaweedfs', kind: 'data' },
  { source: 'trino', target: 'lakekeeper', kind: 'data' },
  // Consumers query Trino (request direction).
  { source: 'superset', target: 'trino', kind: 'query' },
  { source: 'airflow', target: 'trino', kind: 'query' },
  { source: 'openmetadata', target: 'trino', kind: 'query' },
  // Identity: gateway SSO, federation and authorization decisions.
  { source: 'apisix', target: 'keycloak', kind: 'auth' },
  { source: 'keycloak', target: 'openldap', kind: 'auth' },
  { source: 'trino', target: 'opa', kind: 'auth' },
  { source: 'lakekeeper', target: 'openfga', kind: 'auth' },
  // Control plane: Manager's read adapters. Argo CD delivers every component, so it has no single edge.
  { source: 'manager', target: 'trino', kind: 'control' },
  { source: 'manager', target: 'lakekeeper', kind: 'control' },
  { source: 'manager', target: 'flink', kind: 'control' },
];

export type CompositionStatusSource = 'service' | 'resources' | 'missing' | 'unobserved';

export interface CompositionNodeState {
  component: CompositionComponent;
  status: HealthStatus;
  source: CompositionStatusSource;
  /** Live resources matched by namespace and `Kind/name`. */
  resources: readonly Resource[];
  service: Service | null;
  endpoint: string | null;
}

const STATUS_SEVERITY: Record<HealthStatus, number> = { healthy: 0, unknown: 1, stale: 2, degraded: 3, unavailable: 4 };

/** Most severe status wins; an empty list is `unknown`. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((worst, status) => (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst] ? status : worst));
}

/** `kubernetes:<ns>/<Kind>/<name>` -> `{ namespace, ref: 'Kind/name' }`; other ids are not Kubernetes workloads. */
function parseResourceRef(resource: Resource): { namespace: string; ref: string } | null {
  const match = /^kubernetes:([^/]+)\/([^/]+)\/(.+)$/.exec(resource.id);
  if (!match) return null;
  return { namespace: match[1]!, ref: `${match[2]}/${match[3]}` };
}

export function resolveComposition(
  services: readonly Service[],
  resources: readonly Resource[],
  components: readonly CompositionComponent[] = COMPOSITION_COMPONENTS,
  /** True when the resources list came with warnings (partial or truncated upstream reads). */
  resourcesIncomplete = false,
): CompositionNodeState[] {
  const servicesById = new Map(services.map((service) => [service.id, service]));
  const resourcesByKey = new Map<string, Resource[]>();
  const reportedNamespaces = new Set<string>();
  for (const resource of resources) {
    const parsed = parseResourceRef(resource);
    if (!parsed) continue;
    reportedNamespaces.add(parsed.namespace);
    const key = `${parsed.namespace}/${parsed.ref}`;
    resourcesByKey.set(key, [...(resourcesByKey.get(key) ?? []), resource]);
  }

  return components.map((component) => {
    const matched = component.workloads.flatMap((ref) => resourcesByKey.get(`${component.namespace}/${ref}`) ?? []);
    const service = component.serviceId ? servicesById.get(component.serviceId) ?? null : null;
    if (service) {
      return { component, status: service.status, source: 'service', resources: matched, service, endpoint: service.endpoint ?? null };
    }
    if (matched.length > 0) {
      return { component, status: worstStatus(matched.map((resource) => resource.status)), source: 'resources', resources: matched, service: null, endpoint: null };
    }
    // Manager read this namespace completely (other workloads were reported, no warnings) and the
    // component's workloads were not among them: a measured absence, not a blind spot.
    if (!resourcesIncomplete && component.workloads.length > 0 && reportedNamespaces.has(component.namespace)) {
      return { component, status: 'unavailable', source: 'missing', resources: [], service: null, endpoint: null };
    }
    return { component, status: 'unknown', source: 'unobserved', resources: [], service: null, endpoint: null };
  });
}

export function compositionSummary(states: readonly CompositionNodeState[]): Record<CompositionStatusSource, number> {
  const summary: Record<CompositionStatusSource, number> = { service: 0, resources: 0, missing: 0, unobserved: 0 };
  for (const state of states) summary[state.source] += 1;
  return summary;
}

/**
 * Two bands of four layer columns, so the diagram stays readable without horizontal scrolling
 * (eight columns at the graph's node width do not fit a normal panel).
 */
export function compositionCell(layer: CompositionLayerId): { column: number; band: number } {
  const index = COMPOSITION_LAYERS.indexOf(layer);
  return { column: index % 4, band: index < 4 ? 0 : 1 };
}
