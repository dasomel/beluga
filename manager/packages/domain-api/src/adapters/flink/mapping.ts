// Flink job -> Beluga Pipeline/Job 도메인 매핑(순수 함수, I/O 없음). Flink 고유 타입은 이 경계를 넘지 않는다.
//
// D1: 상태 매핑은 보수적이다 — 확실히 정상 동작 중인 RUNNING만 healthy이고, 알 수 없는/전이 상태는
//     healthy로 올리지 않는다. 표는 FLINK_STATE_MAPPING에 있고 docs/api-reference.md에도 같다.
// D2: failureReason은 Flink가 보고한 상태 이름만 쓴다. /jobs/{id}/exceptions의 스택 트레이스는
//     내부 구성/값이 섞일 수 있어 읽지 않는다.
// D3: Flink REST는 Kafka topic/label을 노출하지 않는다. job graph의 IcebergSink 정점 이름이 보고하는
//     sink 테이블만 iceberg-table 엔티티로 쓰고, 기존 correlate() 규칙(이름 규약, 상한 0.6)을 그대로 적용한다
//     — "declared-label"을 위조하지 않는다. topic->job 링크는 Kafka 어댑터가 생기기 전에는 만들지 않는다.
import { AMBIGUOUS_CONFIDENCE, correlate, type CorrelationEntity } from "../../correlation/rules.js";
import type { HealthStatus } from "../../schema/health.js";
import {
  pipelineSchema,
  type CorrelationLink,
  type Pipeline,
  type PipelineJob,
  type PipelineStage,
} from "../../schema/pipeline.js";
import type { FlinkJobDetail, FlinkJobSummary } from "./client.js";

export const FLINK_SERVICE_ID = "svc-flink";
const ICEBERG_SERVICE_ID = "svc-iceberg";

type RunResult = NonNullable<PipelineJob["lastRun"]>["result"];

interface StateMapping {
  health: HealthStatus;
  result: RunResult;
}

// Flink 1.20 JobStatus enum(REST 문서의 enum과 동일):
// https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/rest_api/ (GET /jobs/overview)
export const FLINK_STATE_MAPPING: Readonly<Record<string, StateMapping>> = {
  RUNNING: { health: "healthy", result: "running" }, // 단, failed task가 있으면 degraded(mapState)
  INITIALIZING: { health: "unknown", result: "unknown" },
  CREATED: { health: "unknown", result: "unknown" },
  RECONCILING: { health: "unknown", result: "unknown" },
  RESTARTING: { health: "degraded", result: "unknown" },
  FAILING: { health: "degraded", result: "unknown" },
  FAILED: { health: "unavailable", result: "failed" },
  CANCELLING: { health: "unknown", result: "unknown" },
  CANCELED: { health: "unavailable", result: "unknown" },
  SUSPENDED: { health: "unavailable", result: "unknown" },
  FINISHED: { health: "healthy", result: "succeeded" },
};

const UNKNOWN_STATE: StateMapping = { health: "unknown", result: "unknown" };
const FAILURE_STATES = new Set(["RESTARTING", "FAILING", "FAILED"]);

export function mapState(state: string, tasks: Record<string, number> = {}): StateMapping {
  if (state === "RUNNING" && (tasks["failed"] ?? 0) > 0) {
    return { health: "degraded", result: "running" };
  }
  return FLINK_STATE_MAPPING[state] ?? UNKNOWN_STATE;
}

export function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "unnamed" : s;
}

