import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { domainApiHealthSchema } from "../src/routes/health.js";

const { version: packageVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

test("GET /api/v1/health는 도메인 API 자신의 healthy 상태와 package.json 버전을 반환한다", async () => {
  const app = createApp();
  const res = await app.request("/api/v1/health");

  expect(res.status).toBe(200);
  const body = domainApiHealthSchema.parse(await res.json());
  expect(body.status).toBe("healthy");
  expect(body.version).toBe(packageVersion);
});
