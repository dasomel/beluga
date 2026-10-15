// ADR-0002: 업스트림 API 차이는 Integration Adapter 계층 안에 격리한다. 이 파일은 domain 계층이
// 보는 유일한 계약이며, 업스트림 고유 타입은 이 경계를 넘지 않는다. 실제 네트워크 어댑터는
// 이 인터페이스를 구현하는 별도 모듈(#41)로 추가한다 — 여기에는 구현이 없다.
import type { HealthStatus } from "../schema/health.js";
import type { Service, ServiceType } from "../schema/service.js";

// 어댑터 계약 버전. 인터페이스 모양이 호환되지 않게 바뀔 때만 올린다.
export const SUPPORTED_ADAPTER_CONTRACT_VERSIONS: readonly number[] = [1];

// 정적 식별/기능 정보 (Service 중 health/version을 제외한 부분).
export type AdapterMetadata = Pick<
  Service,
  "endpoint" | "capabilities" | "capabilityCategories" | "namespace" | "workloadRef" | "keyMetrics" | "dependencies"
>;

export interface AdapterHealth {
  status: HealthStatus;
  lastCheckedAt: string;
  staleAfterMs: number;
}

export interface ServiceAdapter {
  readonly id: string;
  readonly name: string;
  readonly type: ServiceType;
  readonly contractVersion: number;
  getMetadata(): Promise<AdapterMetadata>;
  // 업스트림 버전. 알 수 없으면 null.
  getVersion(): Promise<string | null>;
  getHealth(): Promise<AdapterHealth>;
}
