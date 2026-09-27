import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { eventSchema } from "../src/schema/event.js";
import { events } from "../src/stub-data/events.js";

const eventListResponseSchema = listResponseSchema(eventSchema, "EventListResponseTest");

test("GET /api/v1/events는 스키마와 정확히 일치하는 목록 envelope을 반환하고 warnings 키가 없다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/events");

  expect(res.status).toBe(200);
  const body = eventListResponseSchema.parse(await res.json());
  expect(body.meta.total).toBe(events.length);
  expect(body.warnings).toBeUndefined();
});

test("이벤트는 timestamp 내림차순(최신 우선)으로 정렬된다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/events?pageSize=100");
  const body = eventListResponseSchema.parse(await res.json());

  const timestamps = body.data.map((event) => event.timestamp);
  const sorted = [...timestamps].sort().reverse();
  expect(timestamps).toEqual(sorted);
});

test("page/pageSize가 실제로 stub 데이터를 슬라이스한다", async () => {
  const app = createApp();
  const page1 = eventListResponseSchema.parse(await (await app.request("/api/v1/events?page=1&pageSize=3")).json());
  const page2 = eventListResponseSchema.parse(await (await app.request("/api/v1/events?page=2&pageSize=3")).json());

  expect(page1.data).toHaveLength(3);
  expect(page2.data).toHaveLength(3);
  expect(page1.meta).toEqual({ total: events.length, page: 1, pageSize: 3 });
  const idsPage1 = page1.data.map((event) => event.id);
  const idsPage2 = page2.data.map((event) => event.id);
  expect(idsPage1).not.toEqual(idsPage2);
});

test("?severity=error 필터는 해당 severity의 이벤트만 남긴다(issue #43 finding #4)", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/events?severity=error");

  expect(res.status).toBe(200);
  const body = eventListResponseSchema.parse(await res.json());
  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every((event) => event.severity === "error")).toBe(true);
});

test("severity에 알 수 없는 값이 오면 400 VALIDATION_ERROR를 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/events?severity=not-a-real-severity");

  expect(res.status).toBe(400);
  const body = errorResponseSchema.parse(await res.json());
  expect(body.error.code).toBe("VALIDATION_ERROR");
});

test("relatedServiceId/relatedPipelineId의 nullable 조합이 모두 스키마를 통과한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/events?pageSize=100");
  const body = eventListResponseSchema.parse(await res.json());

  const bothNull = body.data.some(
    (event) => event.relatedServiceId === null && event.relatedPipelineId === null,
  );
  const bothSet = body.data.some(
    (event) => event.relatedServiceId !== null && event.relatedPipelineId !== null,
  );
  expect(bothNull).toBe(true);
  expect(bothSet).toBe(true);
});
