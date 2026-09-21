import { expect, test } from "vitest";
import { decisionResultSchema, decisionSchema, evidenceRefSchema } from "../src/decision/types.js";

test("decisionSchema는 정의된 enum 값만 허용한다", () => {
  expect(decisionSchema.parse("NORMAL")).toBe("NORMAL");
  expect(decisionSchema.parse("ESCALATE")).toBe("ESCALATE");
  expect(() => decisionSchema.parse("BOGUS")).toThrow();
});

test("decisionResultSchema는 enum 밖의 decision 값을 가진 결과를 거부한다", () => {
  const base = {
    confidence: 0.5,
    abstained: false,
    evidenceRefs: [],
    provider: "rule-provider",
    providerVersion: "0.1.0",
    policyVersion: "v1",
    decidedAt: new Date(),
    latencyMs: 1,
  };

  expect(() => decisionResultSchema.parse({ ...base, decision: "NOT_A_REAL_DECISION" })).toThrow();
  expect(decisionResultSchema.parse({ ...base, decision: "NORMAL" }).decision).toBe("NORMAL");
});

test("evidenceRefSchema는 필수 필드가 빠진 근거를 거부한다", () => {
  const validEvidence = {
    source: "metric:trino_spill_bytes",
    observedAt: new Date("2026-09-20T00:00:00Z"),
    ingestedAt: new Date("2026-09-20T00:00:01Z"),
    freshnessDeadline: new Date("2026-09-20T00:05:00Z"),
    contentHash: "abc123",
  };

  expect(() => evidenceRefSchema.parse(validEvidence)).not.toThrow();
  expect(() => evidenceRefSchema.parse({ ...validEvidence, contentHash: undefined })).toThrow();
});

test("decisionResultSchema는 evidenceRefs의 각 항목이 EvidenceRef 형태를 따르도록 강제한다", () => {
  const validEvidence = {
    source: "metric:trino_spill_bytes",
    observedAt: new Date("2026-09-20T00:00:00Z"),
    ingestedAt: new Date("2026-09-20T00:00:01Z"),
    freshnessDeadline: new Date("2026-09-20T00:05:00Z"),
    contentHash: "abc123",
  };
  const base = {
    decision: "STORAGE_BOUND" as const,
    confidence: 0.9,
    abstained: false,
    provider: "rule-provider",
    providerVersion: "0.1.0",
    policyVersion: "v1",
    decidedAt: new Date(),
    latencyMs: 1,
  };

  expect(() => decisionResultSchema.parse({ ...base, evidenceRefs: [validEvidence] })).not.toThrow();
  expect(() => decisionResultSchema.parse({ ...base, evidenceRefs: [{ source: "metric:x" }] })).toThrow();
});
