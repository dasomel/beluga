import type { HealthStatus } from "../schema/health.js";
import type { ListMeta, ListWarning } from "../schema/envelope.js";

// healthy는 warning을 만들지 않는다. code는 자유 문자열 필드(schema/envelope.ts)라
// health status를 그대로 대문자로 올려서 쓴다 — 별도 코드 체계를 새로 만들지 않는다.
export function healthWarning(status: HealthStatus, label: string, serviceId: string | null): ListWarning | null {
  if (status === "healthy") {
    return null;
  }
  return {
    code: status.toUpperCase(),
    message: `${label} status is ${status}`,
    serviceId,
  };
}

// warnings는 응답에 실제로 포함되는 data(현재 페이지)를 근거로만 계산한다 — 그래야
// warnings에 등장하는 모든 id가 같은 응답의 data 안에도 존재한다는 불변식이 성립한다.
export function buildListEnvelope<T>(data: T[], meta: ListMeta, warnings: ListWarning[]) {
  return warnings.length > 0 ? { data, meta, warnings } : { data, meta };
}
