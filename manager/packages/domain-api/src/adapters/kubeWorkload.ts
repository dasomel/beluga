import type { Service } from "../schema/service.js";
import type { KubeReadPort } from "./kubeClient.js";
import type { AdapterHealth, AdapterMetadata, ServiceAdapter } from "./types.js";

interface WorkloadTarget { namespace: string; resource: "deployments" | "kafkas"; names: string[]; optionalNames?: string[] }
// D-LIVE-2: chart-owned identities, never inferred from fixture namespaces. Cost: keep map aligned with charts;
// escape hatch: change these targets when the owning chart changes. Paths relative to repo root:
// The manager-live-reader Role resourceNames are checked against this map by tests/test_manager_live_rbac.py.
export const WORKLOADS: Record<string, WorkloadTarget> = {
  // gitops/charts/beluga-data/templates/06-trino.yaml:247-260,432-459 (workerEnabled is optional)
  "svc-trino": { namespace: "analytics", resource: "deployments", names: ["trino-coordinator", "trino-worker"], optionalNames: ["trino-worker"] },
  // gitops/charts/beluga-data/templates/07-airflow.yaml:115-127 (standalone runs scheduler in same pod)
  "svc-airflow": { namespace: "orchestration", resource: "deployments", names: ["airflow-webserver"] },
  // gitops/charts/beluga-data/templates/04-lakekeeper.yaml:62-76
  "svc-iceberg": { namespace: "lakehouse", resource: "deployments", names: ["lakekeeper"] },
  // gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:3-41 (KRaft node pools, not a StatefulSet)
  "svc-kafka": { namespace: "streaming", resource: "kafkas", names: ["beluga-kafka"] },
  // gitops/charts/beluga-data/templates/08-superset.yaml:73-87
  "svc-superset": { namespace: "analytics", resource: "deployments", names: ["superset"] },
};
export const PLATFORM_NAMESPACES = [...new Set(Object.values(WORKLOADS).map((target) => target.namespace))];

interface Workload {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number; observedGeneration?: number; conditions?: { type?: string; status?: string }[] };
}
interface Snapshot { status: Service["status"]; ready: number; desired: number; detail?: string }

export class KubeWorkloadAdapter implements ServiceAdapter {
  readonly contractVersion = 1;
  readonly id: string;
  readonly name: string;
  readonly type: Service["type"];
  private pending?: Promise<Snapshot>;
  constructor(private readonly service: Service, private readonly client: KubeReadPort, private readonly baseDomain: string) {
    this.id = service.id; this.name = service.name; this.type = service.type;
  }

  // Share only concurrent registry metadata/health reads; subsequent requests always fetch fresh state.
  private snapshot(): Promise<Snapshot> {
    if (!this.pending) {
      const pending = this.read();
      this.pending = pending;
      void pending.finally(() => { if (this.pending === pending) this.pending = undefined; });
    }
    return this.pending;
  }

  private async read(): Promise<Snapshot> {
    // gitops/charts/beluga-platform/templates/platform-services.yaml:8-23 defines only a Grafana Service, no workload.
    if (this.id === "svc-observability") return { status: "unavailable", ready: 0, desired: 0, detail: "not deployed: no observability workload in gitops/charts" };
    try {
      if (this.id === "svc-kubernetes") {
        const ready = (await this.client.getText("/readyz")).trim() === "ok";
        return { status: ready ? "healthy" : "unknown", ready: ready ? 1 : 0, desired: 1 };
      }
      const target = WORKLOADS[this.id]!;
      const states = await Promise.all(target.names.map(async (name) => {
        const group = target.resource === "kafkas" ? "kafka.strimzi.io/v1" : "apps/v1";
        try {
          const obj = await this.client.getJson<Workload>(`/apis/${group}/namespaces/${target.namespace}/${target.resource}/${name}`);
          if (!obj || !obj.spec) throw new Error("malformed workload");
          const current = obj.metadata?.generation === undefined || (obj.status?.observedGeneration ?? -1) >= obj.metadata.generation;
          if (target.resource === "kafkas") {
            // Strimzi readiness is authoritative for its node pools. Counts are CRs, not invented broker replicas.
            return { ready: current && obj.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ? 1 : 0, desired: 1, missing: false };
          }
          const desired = obj.spec.replicas ?? 1;
          // D-LIVE-7: old ReplicaSet readiness cannot complete a rollout. Cost: conservative
          // counts during transitions; escape hatch: inspect Deployment conditions upstream.
          const counts = [obj.status?.readyReplicas ?? 0, obj.status?.updatedReplicas ?? 0, obj.status?.availableReplicas ?? 0];
          if (counts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("malformed replica counts");
          const ready = current ? Math.min(...counts) : 0;
          if (!Number.isInteger(desired) || desired < 0 || !Number.isInteger(ready) || ready < 0) throw new Error("malformed replica counts");
          return { ready: Math.min(ready, desired), desired, missing: false };
        } catch (error) {
          if (error instanceof Error && error.message === "http-404") {
            // The chart permits a coordinator-only profile: an absent optional worker has no desired replicas.
            return { ready: 0, desired: 0, missing: !target.optionalNames?.includes(name) };
          }
          throw error;
        }
      }));
      const ready = states.reduce((sum, s) => sum + s.ready, 0);
      const desired = states.reduce((sum, s) => sum + s.desired, 0);
      const missing = states.some((s) => s.missing);
      return { ready, desired, status: ready === 0 ? "unavailable" : !missing && ready === desired ? "healthy" : "degraded",
        ...(missing ? { detail: "not deployed: one or more chart workloads missing" } : desired === 0 ? { detail: "scaled to zero" } : {}) };
    } catch {
      return { status: "unknown", ready: 0, desired: 0, detail: "workload status unavailable" };
    }
  }

  async getMetadata(): Promise<AdapterMetadata> {
    const result = await this.snapshot();
    const target = WORKLOADS[this.id];
    const label = { "svc-trino": "trino", "svc-airflow": "airflow", "svc-iceberg": "catalog", "svc-superset": "superset" }[this.id];
    return {
      endpoint: label ? `https://${label}.${this.baseDomain}` : null,
      capabilities: this.service.capabilities, capabilityCategories: this.service.capabilityCategories,
      // Fixture dependency edges are not live discovery evidence.
      dependencies: [],
      namespace: target?.namespace ?? null,
      workloadRef: target ? `${target.resource}/${target.names.join(",")}` : null,
      keyMetrics: [
        ...(result.status === "unknown" ? [] : [
          { name: "ready", value: String(result.ready), unit: target?.resource === "kafkas" ? "CRs" : this.id === "svc-kubernetes" ? "probe" : "replicas" },
          { name: "desired", value: String(result.desired), unit: target?.resource === "kafkas" ? "CRs" : this.id === "svc-kubernetes" ? "probe" : "replicas" },
        ]),
        ...(result.detail ? [{ name: "detail", value: result.detail, unit: null }] : []),
      ],
    };
  }
  async getVersion(): Promise<null> { return null; }
  async getHealth(): Promise<AdapterHealth> {
    const { status } = await this.snapshot();
    return { status, lastCheckedAt: new Date().toISOString(), staleAfterMs: 30_000 };
  }
}
