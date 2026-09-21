import { z } from "zod";

// 이슈 #69(System-1 Fast Decision Layer) 1단계 슬라이스의 provider-neutral 계약.
// Rules/LocalSmallModel/Jev 중 어떤 provider를 붙이더라도 이 형태로 호출된다.
export const decisionSchema = z.enum([
  "NORMAL",
  "COMPUTE_BOUND",
  "MEMORY_BOUND",
  "STORAGE_BOUND",
  "NETWORK_BOUND",
  "QUERY_PROBLEM",
  "ESCALATE",
  "ABSTAIN",
]);

export const telemetrySignalSchema = z.strictObject({
  value: z.union([z.number(), z.string(), z.boolean()]),
  observedAt: z.date(),
});

// 이슈 본문의 "입력 후보" 목록은 최종 목록이 아니라고 명시한다 — 오늘 존재하는 정확한
// 메트릭 이름을 여기서 고정하면 그 자체가 미검증 추정이 된다. Trino/K8s/Storage/Network
// 어떤 신호든 이름-값 쌍으로 담을 수 있게 열어 둔다.
export const telemetrySnapshotSchema = z.strictObject({
  snapshotId: z.string().min(1),
  signals: z.record(z.string(), telemetrySignalSchema),
});

export const decisionContextSchema = z.strictObject({
  now: z.date(),
  freshnessPolicy: z.strictObject({
    maxAgeMs: z.number().nonnegative(),
  }),
  correlationId: z.string().min(1),
});

// Codex 아키텍처 리뷰(이슈 #69 코멘트): evidenceRefs는 불투명 문자열이 아니라 검증
// 가능한 불변 레코드여야 한다 — source/관측시각/수집시각/freshness deadline/content
// hash 없이는 이 근거가 최신이고 무결한지 판정할 수 없다.
export const evidenceRefSchema = z.strictObject({
  source: z.string().min(1),
  observedAt: z.date(),
  ingestedAt: z.date(),
  freshnessDeadline: z.date(),
  contentHash: z.string().min(1),
});

export const decisionResultSchema = z.strictObject({
  decision: decisionSchema,
  confidence: z.number().min(0).max(1),
  abstained: z.boolean(),
  abstainReason: z.string().min(1).optional(),
  evidenceRefs: z.array(evidenceRefSchema),
  provider: z.string().min(1),
  providerVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  decidedAt: z.date(),
  latencyMs: z.number().nonnegative(),
});

export type Decision = z.infer<typeof decisionSchema>;
export type TelemetrySignal = z.infer<typeof telemetrySignalSchema>;
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;
export type DecisionContext = z.infer<typeof decisionContextSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;

// decide()는 동작 계약(메서드)이라 Zod 값 스키마로 표현할 수 없다 — 위 스키마들이
// decide()가 주고받는 값의 형태를 검증하고, 이 인터페이스는 컴파일 타임 계약으로 남긴다.
export interface DecisionProvider {
  readonly id: string;
  readonly version: string;
  decide(input: TelemetrySnapshot, ctx: DecisionContext): Promise<DecisionResult>;
}
