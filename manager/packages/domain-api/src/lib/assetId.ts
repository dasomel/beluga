// ADR-0004 D4: 파생 asset id. 변수 segment(catalog/namespace/table/cluster/topic)마다 독립적으로
// percent-encode(`%` -> `%25` 먼저, 그다음 `.` -> `%2E`)한 뒤 리터럴 `.`로 잇는다. 인코딩된
// segment에는 리터럴 `.`가 남지 않으므로 id의 모든 `.`는 segment 경계이고 변환은 가역이다.
import type { DataAssetKind } from "../schema/dataAsset.js";

export function encodeIdSegment(segment: string): string {
  return segment.replaceAll("%", "%25").replaceAll(".", "%2E");
}

// 어댑터(#41/#42) 쪽 역변환: id의 변수 portion을 `.`로 쪼갠 뒤 segment마다 적용한다. 라우트는 id를 opaque로 다룬다.
export function decodeIdSegment(segment: string): string {
  // `%2E`를 먼저 풀고 `%25`를 마지막에 풀어야 "%252E"가 "%2E"(리터럴)로 올바르게 복원된다.
  return segment.replaceAll("%2E", ".").replaceAll("%25", "%");
}

export function deriveAssetId(kind: DataAssetKind, segments: readonly string[]): string {
  return `asset-${kind}-${segments.map(encodeIdSegment).join(".")}`;
}