function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "Sink: IcebergSink lakekeeper.lake.orders" -> "lakekeeper.lake.orders"
export function extractSinkTables(detail: FlinkJobDetail | undefined): string[] {
  if (!detail) return [];
  const found = new Set<string>();
  for (const vertex of detail.vertices) {
    for (const match of vertex.name.matchAll(/IcebergSink\s+([A-Za-z0-9_.-]+)/g)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

export function stripPrefix(name: string, prefix: string): string {
  return prefix !== "" && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

export interface FlinkJobInput {
  summary: FlinkJobSummary;
  /** 없으면 /jobs/{id} 조회 실패 — sink 테이블 없이 job만 투영한다. */
  detail?: FlinkJobDetail;
}

// D5: Pipeline id는 Flink job id(jid)에서만 파생한다 — 같은 이름의 다른 job이 생기거나 사라져도 바뀌지 않는다.
// jid는 Flink가 job 실행 인스턴스에 부여하는 값이라 job을 다시 제출(새 jid)하면 id가 바뀐다(문서화된 한계).
export const PIPELINE_ID_PATTERN = /^pl-flink-([0-9a-f]{32})$/;
export const pipelineIdFor = (jid: string): string => `pl-flink-${jid}`;

export function buildPipelines(
  inputs: readonly FlinkJobInput[],
  options: { jobNamePrefix: string; now: Date },
): { pipelines: Pipeline[]; skipped: number } {
  const pipelines: Pipeline[] = [];
  let skipped = 0;

  for (const { summary, detail } of inputs) {
    const mapped = mapState(summary.state, summary.tasks);
    const jobId = `job-flink-${summary.jid}`;
    const startedAt = isoOrNull(summary["start-time"]);
    const sinkTables = extractSinkTables(detail);

    const job: PipelineJob = {
      id: jobId,
      name: summary.name,
      kind: "flink",
      serviceId: FLINK_SERVICE_ID,
      lastRun:
        startedAt === null
          ? null
          : {
              result: mapped.result,
              startedAt,
              finishedAt: isoOrNull(summary["end-time"]),
              failureReason: FAILURE_STATES.has(summary.state) ? `Flink reported job state ${summary.state}` : null,
            },
      relatedResourceIds: [],
    };

    const stages: PipelineStage[] = [
      { serviceId: FLINK_SERVICE_ID, serviceType: "flink", status: mapped.health, detail: `Flink job state ${summary.state}` },
      ...sinkTables.map(
        (table): PipelineStage => ({
          serviceId: ICEBERG_SERVICE_ID,
          serviceType: "iceberg",
          status: "unknown",
          detail: `Sink table ${table} reported by the Flink job graph; not verified against the catalog`,
        }),
      ),
    ];

    // job별로 따로 correlate한다: 다른 job의 sink 테이블과 이름이 우연히 맞아도 링크가 생기지 않는다.
    const entities: CorrelationEntity[] = [
      { kind: "flink-job", id: jobId, name: stripPrefix(summary.name, options.jobNamePrefix), labels: {} },
      ...sinkTables.map(
        (table): CorrelationEntity => ({ kind: "iceberg-table", id: `table-${slug(table)}`, name: table, labels: {} }),
      ),
    ];
    const tableByEntityId = new Map(sinkTables.map((t) => [`table-${slug(t)}`, t]));
    const links: CorrelationLink[] = correlate(entities).map((link) =>
      link.relation === "job-writes-table"
        ? {
            ...link,
            evidence: [
              ...link.evidence,
              `Flink job graph of '${summary.name}' reports an IcebergSink on '${tableByEntityId.get(link.target.id) ?? link.target.id}'`,
            ],
          }
        : link,
    );

    const lastUpdatedAt = isoOrNull(summary["last-modification"]) ?? startedAt ?? options.now.toISOString();

    const candidate = {
      id: pipelineIdFor(summary.jid),
      name: summary.name,
      stages,
      jobs: [job],
      correlationLinks: links,
      status: mapped.health,
      // D4: 이 Pipeline은 Flink job 하나의 투영이며 서비스 간 구성이 선언된 적이 없다 — "declared"로
      // 올리지 않는다. 신뢰도는 가장 약한 링크 값, 링크가 없으면 모호함 상수(0.3)를 쓴다.
      correlation: {
        confidence: links.length > 0 ? Math.min(...links.map((l) => l.confidence)) : AMBIGUOUS_CONFIDENCE,
        method: "inferred",
      },
      lastUpdatedAt,
    };
    const parsed = pipelineSchema.safeParse(candidate);
    if (parsed.success) pipelines.push(parsed.data);
    else skipped += 1;
  }

  return { pipelines: pipelines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), skipped };
}
