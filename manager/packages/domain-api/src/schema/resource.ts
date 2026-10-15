import { z } from "@hono/zod-openapi";
import { healthStatusSchema } from "./health.js";

export const resourceKindSchema = z.enum(["Namespace", "Workload", "Pod", "Service", "Endpoint", "Job", "PersistentVolumeClaim"]).openapi("ResourceKind");
export const resourceSchema = z.object({
  id: z.string().min(1).openapi({ example: "k8s-pod-flink-jobmanager" }),
  kind: resourceKindSchema,
  name: z.string().min(1),
  namespace: z.string().min(1).nullable(),
  status: healthStatusSchema,
  cpuUsage: z.string().min(1).nullable().optional().openapi({ example: "250m" }),
  memoryUsage: z.string().min(1).nullable().optional().openapi({ example: "512Mi" }),
  // PVC 전용(선택). 없으면 알 수 없음 -- 다른 kind에서는 생략한다.
  capacity: z.string().min(1).nullable().optional().openapi({ example: "128Gi" }),
  storageClass: z.string().min(1).nullable().optional().openapi({ example: "local-path" }),
  relatedServiceId: z.string().min(1).nullable(),
  relatedPipelineId: z.string().min(1).nullable(),
  relatedEventIds: z.array(z.string().min(1)),
  logsUrl: z.url({ protocol: /^https?$/ }).nullable().openapi({
    example: "https://logs.example.test/pod",
    pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
  }),
}).openapi("Resource");
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type Resource = z.infer<typeof resourceSchema>;
