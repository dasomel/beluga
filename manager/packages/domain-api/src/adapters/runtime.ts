// 설정에서 registry + 선택적 라이브 어댑터를 조립한다. Flink 설정이 없으면 순수 stub 구성이다(D1).
import { loadFlinkAdapterConfig } from "../config.js";
import { services } from "../stub-data/services.js";
import { FlinkAdapter } from "./flink/adapter.js";
import type { PipelineAdapter } from "./pipelineAdapter.js";
import { ServiceAdapterRegistry } from "./registry.js";
import { createStubAdapter } from "./stubAdapter.js";

export interface Runtime {
  registry: ServiceAdapterRegistry;
  pipelineAdapter?: PipelineAdapter;
}

export function createRuntime(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Runtime {
  const flinkConfig = loadFlinkAdapterConfig(env);
  if (!flinkConfig) {
    return { registry: new ServiceAdapterRegistry(services.map(createStubAdapter)) };
  }
  const flink = new FlinkAdapter({ config: flinkConfig, ...(fetchImpl ? { fetchImpl } : {}) });
  // stub의 svc-flink를 같은 자리(등록 순서 유지)에서 라이브 어댑터로 교체한다.
  const adapters = services.map((svc) => (svc.id === flink.id ? flink : createStubAdapter(svc)));
  return { registry: new ServiceAdapterRegistry(adapters), pipelineAdapter: flink };
}
