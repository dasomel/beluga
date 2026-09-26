import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isolateProvider } from "../src/decision/isolatedProvider.js";
import {
  decisionResultSchema,
  type DecisionContext,
  type DecisionProvider,
  type DecisionResult,
  type TelemetrySnapshot,
} from "../src/decision/types.js";

function contextAt(now: Date, maxAgeMs = 60_000): DecisionContext {
  return { now, freshnessPolicy: { maxAgeMs }, correlationId: "corr-iso-1" };
}

function snapshotAt(now: Date): TelemetrySnapshot {
  return { snapshotId: "snap-iso-1", signals: { cpu_pct: { value: 10, observedAt: now } } };
}

function validResult(now: Date): DecisionResult {
  return decisionResultSchema.parse({
    decision: "NORMAL",
    confidence: 0.1,
    abstained: false,
    evidenceRefs: [],
    provider: "fake-provider",
    providerVersion: "1.0.0",
    policyVersion: "v1",
    decidedAt: now,
    latencyMs: 3,
  });
}

// 지정한 지연(delayMs) 후 result(또는 error)로 resolve/reject하는 fake provider. fake timer로
// 정확한 시점을 제어하기 위해 provider 내부도 setTimeout을 쓴다.
function delayedProvider(id: string, delayMs: number, outcome: { result: unknown } | { error: unknown }): DecisionProvider {
  return {
    id,
    version: "1.0.0",
    decide(): Promise<DecisionResult> {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if ("error" in outcome) {
            reject(outcome.error);
          } else {
            resolve(outcome.result as DecisionResult);
          }
        }, delayMs);
      });
    },
  };
}

function syncThrowingProvider(id: string): DecisionProvider {
  return {
    id,
    version: "1.0.0",
    decide(): Promise<DecisionResult> {
      throw new Error(`${id} sync 오류`);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("영원히 응답하지 않는 provider는 budget 경과 후 TIMEOUT으로 ABSTAIN한다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const slow = delayedProvider("slow", 10_000, { result: validResult(now) });
  const wrapped = isolateProvider(slow, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;

  expect(result.abstained).toBe(true);
  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstainReason).toContain("ISOLATION_TIMEOUT");
  expect(result.provider).toBe("slow");
  expect(() => decisionResultSchema.parse(result)).not.toThrow();
});

test("동기적으로 throw하는 provider는 ABSTAIN하고 절대 전파되지 않는다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const throwing = syncThrowingProvider("thrower");
  const wrapped = isolateProvider(throwing, { budgetMs: 100 });

  const result = await wrapped.decide(snapshotAt(now), contextAt(now));

  expect(result.abstained).toBe(true);
  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstainReason).toContain("ISOLATION_PROVIDER_ERROR");
  expect(result.abstainReason).toContain("thrower");
});

test("provider metadata가 비어도 오류 fallback은 유효한 ABSTAIN 결과를 반환한다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const invalidMetadata = { ...syncThrowingProvider(""), version: "" };
  const wrapped = isolateProvider(invalidMetadata, { budgetMs: 100 });

  const result = await wrapped.decide(snapshotAt(now), contextAt(now));

  expect(result.decision).toBe("ABSTAIN");
  expect(result.provider).toBe("unknown-provider");
  expect(result.providerVersion).toBe("unknown-version");
  expect(() => decisionResultSchema.parse(result)).not.toThrow();
});

test("provider가 context timestamp를 훼손하고 실패해도 원래 timestamp로 ABSTAIN한다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const mutatingProvider: DecisionProvider = {
    id: "mutator",
    version: "1.0.0",
    decide: async (_input, ctx) => {
      ctx.now.setTime(Number.NaN);
      throw new Error("provider failure");
    },
  };
  const result = await isolateProvider(mutatingProvider).decide(snapshotAt(now), contextAt(now));

  expect(result.decision).toBe("ABSTAIN");
  expect(result.decidedAt).toEqual(now);
  expect(() => decisionResultSchema.parse(result)).not.toThrow();
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5])("invalid maxConcurrent %s is rejected", (maxConcurrent) => {
  expect(() => isolateProvider(syncThrowingProvider("invalid-limit"), { maxConcurrent })).toThrow(RangeError);
});

