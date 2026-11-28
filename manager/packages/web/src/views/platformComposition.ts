import type { HealthStatus, Resource, Service } from '@beluga-manager/domain-api/schema';
import type { GraphEdgeAccent } from '../components/graph/theme';

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
  /**
   * Hand-placed grid cell. Columns are chosen so that every declared flow goes from column c to
   * column c + 1 (nodes take edges on the left and emit them on the right), so no edge runs
   * backwards, skips a column or passes through a node. Tests enforce this.
   */
  cell: { column: number; row: number };
  /** Declared read adapters (Manager), shown in the detail panel, not as edges; each runs only when configured. */
  reads?: readonly string[];
}

export type CompositionFlowKind = 'data' | 'query' | 'auth';

/**
 * Edge style per flow kind. The canvas shows no text labels, so each kind gets both a colour and its
 * own dash pattern (never colour alone, WCAG 1.4.1); the legend draws the same swatches.
 */
export const COMPOSITION_FLOW_STYLE: Record<CompositionFlowKind, { accent: GraphEdgeAccent; dash: string }> = {
  data: { accent: 'blue', dash: '8,4' },
  query: { accent: 'pink', dash: '2,4' },
  auth: { accent: 'amber', dash: '10,4,2,4' },
};

export interface CompositionFlow {
  source: string;
  target: string;
  kind: CompositionFlowKind;
}

export const COMPOSITION_COMPONENTS: readonly CompositionComponent[] = [
  { id: 'apisix', name: 'APISIX', layer: 'access', namespace: 'platform-system', workloads: ['Deployment/apisix', 'Deployment/apisix-ingress-controller', 'Deployment/apisix-etcd'], cell: { column: 3, row: 2 } },
  { id: 'keycloak', name: 'Keycloak', layer: 'identity', namespace: 'iam', workloads: ['Deployment/keycloak'], cell: { column: 4, row: 2 } },
  { id: 'openldap', name: 'OpenLDAP', layer: 'identity', namespace: 'iam', workloads: ['Deployment/openldap'], cell: { column: 5, row: 2 } },
  { id: 'opa', name: 'OPA', layer: 'identity', namespace: 'iam', workloads: ['Deployment/opa'], cell: { column: 4, row: 1 } },
  { id: 'openfga', name: 'OpenFGA', layer: 'identity', namespace: 'iam', workloads: ['Deployment/openfga'], cell: { column: 5, row: 1 } },
  { id: 'postgres', name: 'PostgreSQL', layer: 'ingest', namespace: 'database', workloads: [], cell: { column: 0, row: 0 } },
  { id: 'debezium', name: 'Debezium', layer: 'ingest', namespace: 'streaming', workloads: ['Deployment/debezium-connect'], cell: { column: 1, row: 0 } },
  { id: 'kafka', name: 'Kafka', layer: 'ingest', namespace: 'streaming', workloads: ['Deployment/strimzi-cluster-operator', 'Deployment/beluga-kafka-entity-operator'], serviceId: 'svc-kafka', cell: { column: 2, row: 0 } },
  { id: 'flink', name: 'Flink', layer: 'stream', namespace: 'streaming', workloads: ['Deployment/flink-cluster', 'Deployment/flink-kubernetes-operator'], serviceId: 'svc-flink', cell: { column: 3, row: 0 } },
  { id: 'lakekeeper', name: 'Lakekeeper', layer: 'lake', namespace: 'lakehouse', workloads: ['Deployment/lakekeeper'], serviceId: 'svc-iceberg', cell: { column: 4, row: 0 } },
  { id: 'seaweedfs', name: 'SeaweedFS', layer: 'lake', namespace: 'storage', workloads: ['StatefulSet/seaweedfs'], cell: { column: 5, row: 0 } },
  { id: 'trino', name: 'Trino', layer: 'query', namespace: 'analytics', workloads: ['Deployment/trino-coordinator', 'Deployment/trino-worker'], serviceId: 'svc-trino', cell: { column: 3, row: 1 } },
  { id: 'superset', name: 'Superset', layer: 'consume', namespace: 'analytics', workloads: ['Deployment/superset'], serviceId: 'svc-superset', cell: { column: 2, row: 1 } },
  { id: 'airflow', name: 'Airflow', layer: 'consume', namespace: 'orchestration', workloads: ['Deployment/airflow-webserver'], serviceId: 'svc-airflow', cell: { column: 2, row: 2 } },
  { id: 'openmetadata', name: 'OpenMetadata', layer: 'consume', namespace: 'governance', workloads: ['Deployment/openmetadata', 'Deployment/opensearch'], cell: { column: 2, row: 3 } },
  { id: 'manager', name: 'Manager', layer: 'operate', namespace: 'platform-system', workloads: ['Deployment/manager-web', 'Deployment/manager-domain-api'], cell: { column: 0, row: 1 }, reads: ['trino', 'lakekeeper', 'flink', 'argocd'] },
  { id: 'observability', name: 'Grafana', layer: 'operate', namespace: 'platform-system', workloads: ['Deployment/grafana', 'StatefulSet/victoria-metrics', 'Deployment/vmalert', 'Deployment/alertmanager'], serviceId: 'svc-observability', cell: { column: 1, row: 1 } },
  { id: 'argocd', name: 'Argo CD', layer: 'operate', namespace: 'argocd', workloads: ['Deployment/argocd-server', 'StatefulSet/argocd-application-controller', 'Deployment/argocd-repo-server'], cell: { column: 0, row: 2 } },
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
  // Manager's read adapters are listed in its detail panel (`reads`), and Argo CD delivers every
  // component, so neither gets edges: they would cross the whole diagram without adding a flow.
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
  /** Manager read the component's namespace completely, so an unmatched workload is a measured absence. */
  namespaceRead: boolean;
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
  /** True when the resources list is not complete: list warnings (partial upstream reads) or a truncated page. */
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
    const namespaceRead = !resourcesIncomplete && reportedNamespaces.has(component.namespace);
    const matched = component.workloads.flatMap((ref) => resourcesByKey.get(`${component.namespace}/${ref}`) ?? []);
    const service = component.serviceId ? servicesById.get(component.serviceId) ?? null : null;
    if (service) {
      return { component, status: service.status, source: 'service', resources: matched, service, endpoint: service.endpoint ?? null, namespaceRead };
    }
    if (matched.length > 0) {
      return { component, status: worstStatus(matched.map((resource) => resource.status)), source: 'resources', resources: matched, service: null, endpoint: null, namespaceRead };
    }
    // Manager read this namespace completely (other workloads were reported, no warnings) and the
    // component's workloads were not among them: a measured absence, not a blind spot.
    if (namespaceRead && component.workloads.length > 0) {
      return { component, status: 'unavailable', source: 'missing', resources: [], service: null, endpoint: null, namespaceRead };
    }
    return { component, status: 'unknown', source: 'unobserved', resources: [], service: null, endpoint: null, namespaceRead };
  });
}

export function compositionSummary(states: readonly CompositionNodeState[]): Record<CompositionStatusSource, number> {
  const summary: Record<CompositionStatusSource, number> = { service: 0, resources: 0, missing: 0, unobserved: 0 };
  for (const state of states) summary[state.source] += 1;
  return summary;
}

