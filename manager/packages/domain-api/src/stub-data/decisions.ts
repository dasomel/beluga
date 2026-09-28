// Deterministic decision projections generated from telemetry snapshots at module load.
import { isolateProvider } from "../decision/isolatedProvider.js";
import { createRuleProvider } from "../decision/ruleProvider.js";
import type { DecisionContext, TelemetrySnapshot } from "../decision/types.js";
import { decisionRecordSchema, type DecisionRecord } from "../schema/decision.js";

const evaluatedAt = new Date("2026-09-28T09:00:00.000Z");
const freshnessPolicy = { maxAgeMs: 60_000 };
const snapshots: Array<{
  id: string;
  snapshot: TelemetrySnapshot;
  relatedResourceId: string | null;
  relatedServiceId: string | null;
  relatedPipelineId: string | null;
}> = [
  {
    id: "decision-fresh",
    snapshot: { snapshotId: "snapshot-fresh-001", signals: {
      "k8s.pod.cpu": { value: "250m", observedAt: new Date("2026-09-28T08:59:30.000Z") },
      "k8s.pod.memory": { value: "512Mi", observedAt: new Date("2026-09-28T08:59:35.000Z") },
    } },
    relatedResourceId: "k8s-pod-flink-jobmanager", relatedServiceId: "svc-flink", relatedPipelineId: "pl-lakehouse-ingest",
  },
  {
    id: "decision-stale",
    snapshot: { snapshotId: "snapshot-stale-001", signals: {
      "k8s.workload.cpu": { value: "850m", observedAt: new Date("2026-09-28T08:57:00.000Z") },
    } },
    relatedResourceId: "k8s-workload-flink", relatedServiceId: "svc-flink", relatedPipelineId: "pl-lakehouse-ingest",
  },
  {
    id: "decision-empty",
    snapshot: { snapshotId: "snapshot-empty-001", signals: {} },
    relatedResourceId: null, relatedServiceId: "svc-trino", relatedPipelineId: null,
  },
];

const provider = isolateProvider(createRuleProvider());
const context: DecisionContext = { now: evaluatedAt, freshnessPolicy, correlationId: "" };

export const decisions: DecisionRecord[] = await Promise.all(snapshots.map(async ({ id, snapshot, ...related }) => {
  const correlationId = `correlation-${id}`;
  const result = await provider.decide(snapshot, { ...context, correlationId });
  const inputSignals = Object.entries(snapshot.signals).map(([name, signal]) => ({
    name,
    observedAt: signal.observedAt.toISOString(),
    freshAtEvaluation: evaluatedAt.getTime() - signal.observedAt.getTime() <= freshnessPolicy.maxAgeMs,
  }));
  return decisionRecordSchema.parse({
    id, snapshotId: snapshot.snapshotId, correlationId, evaluatedAt: evaluatedAt.toISOString(),
    result: { ...result, decidedAt: result.decidedAt.toISOString(), evidenceRefs: result.evidenceRefs.map((ref) => ({
      ...ref, observedAt: ref.observedAt.toISOString(), ingestedAt: ref.ingestedAt.toISOString(), freshnessDeadline: ref.freshnessDeadline.toISOString(),
    })) },
    inputSignals, freshnessPolicy, ...related,
  });
}));
