import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import type { DataAssetSource } from "../src/adapters/dataAssetSource.js";
import type { QueryHistoryAdapter } from "../src/adapters/queryHistory.js";
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

test("기본 구성에서 어댑터 모드는 flink/lakekeeper=stub, trinoQueryHistory=disabled로 보고된다 (D-MDEV-2)", async () => {
  const body = domainApiHealthSchema.parse(await (await createApp().request("/api/v1/health")).json());
  expect(body.components).toMatchObject({ flink: "stub", trinoQueryHistory: "disabled", lakekeeper: "stub" });
});

test("어댑터가 주입되면 해당 컴포넌트만 live로 보고된다", async () => {
  const app = createApp(
    undefined,
    { listQueryHistory: async () => [] } as unknown as QueryHistoryAdapter,
    undefined,
    {} as unknown as DataAssetSource,
  );
  const body = domainApiHealthSchema.parse(await (await app.request("/api/v1/health")).json());
  expect(body.components).toMatchObject({ flink: "stub", trinoQueryHistory: "live", lakekeeper: "live" });
});