test("timeout 뒤 미완료 provider는 실행 슬롯을 점유해 추가 호출을 제한한다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  let resolveCall!: (result: DecisionResult) => void;
  const deferredCall = new Promise<DecisionResult>((resolve) => { resolveCall = resolve; });
  const provider: DecisionProvider = {
    id: "stuck",
    version: "1.0.0",
    decide: () => deferredCall,
  };
  const wrapped = isolateProvider(provider, { budgetMs: 10, maxConcurrent: 1 });

  const firstCall = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(10);
  expect((await firstCall).abstainReason).toContain("ISOLATION_TIMEOUT");

  const secondResult = await wrapped.decide(snapshotAt(now), contextAt(now));
  expect(secondResult.abstainReason).toContain("ISOLATION_OVERLOADED");

  resolveCall(validResult(now));
  await vi.advanceTimersByTimeAsync(0);
  const thirdResult = await wrapped.decide(snapshotAt(now), contextAt(now));
  expect(thirdResult.decision).toBe("NORMAL");
});

test("async reject하는 provider는 ABSTAIN하고 절대 전파되지 않는다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const rejecting = delayedProvider("rejector", 10, { error: new Error("네트워크 실패") });
  const wrapped = isolateProvider(rejecting, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;

  expect(result.abstained).toBe(true);
  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstainReason).toContain("ISOLATION_PROVIDER_ERROR");
  expect(result.abstainReason).toContain("네트워크 실패");
});

test("decision 스키마를 어기는 결과를 반환하는 provider는 INVALID_SHAPE로 ABSTAIN한다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const malformed = delayedProvider("malformed", 10, {
    result: { decision: "NOT_A_REAL_DECISION", confidence: 2 },
  });
  const wrapped = isolateProvider(malformed, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;

  expect(result.abstained).toBe(true);
  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstainReason).toContain("ISOLATION_INVALID_SHAPE");
  expect(() => decisionResultSchema.parse(result)).not.toThrow();
});

test("budget과 정확히 같은 시점에 resolve하면 TIMEOUT을 우선한다(경계값 tie-break)", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const exact = delayedProvider("exact", 100, { result: validResult(now) });
  const wrapped = isolateProvider(exact, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;

  expect(result.abstained).toBe(true);
  expect(result.abstainReason).toContain("ISOLATION_TIMEOUT");
});

test("budget을 살짝 넘겨 resolve하면 TIMEOUT으로 ABSTAIN하고, 늦게 도착한 결과는 무시된다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const late = delayedProvider("late", 101, { result: validResult(now) });
  const wrapped = isolateProvider(late, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;

  expect(result.abstained).toBe(true);
  expect(result.abstainReason).toContain("ISOLATION_TIMEOUT");

  // 늦게 도착하는 provider의 실제 응답이 이미 반환된 ABSTAIN 결과를 바꾸지 않아야 한다.
  await vi.advanceTimersByTimeAsync(1);
  expect(result.abstained).toBe(true);
});

test("budget 내에 정상 응답하면 provider의 결과를 그대로(변형 없이) 통과시킨다", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const fine = delayedProvider("fine", 50, { result: validResult(now) });
  const wrapped = isolateProvider(fine, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;

  expect(result).toEqual(validResult(now));
});

test("성공 시 budget 타이머가 해제되어 남은 타이머가 없다(타이머 누수 없음)", async () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const fine = delayedProvider("fine", 10, { result: validResult(now) });
  const wrapped = isolateProvider(fine, { budgetMs: 100 });

  const pending = wrapped.decide(snapshotAt(now), contextAt(now));
  await vi.advanceTimersByTimeAsync(10);
  await pending;

  expect(vi.getTimerCount()).toBe(0);
});

test("TIMEOUT으로 이미 ABSTAIN한 뒤 provider가 늦게 reject해도 unhandled rejection이 발생하지 않는다", async () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const now = new Date("2026-09-25T00:00:00Z");
    const lateRejector = delayedProvider("late-rejector", 200, { error: new Error("너무 늦은 실패") });
    const wrapped = isolateProvider(lateRejector, { budgetMs: 100 });

    const pending = wrapped.decide(snapshotAt(now), contextAt(now));
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.abstained).toBe(true);

    // provider의 늦은 reject가 실제로 발생하는 시점까지 진행시킨다.
    await vi.advanceTimersByTimeAsync(100);
    // 마이크로태스크가 unhandledRejection 훅에 도달할 시간을 준다.
    await Promise.resolve();
    await Promise.resolve();

    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
