import type { Resource } from "../schema/resource.js";
import type { ListWarning } from "../schema/envelope.js";
import type { EventSource } from "./kubeEvents.js";
import type { KubeReadPort } from "./kubeClient.js";
import { PLATFORM_NAMESPACES } from "./kubeWorkload.js";
import type { OverviewSource } from "./overviewSource.js";

export const RESOURCE_COLLECTIONS = [
  { group: "apps/v1", collection: "deployments", kind: "Deployment" },
  { group: "apps/v1", collection: "statefulsets", kind: "StatefulSet" },
  { group: "batch/v1", collection: "jobs", kind: "Job" },
] as const;
interface WorkloadTable {
  kind: "Table";
  columnDefinitions: { name: string }[];
  rows: { cells: unknown[] }[];
  metadata?: { continue?: string };
}
function statusOf(cell: (name: string) => unknown, kind: string): Pick<Resource, "status" | "statusDetail"> {
  // D365-7: Kubernetes 1.36 printer columns are authoritative; absent columns mean unknown.
  // Table has no generation/update information for StatefulSets. Cost: readiness only;
  // escape hatch: a separately reviewed status-only upstream API, never full pod templates.
  if (kind === "Job") {
    const status = cell("Status");
    if (status === "Suspended") return { status: "healthy", statusDetail: "suspended" };
    if (status === "Complete" || status === "Running") return { status: "healthy" };
    if (status === "Failed") return { status: "unavailable" };
    return { status: "unknown" };
  }
  const ready = cell("Ready");
  const match = typeof ready === "string" ? /^(\d+)\/(\d+)$/.exec(ready) : null;
  if (!match) return { status: "unknown" };
  const actual = Number(match[1]);
  const desired = Number(match[2]);
  // D365-8: intentional zero is healthy-idle, not an outage. Cost: optional detail field;
  // escape hatch: introduce a separate idle status if the domain later needs one.
  if (desired === 0) return { status: "healthy", statusDetail: "scaled to zero" };
  const counts = kind === "Deployment" ? [cell("Up-to-date"), cell("Available")] : [];
  if (counts.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) return { status: "unknown" };
  return { status: actual >= desired && counts.every((n) => (n as number) >= desired) ? "healthy" : actual > 0 ? "degraded" : "unavailable" };
}

export class KubeResourceSource implements OverviewSource<Resource> {
  constructor(private readonly client: KubeReadPort, private readonly events: EventSource) {}
  async list() {
    // D365-1: approved namespace-scoped list, no pods/secrets/watch/writes. Cost: bounded
    // inventory can be partial; warnings disclose truncation. Escape hatch: disable KUBE_API_*.
    const targets = PLATFORM_NAMESPACES.flatMap((namespace) => RESOURCE_COLLECTIONS.map((type) => ({ namespace, ...type })));
    const groups = await Promise.allSettled(targets.map(async ({ namespace, group, collection, kind }) => {
      const items: Resource[] = [];
      let continuation: string | undefined;
      for (let page = 0; page < 5; page++) {
        // D365-9: Table + None prevents spec/template/env transfer; RBAC still technically
        // permits reading templates. Cost: fewer health signals; escape hatch: disable KUBE_API_*.
        // Columns verified against kubernetes/kubernetes v1.36.0 pkg/printers/internalversion/printers.go.
        const list = await this.client.getJson<WorkloadTable>(
          `/apis/${group}/namespaces/${namespace}/${collection}?limit=100&includeObject=None${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`,
          "application/json;as=Table;v=v1;g=meta.k8s.io");
        if (list?.kind !== "Table" || !Array.isArray(list.rows) || !Array.isArray(list.columnDefinitions)) throw new Error("malformed resource table");
        for (const row of list.rows) {
          if (!Array.isArray(row.cells)) throw new Error("malformed resource row");
          const cell = (name: string) => row.cells[list.columnDefinitions.findIndex((column) => column.name === name)];
          const name = cell("Name");
          if (typeof name !== "string" || !name) throw new Error("malformed resource name");
          items.push({ id: `kubernetes:${namespace}/${kind}/${name}`, kind: kind === "Job" ? "Job" : "Workload",
            name, namespace, ...statusOf(cell, kind), cpuUsage: null, memoryUsage: null,
            relatedServiceId: null, relatedPipelineId: null, relatedEventIds: [], logsUrl: null });
        }
        continuation = list.metadata?.continue;
        if (!continuation) break;
      }
      return { items, truncated: !!continuation };
    }));
    if (groups.every((group) => group.status === "rejected")) throw new Error("all resource sources failed");
    const warnings: ListWarning[] = groups.flatMap((group, index) => group.status === "rejected" || group.value.truncated
      ? [{ code: group.status === "rejected" ? "UPSTREAM_UNAVAILABLE" : "TRUNCATED", message: `Resource source ${targets[index]!.namespace}/${targets[index]!.collection} incomplete`, serviceId: null }] : []);
    // D365-10: only inventory failures affect proof of absence; event warnings stay in the envelope.
    // Cost: one completeness flag; escape hatch: dedicated resource lookup.
    const inventoryComplete = groups.every((group) => group.status === "fulfilled" && !group.value.truncated);
    const items = groups.flatMap((group) => group.status === "fulfilled" ? group.value.items : []);
    try {
      const batch = await this.events.listEvents();
      warnings.push(...batch.warnings);
      for (const item of items) item.relatedEventIds = batch.events.filter((e) => e.relatedResourceId === item.id).map((e) => e.id);
    } catch {
      warnings.push({ code: "UPSTREAM_UNAVAILABLE", message: "Related resource events unavailable", serviceId: null });
    }
    return { inventoryComplete, items: items.sort((a, b) => a.id.localeCompare(b.id)), warnings };
  }
}
