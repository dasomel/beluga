import { KubeClient, type KubeClientOptions, type KubeReadPort } from "../adapters/kubeClient.js";
export { defaultKubeRequester, type KubeRequest, type KubeRequester } from "../adapters/kubeClient.js";

export const ARGOCD_NAMESPACE = "argocd";
export const ARGOCD_APPS = ["beluga-platform", "beluga-data"] as const;

export interface ArgocdAppStatus {
  name: string;
  syncStatus: string;
  revision: string | undefined;
  healthStatus?: string;
}
export interface ArgocdPort {
  getApplication(name: string): Promise<ArgocdAppStatus>;
}
export class ArgocdError extends Error {
  constructor(message: string) { super(message); this.name = "ArgocdError"; }
}
export type ArgocdReaderOptions = KubeClientOptions;

export class ArgocdReader implements ArgocdPort {
  private readonly client: KubeReadPort;
  constructor(options: ArgocdReaderOptions, client?: KubeReadPort) {
    // D-LIVE-11: retain the reconciler's 5s deadline; cost: slower failed polls.
    // Escape hatch: callers can explicitly override timeoutMs.
    this.client = client ?? new KubeClient({ ...options, timeoutMs: options.timeoutMs ?? 5000 });
  }
  async getApplication(name: string): Promise<ArgocdAppStatus> {
    if (!(ARGOCD_APPS as readonly string[]).includes(name)) throw new ArgocdError("application is not readable");
    try {
      const json = await this.client.getJson<{ status?: { sync?: { status?: string; revision?: string }; health?: { status?: string } } } | null>(
        `/apis/argoproj.io/v1alpha1/namespaces/${ARGOCD_NAMESPACE}/applications/${encodeURIComponent(name)}`,
      );
      const sync = json?.status?.sync;
      if (typeof sync?.status !== "string") throw new ArgocdError("application has no sync status");
      const healthStatus = json?.status?.health?.status;
      return { name, syncStatus: sync.status, revision: typeof sync.revision === "string" ? sync.revision : undefined,
        ...(typeof healthStatus === "string" ? { healthStatus } : {}) };
    } catch (error) {
      throw new ArgocdError(error instanceof Error ? error.message : "unreachable");
    }
  }
}
