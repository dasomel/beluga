// STUB ADAPTER, NOT LIVE UPSTREAM INTEGRATION. stub-data/services.ts의 고정 데이터를
// ServiceAdapter 인터페이스로 그대로 노출한다 — 네트워크 호출 없음.
import type { Service } from "../schema/service.js";
import { services } from "../stub-data/services.js";
import { ServiceAdapterRegistry } from "./registry.js";
import type { ServiceAdapter } from "./types.js";

export function createStubAdapter(svc: Service): ServiceAdapter {
  const { id, name, type, version, status, lastCheckedAt, staleAfterMs, ...metadata } = svc;
  return {
    id,
    name,
    type,
    contractVersion: 1,
    getMetadata: async () => metadata,
    getVersion: async () => version,
    getHealth: async () => ({ status, lastCheckedAt, staleAfterMs }),
  };
}

export function createStubRegistry(source: readonly Service[] = services): ServiceAdapterRegistry {
  return new ServiceAdapterRegistry(source.map(createStubAdapter));
}
