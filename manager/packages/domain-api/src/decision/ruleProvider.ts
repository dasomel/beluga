import { decisionResultSchema } from "./types.js";
import type { DecisionContext, DecisionProvider, DecisionResult, TelemetrySnapshot } from "./types.js";

const PROVIDER_ID = "rule-provider";
const PROVIDER_VERSION = "0.1.0";
// 이슈 #69 예시 출력의 policyVersion과 동일한 초기값 — 별도 정책 버전 체계가 생기기
// 전까지 이 provider가 참조하는 고정값이다.
const POLICY_VERSION = "v1";
// "안전한 기본값"이지 실제 분류가 아니라는 것을 신호하기 위해 낮게 고정한다(아래
// createRuleProvider의 NORMAL 분기 주석 참고).
const SAFE_DEFAULT_CONFIDENCE = 0.1;

/**
 * 실제 임계값 규칙(예: "CPU > 80% => COMPUTE_BOUND")을 담을 확장점. 이슈 #69 PoC
 * 1단계(골든 인시던트 데이터셋)가 아직 없어 필드·연산자·임계값을 지금 확정하면
 * AGENTS.md가 금지하는 미검증 추정이 된다 — 데이터셋이 생기면 이 타입을 채우고
 * decide()에서 평가할 것. 지금은 어떤 인스턴스도 만들지 않는다.
 */
export type RuleDefinition = {
  readonly id: string;
};

export type RuleProviderOptions = {
  /**
   * 반드시 있어야 하는 signal 이름. 없으면 fail-closed ABSTAIN한다. 이 모듈은 어떤
   * 신호가 "필수"인지 스스로 추정하지 않는다 — provider를 실제로 배선하는 쪽이 자신의
   * 배포 환경에 맞는 목록을 채운다.
   */
  requiredSignals?: readonly string[];
  /** 아직 비어 있는 확장점. RuleDefinition 참고. */
  rules?: readonly RuleDefinition[];
};

// 이 provider 자신의 출력이 스키마를 어기면(코딩 실수 등) 여기서 즉시 던진다 — "잘못된
// enum이나 미등록 evidence reference가 빠져나가지 못한다"는 안전 속성을 컴파일 타임
// 타입뿐 아니라 이 provider의 실제 반환 경로에서도 강제한다.
function abstain(ctx: DecisionContext, startedAt: number, reason: string): DecisionResult {
  return decisionResultSchema.parse({
    decision: "ABSTAIN",
    confidence: 0,
    abstained: true,
    abstainReason: reason,
    evidenceRefs: [],
    provider: PROVIDER_ID,
    providerVersion: PROVIDER_VERSION,
    policyVersion: POLICY_VERSION,
    decidedAt: ctx.now,
    latencyMs: Date.now() - startedAt,
  });
}

/**
 * 결정론적 baseline provider(이슈 #69 1단계). fail-closed ABSTAIN 경로 외에는 골든
 * 인시던트 데이터셋이 생기기 전까지 안전한 기본값(NORMAL, 낮은 확신도)만 반환한다.
 */
export function createRuleProvider(options: RuleProviderOptions = {}): DecisionProvider {
  const requiredSignals = options.requiredSignals ?? [];

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    async decide(input: TelemetrySnapshot, ctx: DecisionContext): Promise<DecisionResult> {
      const startedAt = Date.now();
      const signalEntries = Object.entries(input.signals);

      // 신호가 하나도 없으면 requiredSignals 설정 여부와 무관하게 판단 근거가 전혀
      // 없다 — 이슈의 안전 원칙("missing/stale telemetry가 fail-closed ABSTAIN")의
      // 가장 기본적인 경우다.
      if (signalEntries.length === 0) {
        return abstain(ctx, startedAt, "telemetry snapshot에 signal이 하나도 없다");
      }

      const missingSignal = requiredSignals.find((name) => input.signals[name] === undefined);
      if (missingSignal !== undefined) {
        return abstain(ctx, startedAt, `필수 signal '${missingSignal}'이 snapshot에 없다`);
      }

      const staleEntry = signalEntries.find(
        ([, signal]) => ctx.now.getTime() - signal.observedAt.getTime() > ctx.freshnessPolicy.maxAgeMs,
      );
      if (staleEntry !== undefined) {
        const [name, signal] = staleEntry;
        return abstain(
          ctx,
          startedAt,
          `signal '${name}'의 observedAt(${signal.observedAt.toISOString()})이 freshness 기준` +
            `(maxAgeMs=${ctx.freshnessPolicy.maxAgeMs})을 초과했다`,
        );
      }

      // 골든 인시던트 데이터셋(이슈 #69 PoC 1단계)이 아직 없어 실제 분류 임계값이 없다 —
      // 데이터 없이 임계값을 추정하면 AGENTS.md가 금지하는 미검증 사실 제시가 된다.
      // signal이 전부 있고 신선할 때는 이 안전한 기본값만 반환한다(진짜 분류 능력이 아님).
      return decisionResultSchema.parse({
        decision: "NORMAL",
        confidence: SAFE_DEFAULT_CONFIDENCE,
        abstained: false,
        evidenceRefs: [],
        provider: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        policyVersion: POLICY_VERSION,
        decidedAt: ctx.now,
        latencyMs: Date.now() - startedAt,
      });
    },
  };
}
