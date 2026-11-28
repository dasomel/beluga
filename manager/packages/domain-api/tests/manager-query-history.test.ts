import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { loadUpstreamWiring } from "../src/adapters/upstream/config.js";
import { TRINO_HISTORY_ACK_VALUE } from "../src/adapters/upstream/config.js";
import { json, mockFetch } from "./helpers/mockUpstream.js";

// D-MQH: Trino query history uses a dedicated client_credentials identity, refreshed in-process,
// exactly like the Lakekeeper reader (D-MCAT-4). The static TOKEN/TOKEN_FILE path stays available.
const env = {
  BELUGA_TRINO_ENABLED: "true",
  BELUGA_TRINO_BASE_URL: "https://trino.test:8443",
  BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE,
  BELUGA_TRINO_TOKEN_ENDPOINT: "https://sso.test/token",
  BELUGA_TRINO_CLIENT_ID: "manager-query-history",
  BELUGA_TRINO_CLIENT_SECRET: "SECRET",
};

test("query-history config fails fast for missing or conflicting credentials", () => {
  for (const name of ["BELUGA_TRINO_CLIENT_ID", "BELUGA_TRINO_CLIENT_SECRET"]) {
    expect(() => loadUpstreamWiring({ ...env, [name]: "" })).toThrow(name);
  }
  expect(() => loadUpstreamWiring({ ...env, BELUGA_TRINO_TOKEN_ENDPOINT: "" })).toThrow("BELUGA_TRINO_TOKEN_ENDPOINT is required for client credentials");
  expect(() => loadUpstreamWiring({ ...env, BELUGA_TRINO_TOKEN: "static" })).toThrow("mutually exclusive");
  expect(() => loadUpstreamWiring({ ...env, BELUGA_TRINO_TOKEN_FILE: "/tmp/token" })).toThrow("mutually exclusive");
  expect(() => loadUpstreamWiring({ ...env, BELUGA_TRINO_TOKEN_ENDPOINT: "http://sso.test/token" })).toThrow("plain http");
  expect(() => loadUpstreamWiring({ ...env, BELUGA_TRINO_TOKEN_ENDPOINT: "http://sso.test/token", BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER: "true" }))
    .not.toThrow();
});

test("exchanges the dedicated credential once and sends the service token to Trino /v1/query", async () => {
  let exchanges = 0;
  const { impl, calls } = mockFetch(({ url, method }) => {
    if (method === "POST") {
      exchanges += 1;
      return json({ access_token: "service-token", expires_in: 300, token_type: "bearer" });
    }
    if (url.pathname === "/v1/query") return json([]);
    throw new Error(`unexpected upstream call ${url.pathname}`);
  });
  const wiring = loadUpstreamWiring({ ...env, BELUGA_TRINO_HISTORY_CACHE_TTL_MS: "0" }, impl);
  expect(wiring.diagnostics).toContain("Trino query history adapter enabled (read-only)");
  const app = createApp(undefined, wiring.queryHistoryAdapter, undefined, undefined, undefined, { verify: async () => ({ sub: "analyst", groups: [] }) });
  const auth = { headers: { Authorization: "Bearer user-token" } };
  for (let i = 0; i < 2; i += 1) {
    const response = await app.request("/api/v1/query-history", auth);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toEqual([]);
  }
  expect(exchanges).toBe(1);
  const trinoCalls = calls.filter((call) => call.url.pathname === "/v1/query");
  expect(trinoCalls.length).toBe(2);
  for (const call of trinoCalls) {
    expect(call.headers.get("authorization")).toBe("Bearer service-token");
    // The end user's token never reaches Trino.
    expect(call.headers.get("authorization")).not.toContain("user-token");
  }
});
