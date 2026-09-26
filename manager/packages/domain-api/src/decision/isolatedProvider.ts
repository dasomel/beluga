import { decisionResultSchema } from "./types.js";
import type { DecisionContext, DecisionProvider, DecisionResult, TelemetrySnapshot } from "./types.js";

// 이슈 #69 코멘트(Codex 아키텍처 리뷰)의 "장애격리된 백엔드 실행 경계(bulkhead)" 요구사항:
// 어떤 DecisionProvider가 throw/reject하거나, 스키마를 어기는 값을 반환하거나, 시간 budget을
// 넘기더라도 이 boundary는 절대 caller에게 예외를 전파하지 않고 항상 ABSTAIN으로 강등한다.
// abstainReason은 이 상수들로 시작해 grep/로그 파싱으로 원인을 구분할 수 있게 한다("machine
// -readable reason").
export const ISOLATION_TIMEOUT = "ISOLATION_TIMEOUT";
export const ISOLATION_PROVIDER_ERROR = "ISOLATION_PROVIDER_ERROR";
export const ISOLATION_INVALID_SHAPE = "ISOLATION_INVALID_SHAPE";
export const ISOLATION_OVERLOADED = "ISOLATION_OVERLOADED";

// D1: 기본 budget 값.
// reason: 이슈 #69 코멘트의 Gemini 기술조사에서 확인된 Jev(System-1 후보) 지연이 70~500ms —
//         이 슬라이스 시점에 문서화된 가장 느린 System-1 provider의 상한을 기본값으로 삼는다.
// cost:   이보다 본질적으로 느리게 설계된 provider는 caller가 명시적으로 options.budgetMs를
//         올려주지 않으면 항상 TIMEOUT ABSTAIN된다.
// escape hatch: 호출부가 provider별로 budgetMs를 넘겨 재정의한다. 골든 인시던트 데이터셋에서
//         실측 latency SLO가 나오면 이 기본값을 재검토한다.
const DEFAULT_BUDGET_MS = 500;
const DEFAULT_MAX_CONCURRENT = 32;

// 이 boundary 자신이 반환하는 ABSTAIN 결과의 policyVersion. 내부 provider가 실패했기 때문에
// provider 자신의 policyVersion을 알 수 없다 — boundary가 스스로 부여하는 고정값이다.
const ISOLATION_POLICY_VERSION = "isolation-boundary/v1";

export type IsolatedProviderOptions = {
  /** provider.decide()에 허용하는 최대 시간(ms). 기본값은 DEFAULT_BUDGET_MS. */
  budgetMs?: number;
  /** 실행 중 provider 호출 상한. 완료되지 않은 호출은 timeout 뒤에도 슬롯을 점유한다. */
  maxConcurrent?: number;
};

