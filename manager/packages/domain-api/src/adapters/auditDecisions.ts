import type { DecisionRecord } from "../schema/decision.js";
import type { SsoChangeStore } from "../store/ssoChangeStore.js";
import type { OverviewSource } from "./overviewSource.js";

export class AuditDecisionSource implements OverviewSource<DecisionRecord> {
  readonly requiresAdmins = true;
  constructor(private readonly store: Required<Pick<SsoChangeStore, "listAuditEvents">>, private readonly timeoutMs = 6000) {}
  async list() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        this.store.listAuditEvents(1000),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("audit read timeout")), this.timeoutMs); }),
      ]);
      const items: DecisionRecord[] = records.map((record) => ({
        id: `audit-${record.id}`, snapshotId: `audit-${record.id}`, correlationId: record.requestId ?? `audit-${record.id}`,
        evaluatedAt: record.createdAt, audit: { stage: record.stage, requestId: record.requestId, endpoint: record.endpoint },
        result: { decision: "ABSTAIN", confidence: 0, abstained: true, abstainCode: "NO_TELEMETRY",
          abstainReason: `SSO audit: ${record.stage}; not a System-1 diagnostic evaluation`, provider: "manager-audit-db",
          providerVersion: "1", policyVersion: "not-evaluated", decidedAt: record.createdAt, evidenceRefs: [] },
        inputSignals: [], freshnessPolicy: { maxAgeMs: 0 }, relatedResourceId: null, relatedServiceId: null, relatedPipelineId: null,
      }));
      return { items, inventoryComplete: records.length < 1000, warnings: records.length === 1000 ? [{ code: "TRUNCATED", message: "Recent 1000 audit records only", serviceId: null }] : [] };
    } finally { clearTimeout(timer); }
  }
}
