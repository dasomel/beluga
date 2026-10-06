// STUB DATA, NOT LIVE KUBERNETES OR OBSERVABILITY INTEGRATION.
import { resourceSchema, type Resource } from "../schema/resource.js";

export const resources: Resource[] = resourceSchema.array().parse([
  { id: "k8s-namespace-data", kind: "Namespace", name: "data-platform", namespace: null, status: "healthy", cpuUsage: null, memoryUsage: null, relatedServiceId: "svc-kubernetes", relatedPipelineId: null, relatedEventIds: ["evt-6"], logsUrl: null },
  { id: "k8s-workload-flink", kind: "Workload", name: "flink-cluster", namespace: "data-platform", status: "stale", cpuUsage: "850m", memoryUsage: "2Gi", relatedServiceId: "svc-flink", relatedPipelineId: "pl-lakehouse-ingest", relatedEventIds: ["evt-3"], logsUrl: null },
  { id: "k8s-pod-flink-jobmanager", kind: "Pod", name: "flink-cluster-jobmanager-0", namespace: "data-platform", status: "degraded", cpuUsage: "250m", memoryUsage: "512Mi", relatedServiceId: "svc-flink", relatedPipelineId: "pl-lakehouse-ingest", relatedEventIds: ["evt-3"], logsUrl: null },
  { id: "k8s-service-trino", kind: "Service", name: "trino", namespace: "data-platform", status: "healthy", cpuUsage: null, memoryUsage: null, relatedServiceId: "svc-trino", relatedPipelineId: null, relatedEventIds: ["evt-4"], logsUrl: null },
  { id: "k8s-endpoint-trino", kind: "Endpoint", name: "trino", namespace: "data-platform", status: "healthy", cpuUsage: null, memoryUsage: null, relatedServiceId: "svc-trino", relatedPipelineId: null, relatedEventIds: [], logsUrl: null },
  { id: "k8s-job-iceberg-compaction", kind: "Job", name: "iceberg-compaction-28712", namespace: "data-platform", status: "degraded", cpuUsage: null, memoryUsage: null, relatedServiceId: "svc-iceberg", relatedPipelineId: "pl-lakehouse-ingest", relatedEventIds: ["evt-7"], logsUrl: null },
  { id: "k8s-pvc-iceberg", kind: "PersistentVolumeClaim", name: "iceberg-warehouse", namespace: "data-platform", status: "healthy", cpuUsage: null, memoryUsage: "128Gi", capacity: "128Gi", storageClass: "local-path", relatedServiceId: "svc-iceberg", relatedPipelineId: "pl-lakehouse-ingest", relatedEventIds: [], logsUrl: null },
] satisfies Resource[]);