function safeIdentity(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isolationAbstain(
  provider: DecisionProvider,
  ctx: DecisionContext,
  startedAt: number,
  reason: string,
): DecisionResult {
  return decisionResultSchema.parse({
    decision: "ABSTAIN",
    confidence: 0,
    abstained: true,
    abstainReason: reason,
    evidenceRefs: [],
    provider: safeIdentity(provider.id, "unknown-provider"),
    providerVersion: safeIdentity(provider.version, "unknown-version"),
    policyVersion: ISOLATION_POLICY_VERSION,
    decidedAt: ctx.now,
    latencyMs: Date.now() - startedAt,
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * DecisionProvider 하나를 감싸 fault-isolated 실행 경계(bulkhead)를 씌운다(이슈 #69 PoC
 * 재배열 계획의 2단계: "버전화된 decision schema + 장애격리된 백엔드 실행 경계"). 감싸인
 * provider가 무엇을 하든 — throw, reject, 스키마 위반 값 반환, budget 초과 — 이 wrapper는
 * 절대 예외를 던지지 않고 항상 유효한 DecisionResult(대부분 ABSTAIN)를 반환한다.
 *
 * AbortSignal pass-through(이슈 코멘트에서 "provider 인터페이스가 허용하면 고려"): 현재
 * DecisionProvider.decide(input, ctx)와 DecisionContext(types.ts)는 AbortSignal을 받는
 * 자리가 없다. 여기서 신호를 만들어 넘겨도 provider가 이를 확인하지 않으면 취소된 것처럼
 * 보이지만 실제로는 계속 실행 중인 상태가 되어 거짓 안전감을 준다. 인터페이스 자체를 넓히는
 * 것은 이 슬라이스의 범위(types.ts 계약 변경)를 벗어나는 설계 변경이므로, 여기서는 timer
 * 기반 budget으로만 caller를 해방시키고 AbortSignal 확장은 인터페이스가 이를 지원하게 될 때로
 * 미룬다.
 */
export function isolateProvider(provider: DecisionProvider, options: IsolatedProviderOptions = {}): DecisionProvider {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  let activeCalls = 0;

  return {
    id: provider.id,
    version: provider.version,

    async decide(input: TelemetrySnapshot, ctx: DecisionContext): Promise<DecisionResult> {
      const startedAt = Date.now();
      const requestedTimestamp = ctx.now.getTime();
      const fallbackCtx = {
        ...ctx,
        now: new Date(Number.isFinite(requestedTimestamp) ? requestedTimestamp : startedAt),
      };
      const providerCtx = { ...ctx, now: new Date(fallbackCtx.now.getTime()) };
      if (activeCalls >= maxConcurrent) {
        return isolationAbstain(provider, fallbackCtx, startedAt, `${ISOLATION_OVERLOADED}: provider '${provider.id}' 동시 실행 상한(${maxConcurrent})에 도달했다`);
      }
      activeCalls += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // D3: budget 타이머를 provider 호출보다 먼저 등록한다. provider가 내부적으로도
      // setTimeout을 쓰고 그 지연이 budgetMs와 정확히 같을 경우, 같은 tick에 등록된 두
      // 타이머 중 먼저 등록된 쪽이 먼저 발화한다 — 이 순서를 고정해야 "경계값에서 TIMEOUT을
      // 우선한다"는 경계 동작이 결정론적으로 보장된다(escape hatch: 정책이 바뀌면 이 등록
      // 순서를 뒤집어 반대로 tie-break할 것).
      const timeoutMarker = Symbol("isolation-timeout");
      const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMarker), budgetMs);
      });

      // provider.decide()가 동기적으로 throw하더라도 async 래퍼 안에서 호출하면 그 throw는
      // rejected promise로 바뀐다 — 따라서 sync throw와 async reject를 같은 catch 경로에서
      // 통일해서 처리할 수 있다.
      const providerCall = (async () => provider.decide(input, providerCtx))();
      // timeout은 caller를 해방하지만 provider API에는 취소 계약이 없다. 실제 provider 호출이
      // 끝날 때까지 슬롯을 유지해 고장난 provider에 대한 반복 호출이 무한히 쌓이지 않게 한다.
      providerCall.then(
        () => { activeCalls -= 1; },
        () => { activeCalls -= 1; },
      );

      try {
        const outcome = await Promise.race([providerCall, timeoutPromise]);

        if (outcome === timeoutMarker) {
          // budget을 넘긴 provider가 이후에 resolve/reject하더라도 이미 확정된 ABSTAIN 결과에
          // 영향을 주지 않도록 하고, 처리되지 않은 rejection이 프로세스에 새지 않도록
          // no-op catch를 붙여 둔다(D2: leak 방지, cost는 늦은 실패의 로그 손실 — 필요해지면
          // 별도 관측 채널로 옮길 것).
          providerCall.catch(() => {
            /* 이미 TIMEOUT으로 확정됨 — 늦게 도착하는 rejection은 의도적으로 버린다. */
          });
          return isolationAbstain(
            provider,
            fallbackCtx,
            startedAt,
            `${ISOLATION_TIMEOUT}: provider '${provider.id}'가 budget(${budgetMs}ms)을 초과했다`,
          );
        }

        const parsed = decisionResultSchema.safeParse(outcome);
        if (!parsed.success) {
          return isolationAbstain(
            provider,
            fallbackCtx,
            startedAt,
            `${ISOLATION_INVALID_SHAPE}: provider '${provider.id}'의 반환값이 decision schema를 어겼다 — ${parsed.error.message}`,
          );
        }

        return parsed.data;
      } catch (err) {
        return isolationAbstain(
          provider,
          fallbackCtx,
          startedAt,
          `${ISOLATION_PROVIDER_ERROR}: provider '${provider.id}'가 실패했다 — ${describeError(err)}`,
        );
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
