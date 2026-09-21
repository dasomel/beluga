import { expect, test } from "vitest";
import { createRuleProvider } from "../src/decision/ruleProvider.js";
import { decisionResultSchema, type DecisionContext, type TelemetrySnapshot } from "../src/decision/types.js";

function freshSnapshot(now: Date): TelemetrySnapshot {
  return {
    snapshotId: "snap-1",
    signals: {
      trino_query_state: { value: "RUNNING", observedAt: now },
      cpu_pct: { value: 42, observedAt: now },
    },
  };
}

function contextAt(now: Date, maxAgeMs = 60_000): DecisionContext {
  return { now, freshnessPolicy: { maxAgeMs }, correlationId: "corr-1" };
}

test("fresh하고 완전한 snapshot은 안전한 기본값 NORMAL을 낮은 확신도로 반환한다", async () => {
  const provider = createRuleProvider();
  const now = new Date("2026-09-21T00:00:00Z");

  const result = await provider.decide(freshSnapshot(now), contextAt(now));

  expect(result.decision).toBe("NORMAL");
  expect(result.abstained).toBe(false);
  expect(result.confidence).toBeGreaterThan(0);
  expect(result.confidence).toBeLessThan(0.5);
  expect(result.provider).toBe(provider.id);
  expect(result.providerVersion).toBe(provider.version);
  expect(() => decisionResultSchema.parse(result)).not.toThrow();
});

test("signal이 하나도 없으면 ABSTAIN한다", async () => {
  const provider = createRuleProvider();
  const now = new Date("2026-09-21T00:00:00Z");
  const empty: TelemetrySnapshot = { snapshotId: "snap-empty", signals: {} };

  const result = await provider.decide(empty, contextAt(now));

  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstained).toBe(true);
  expect(result.confidence).toBe(0);
  expect(result.abstainReason).toBeTruthy();
});

test("오래된 signal이 있으면 ABSTAIN하고 이유를 남긴다", async () => {
  const provider = createRuleProvider();
  const now = new Date("2026-09-21T00:00:00Z");
  const stale = new Date(now.getTime() - 120_000);
  const snapshot: TelemetrySnapshot = {
    snapshotId: "snap-2",
    signals: {
      cpu_pct: { value: 42, observedAt: stale },
    },
  };

  const result = await provider.decide(snapshot, contextAt(now, 60_000));

  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstained).toBe(true);
  expect(result.confidence).toBe(0);
  expect(result.abstainReason).toContain("cpu_pct");
});

test("필수 signal이 없으면 ABSTAIN한다", async () => {
  const provider = createRuleProvider({ requiredSignals: ["trino_query_state", "cpu_pct"] });
  const now = new Date("2026-09-21T00:00:00Z");
  const snapshot: TelemetrySnapshot = {
    snapshotId: "snap-3",
    signals: {
      cpu_pct: { value: 10, observedAt: now },
    },
  };

  const result = await provider.decide(snapshot, contextAt(now));

  expect(result.decision).toBe("ABSTAIN");
  expect(result.abstained).toBe(true);
  expect(result.abstainReason).toContain("trino_query_state");
});

test("decision은 항상 정해진 enum 값 중 하나이고 evidenceRefs는 항상 빈 배열이다", async () => {
  const provider = createRuleProvider();
  const now = new Date("2026-09-21T00:00:00Z");
  const decisions = new Set(["NORMAL", "ABSTAIN"]);

  const normal = await provider.decide(freshSnapshot(now), contextAt(now));
  const abstained = await provider.decide({ snapshotId: "snap-4", signals: {} }, contextAt(now));

  for (const result of [normal, abstained]) {
    expect(decisions.has(result.decision)).toBe(true);
    expect(result.evidenceRefs).toEqual([]);
    expect(() => decisionResultSchema.parse(result)).not.toThrow();
  }
});
