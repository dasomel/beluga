import { expect, test } from "vitest";
import { createApp } from "../src/app.js";

// OpenAPI 3.1은 JSON Schema 2020-12를 그대로 쓴다 -- 3.0 스타일 키워드(boolean
// exclusiveMinimum/exclusiveMaximum, "nullable: true")는 3.1 문서에서는 문법 오류다.
// app.ts가 `openapi: "3.1.0"`을 선언하는 이상, 실제로 내려주는 JSON Schema 조각도 그
// 규칙을 따라야 한다 (finding #1).
function collectViolations(node: unknown, path: string, violations: string[]): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectViolations(item, `${path}[${index}]`, violations));
    return;
  }
  const obj = node as Record<string, unknown>;
  if ("nullable" in obj) {
    violations.push(`${path}: 3.0-style "nullable" keyword is not valid JSON Schema 2020-12`);
  }
  if (typeof obj.exclusiveMinimum === "boolean" || typeof obj.exclusiveMaximum === "boolean") {
    violations.push(`${path}: 3.0-style boolean exclusiveMinimum/exclusiveMaximum is not valid JSON Schema 2020-12`);
  }
  for (const [key, value] of Object.entries(obj)) {
    collectViolations(value, `${path}.${key}`, violations);
  }
}

test("openapi: 3.1.0을 선언한 문서는 3.0 스타일 스키마 키워드(nullable, boolean exclusiveMinimum)를 쓰지 않는다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/openapi.json");
  const doc = (await res.json()) as { openapi: string; components?: { schemas?: unknown } };

  expect(doc.openapi).toBe("3.1.0");

  const violations: string[] = [];
  collectViolations(doc.components?.schemas ?? {}, "components.schemas", violations);

  expect(violations).toEqual([]);
});
