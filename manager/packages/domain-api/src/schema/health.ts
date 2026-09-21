import { z } from "@hono/zod-openapi";

// ADR-0003이 이미 확정한 어휘를 그대로 재사용한다 — 여기서 다른 상태값을 새로 만들면
// UI 배지/색상 매핑(ADR-0003)과 어긋나고, #42/#43이 요구하는 단일 status vocabulary가
// 깨진다.
export const healthStatusSchema = z
  .enum(["healthy", "degraded", "stale", "unknown", "unavailable"])
  .openapi("HealthStatus");

export type HealthStatus = z.infer<typeof healthStatusSchema>;
