import type { QueryHistoryEntry } from "../schema/queryHistory.js";

// 결과는 adapter의 가시성 범위 내 upstream snapshot이다. 영구 이력 저장소가 아니다.
// D2: 별도 read capability로 ServiceAdapter v1 호환성을 유지한다. 주입 비용만 들며
// 실제 Trino/auth adapter가 준비되면 createApp의 두 번째 인자로 연결할 수 있다.
export interface QueryHistorySnapshot {
  entries: readonly QueryHistoryEntry[];
  // true when the upstream held more rows than `entries` exposes (a silent cut would misstate the history).
  truncated: boolean;
  upstreamCount?: number;
}

export interface QueryHistoryAdapter {
  listQueryHistory(): Promise<readonly QueryHistoryEntry[]>;
  // Optional richer read; the route prefers it when present so truncation can be reported as a warning.
  readSnapshot?(): Promise<QueryHistorySnapshot>;
}
