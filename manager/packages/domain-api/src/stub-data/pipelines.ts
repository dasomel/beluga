// STUB DATA, NOT LIVE UPSTREAM INTEGRATION.
// 실제 correlation/discovery(#41/#42) 없이 손으로 작성한 가짜 Pipeline이다. status는
// stages를 보고 알고리즘으로 계산한 값이 아니라 이 예시를 위해 직접 고른 값이다 —
// stage 상태들을 하나의 pipeline status로 집계하는 알고리즘은 이 이슈(#43) 범위 밖이며
// #41/#42의 correlation 작업에서 결정될 사안이다.
import { correlate, type CorrelationEntity } from "../correlation/rules.js";
import { pipelineSchema, type Pipeline } from "../schema/pipeline.js";

// 이슈 #35: 이름/label 규약 correlation의 stub 입력. 실제 인벤토리는 어댑터(#41)가 공급한다.
const lakehouseEntities: CorrelationEntity[] = [
  { kind: "kafka-topic", id: "topic-orders-cdc", name: "orders.cdc", labels: {} },
  { kind: "kafka-topic", id: "topic-audit-events", name: "audit.events", labels: {} },
  { kind: "flink-job", id: "job-flink-orders-sync", name: "orders-sync", labels: { "beluga.io/source-topic": "orders.cdc", "beluga.io/sink-table": "lakehouse.orders" } },
  { kind: "iceberg-table", id: "table-lakehouse-orders", name: "lakehouse.orders", labels: {} },
  { kind: "trino-catalog", id: "catalog-lakehouse", name: "lakehouse", labels: {} },
];

const batchEntities: CorrelationEntity[] = [
  // 선언 없음: 이름 규약만으로 추정되는 DAG -> job 링크(모호하면 확신도 하향).
  { kind: "airflow-dag", id: "job-airflow-orders-report", name: "orders_report_dag", labels: {} },
  { kind: "flink-job", id: "job-flink-orders-report", name: "orders-report", labels: {} },
  { kind: "flink-job", id: "job-flink-orders-backfill", name: "orders-backfill", labels: {} },
];

export const pipelines: Pipeline[] = pipelineSchema.array().parse([
  {
    id: "pl-lakehouse-ingest",
    name: "Kafka to Iceberg Lakehouse Ingest",
    stages: [
      {
        serviceId: "svc-kafka",
        serviceType: "kafka",
        status: "degraded",
        detail: "Under-replicated partitions on 2 brokers",
      },
      {
        serviceId: "svc-flink",
        serviceType: "flink",
        status: "stale",
        detail: "Checkpoint status not refreshed within freshness window",
      },
      { serviceId: "svc-iceberg", serviceType: "iceberg", status: "healthy", detail: null },
      { serviceId: "svc-trino", serviceType: "trino", status: "healthy", detail: null },
    ],
    jobs: [
      {
        id: "job-flink-orders-sync",
        name: "orders-sync",
        kind: "flink",
        serviceId: "svc-flink",
        lastRun: {
          result: "failed",
          startedAt: "2026-09-21T05:00:00.000Z",
          finishedAt: "2026-09-21T05:42:00.000Z",
          failureReason: "Checkpoint timeout after 600s",
        },
        relatedResourceIds: ["k8s-workload-flink", "k8s-pod-flink-jobmanager"],
      },
    ],
    correlationLinks: correlate(lakehouseEntities),
    status: "degraded",
    // architecture.md 첫 vertical slice(Source -> Kafka -> Flink -> Iceberg -> Trino)로
    // 명시적으로 구성된 파이프라인 — "declared".
    correlation: { confidence: 0.97, method: "declared" },
    lastUpdatedAt: "2026-09-21T05:50:00.000Z",
  },
  {
    id: "pl-batch-reporting",
    name: "Airflow Batch Reporting",
    stages: [
      { serviceId: "svc-airflow", serviceType: "airflow", status: "healthy", detail: null },
      { serviceId: "svc-flink", serviceType: "flink", status: "healthy", detail: null },
      { serviceId: "svc-trino", serviceType: "trino", status: "healthy", detail: null },
    ],
    jobs: [
      {
        id: "job-airflow-orders-report",
        name: "orders_report_dag",
        kind: "airflow",
        serviceId: "svc-airflow",
        lastRun: {
          result: "succeeded",
          startedAt: "2026-09-21T05:00:00.000Z",
          finishedAt: "2026-09-21T05:12:00.000Z",
          failureReason: null,
        },
        relatedResourceIds: [],
      },
      // D5: correlate only endpoints exposed by this Pipeline; extra stub jobs keep the API graph reviewable until adapter inventory replaces them.
      {
        id: "job-flink-orders-report",
        name: "orders-report",
        kind: "flink",
        serviceId: "svc-flink",
        lastRun: {
          result: "succeeded",
          startedAt: "2026-09-21T05:00:00.000Z",
          finishedAt: "2026-09-21T05:12:00.000Z",
          failureReason: null,
        },
        relatedResourceIds: [],
      },
      {
        id: "job-flink-orders-backfill",
        name: "orders-backfill",
        kind: "flink",
        serviceId: "svc-flink",
        lastRun: {
          result: "succeeded",
          startedAt: "2026-09-21T05:00:00.000Z",
          finishedAt: "2026-09-21T05:12:00.000Z",
          failureReason: null,
        },
        relatedResourceIds: [],
      },
    ],
    correlationLinks: correlate(batchEntities),
    status: "healthy",
    // DAG 태스크 이름 휴리스틱 등으로 추론된 관계라 확신도가 낮다 — "inferred".
    correlation: { confidence: 0.55, method: "inferred" },
    lastUpdatedAt: "2026-09-21T05:40:00.000Z",
  },
  {
    id: "pl-cluster-observability",
    name: "Kubernetes Cluster Observability",
    stages: [
      { serviceId: "svc-kubernetes", serviceType: "kubernetes", status: "unknown", detail: null },
      {
        serviceId: "svc-observability",
        serviceType: "observability",
        status: "unavailable",
        detail: "Metrics backend unreachable",
      },
    ],
    jobs: [],
    correlationLinks: [],
    status: "unavailable",
    correlation: { confidence: 0.3, method: "inferred" },
    lastUpdatedAt: "2026-09-21T05:30:00.000Z",
  },
] satisfies Pipeline[]);
