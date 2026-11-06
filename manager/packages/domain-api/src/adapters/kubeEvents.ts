import type { ListWarning } from "../schema/envelope.js";
import type { Event } from "../schema/event.js";
import { ARGOCD_APPS, type ArgocdPort } from "../sso-change/argocdReader.js";
import type { KubeReadPort } from "./kubeClient.js";
import { PLATFORM_NAMESPACES } from "./kubeWorkload.js";

interface KubeEvent {
  metadata?: { uid?: string; name?: string; creationTimestamp?: string };
  lastTimestamp?: string;
  eventTime?: string;
  series?: { lastObservedTime?: string };
  type?: string;
  reason?: string;
  message?: string;
  involvedObject?: { kind?: string; namespace?: string; name?: string };
}
export interface EventBatch { events: Event[]; warnings: ListWarning[] }
export interface EventSource { listEvents(): Promise<EventBatch> }
const MAX_EVENTS = 100;

export class KubeEventSource implements EventSource {
  constructor(private readonly client: KubeReadPort, private readonly argocd: ArgocdPort) {}

  async listEvents(): Promise<EventBatch> {
    // D-LIVE-4: bound each namespace request and the merged result; no watch or cluster-wide list.
    // Cost: this is a recent bounded sample, not an event archive. Escape hatch: a dedicated event store.
    const sources = [...PLATFORM_NAMESPACES.map((ns) => `kubernetes:${ns}`), ...ARGOCD_APPS.map((app) => `argocd:${app}`)];
    const groups = await Promise.allSettled([
      ...PLATFORM_NAMESPACES.map(async (namespace): Promise<Event[]> => {
        const result: Event[] = [];
        let continuation: string | undefined;
        // Read a bounded number of pages (API list order is not chronological), then sort the sample.
        for (let page = 0; page < 5; page++) {
          const query = `limit=${MAX_EVENTS}${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`;
          const list = await this.client.getJson<{ items: KubeEvent[]; metadata?: { continue?: string } }>(`/api/v1/namespaces/${namespace}/events?${query}`);
          if (!Array.isArray(list?.items)) throw new Error("malformed event list");
          for (const item of list.items) {
            const timestamp = item.series?.lastObservedTime ?? item.lastTimestamp ?? item.eventTime ?? item.metadata?.creationTimestamp;
            const millis = timestamp ? Date.parse(timestamp) : NaN;
            if (!Number.isFinite(millis) || !item.metadata?.uid) continue;
            const ref = item.involvedObject;
            result.push({ id: `kube-event-${item.metadata.uid}`, timestamp: new Date(millis).toISOString(),
              severity: item.type === "Warning" ? "warning" : "info", message: item.message || item.reason || "Kubernetes event",
              relatedServiceId: null, relatedPipelineId: null,
              // Upstream resource reference; does not assert membership in the fixture /resources inventory.
              relatedResourceId: ref?.kind && ref.name ? `kubernetes:${ref.namespace ?? namespace}/${ref.kind}/${ref.name}` : null,
              source: "kubernetes" });
          }
          continuation = list.metadata?.continue;
          if (!continuation) break;
        }
        return result;
      }),
      ...ARGOCD_APPS.map(async (name): Promise<Event[]> => {
        const app = await this.argocd.getApplication(name);
        if (app.syncStatus === "Synced" && app.healthStatus === "Healthy") return [];
        return [{ id: `argocd-${name}`, timestamp: new Date().toISOString(), severity: "warning",
          message: `ArgoCD Application ${name}: sync=${app.syncStatus}, health=${app.healthStatus ?? "unknown"} (current observation)`,
          relatedServiceId: null, relatedPipelineId: null, relatedResourceId: `kubernetes:argocd/Application/${name}`, source: "service" }];
      }),
    ]);
    // D-LIVE-8: isolate failed sources, including successful empty lists. Cost: partial
    // sample; warnings identify missing sources. Escape hatch: retry on the next poll.
    if (groups.every((group) => group.status === "rejected")) throw new Error("all event sources failed");
    const events = groups.flatMap((group) => group.status === "fulfilled" ? group.value : []);
    const warnings = groups.flatMap((group, index): ListWarning[] => group.status === "rejected"
      ? [{ code: "UPSTREAM_UNAVAILABLE", message: `Event source ${sources[index]} unavailable`, serviceId: null }] : []);
    return { events: events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, MAX_EVENTS), warnings };
  }
}
