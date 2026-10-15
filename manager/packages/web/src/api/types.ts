import type { HealthStatus, ListMeta, ListWarning } from '@beluga-manager/domain-api/schema';

export interface ListEnvelope<T> {
  data: T[];
  meta: ListMeta;
  warnings?: ListWarning[];
}

// packages/domain-api/src/routes/health.ts가 정의하는 DomainApiHealth 응답 모양이다.
// 그 타입은 route 전용이라 schema/index.ts의 공개 ./schema export에는 포함되지 않으므로,
// 공유되는 HealthStatus만 재사용하고 이 최소 봉투는 여기서 직접 선언한다.
export interface DomainApiHealthResponse {
  status: HealthStatus;
  version: string;
}
