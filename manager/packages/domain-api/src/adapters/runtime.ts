// 설정에서 registry와 선택적 Flink REST / Kubernetes 읽기 어댑터를 조립한다.
import { loadFlinkAdapterConfig, loadKubeApiConfig, resolveBaseDomain } from "../config.js";
import { ArgocdReader } from "../sso-change/argocdReader.js";
import { services } from "../stub-data/services.js";
import { FlinkAdapter } from "./flink/adapter.js";
import { KubeClient, type KubeRequester } from "./kubeClient.js";
import { KubeResourceSource } from "./kubeResources.js";
import { KubeEventSource } from "./kubeEvents.js";
import { KubeWorkloadAdapter } from "./kubeWorkload.js";
import type { PipelineAdapter } from "./pipelineAdapter.js";
import { ServiceAdapterRegistry } from "./registry.js";
import { createStubAdapter } from "./stubAdapter.js";

export interface Runtime {
  registry: ServiceAdapterRegistry;
  pipelineAdapter?: PipelineAdapter;
  eventSource?: KubeEventSource;
  resourceSource?: KubeResourceSource;
  fixtures: "stub" | "partial";
}

export function createRuntime(env: Record<string, string | undefined>, fetchImpl?: typeof fetch, requester?: KubeRequester): Runtime {
  const flinkConfig = loadFlinkAdapterConfig(env);
  const kubeConfig = loadKubeApiConfig(env);
  const client = kubeConfig ? new KubeClient({ ...kubeConfig, ...(requester ? { requester } : {}) }) : undefined;
  const flink = flinkConfig ? new FlinkAdapter({ config: flinkConfig, ...(fetchImpl ? { fetchImpl } : {}) }) : undefined;
  const adapters = services.map((svc) => svc.id === "svc-flink" ? flink ?? createStubAdapter(svc)
    : client ? new KubeWorkloadAdapter(svc, client, resolveBaseDomain(env)) : createStubAdapter(svc));
  const eventSource = client && kubeConfig ? new KubeEventSource(client, new ArgocdReader({ ...kubeConfig, ...(requester ? { requester } : {}) })) : undefined;
  return { registry: new ServiceAdapterRegistry(adapters), ...(flink ? { pipelineAdapter: flink } : {}),
    ...(client && eventSource ? { eventSource, resourceSource: new KubeResourceSource(client, eventSource) } : {}),
    fixtures: client || flink ? "partial" : "stub" };
}
