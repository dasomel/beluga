// Fixtures are SPEC-DERIVED: GET /v1/query returns List<BasicQueryInfo> (trinodb/trino 483 QueryResource.java,
// BasicQueryInfo.java). They are not recorded from a live cluster; authenticated flows are NOT verified live.
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { createTrinoQueryHistoryAdapter } from "../src/adapters/upstream/trinoQueryHistory.js";
import { redactSqlLiterals } from "../src/adapters/upstream/sqlRedaction.js";
import { staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { queryHistoryResponseSchema } from "../src/schema/queryHistory.js";
import { hangForever, json, mockFetch, type Responder } from "./helpers/mockUpstream.js";

const SECRET = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD.sig";
const basicQueryInfo = (queryId: string, state: string, query: string) => ({
  queryId, state, query, scheduled: true, self: `http://trino/v1/query/${queryId}`, queryType: "SELECT",
  session: { queryId, user: "alice", source: "trino-cli" }, queryStats: { elapsedTime: "1.00s" },
});
const FIXTURE = [
  basicQueryInfo("20261007_000001_00001_abcde", "FINISHED", "SELECT * FROM orders WHERE email = 'a@b.c' AND id = 42"),
  basicQueryInfo("20261007_000002_00001_abcde", "RUNNING", "SELECT 1"),
];

function appWith(responder: Responder, opts: { user?: string; redactSql?: boolean; timeoutMs?: number } = {}) {
  const { impl, calls } = mockFetch(responder);
  const client = new UpstreamHttpClient({
    upstream: "trino", baseUrl: "http://127.0.0.1:8080", tokenProvider: staticTokenProvider(SECRET), fetchImpl: impl,
    ...(opts.user ? { headers: { "X-Trino-User": opts.user } } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const adapter = createTrinoQueryHistoryAdapter({ client, ...(opts.redactSql === undefined ? {} : { redactSql: opts.redactSql }) });
  return { app: createApp(undefined, adapter), calls };
}
afterEach(() => vi.restoreAllMocks());

test("maps BasicQueryInfo to the history contract, redacts literals, preserves upstream order, drops extra fields", async () => {
  const { app, calls } = appWith(() => json(FIXTURE));
  const response = await app.request("/api/v1/query-history");
  expect(response.status).toBe(200);
  const body = queryHistoryResponseSchema.parse(await response.json());
  expect(body.data).toEqual([
    { id: "20261007_000001_00001_abcde", sql: "SELECT * FROM orders WHERE email = ? AND id = ?", state: "FINISHED" },
    { id: "20261007_000002_00001_abcde", sql: "SELECT ?", state: "RUNNING" },
  ]);
  expect(JSON.stringify(body)).not.toContain("alice");
  expect(calls[0]?.url.pathname).toBe("/v1/query");
  expect(calls[0]?.headers.get("x-trino-user")).toBeNull(); // only sent when configured
});

test("redaction can be disabled explicitly and X-Trino-User is sent when configured", async () => {
  const { app, calls } = appWith(() => json(FIXTURE), { redactSql: false, user: "beluga-manager" });
  const body = (await (await app.request("/api/v1/query-history")).json()) as { data: { sql: string }[] };
  expect(body.data[0]?.sql).toContain("'a@b.c'");
  expect(calls[0]?.headers.get("x-trino-user")).toBe("beluga-manager");
});

test("empty history is 200 with total 0; pagination slices the upstream snapshot", async () => {
  expect(await (await appWith(() => json([])).app.request("/api/v1/query-history")).json()).toEqual({ data: [], meta: { total: 0, page: 1, pageSize: 20 } });
  const many = Array.from({ length: 5 }, (_, i) => basicQueryInfo(`q${i}`, "FINISHED", `SELECT ${i}`));
  const page2 = (await (await appWith(() => json(many)).app.request("/api/v1/query-history?page=2&pageSize=2")).json()) as { data: { id: string }[]; meta: unknown };
  expect(page2.data.map((e) => e.id)).toEqual(["q2", "q3"]);
  expect(page2.meta).toEqual({ total: 5, page: 2, pageSize: 2 });
});

test.each([[401], [403], [500], [502]])("upstream HTTP %i -> 503, no data, no token in body or logs", async (status) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { app } = appWith(() => json({ message: `denied ${SECRET}`, partial: FIXTURE }, status));
  const response = await app.request("/api/v1/query-history");
  const text = await response.text();
  expect(response.status).toBe(503);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("20261007");
  expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  if (status === 401 || status === 403) expect(text).toContain("did not accept Manager's service credential");
});

test("malformed upstream: not JSON, not an array, or any invalid item -> 503 and never a partial list", async () => {
  for (const responder of [
    () => new Response("not json", { status: 200 }),
    () => json({ queries: FIXTURE }),
    () => json([FIXTURE[0], { queryId: "q", state: "RUNNING" }]), // second item lacks `query`
  ] as Responder[]) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appWith(responder).app.request("/api/v1/query-history");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("20261007");
  }
});

test("timeout and unreachable degrade to 503", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await appWith(hangForever, { timeoutMs: 20 }).app.request("/api/v1/query-history")).status).toBe(503);
  const refused = createApp(undefined, createTrinoQueryHistoryAdapter({
    client: new UpstreamHttpClient({ upstream: "trino", baseUrl: "http://127.0.0.1:9", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }),
  }));
  expect((await refused.request("/api/v1/query-history")).status).toBe(503);
});

test("redactSqlLiterals: strings, escapes, numbers, comments, quoted identifiers, unterminated input", () => {
  const out = redactSqlLiterals("SELECT 'it''s', 3.14, x1, \"Col 9\" FROM t2 WHERE a=7 -- secret\n/* c */ LIMIT 5");
  expect(out.replace(/\s+/g, " ")).toBe('SELECT ?, ?, x1, "Col 9" FROM t2 WHERE a=? LIMIT ?');
  expect(out).not.toContain("secret");
  expect(redactSqlLiterals("SELECT 'unterminated secret")).toBe("SELECT ?");
  expect(redactSqlLiterals("SELECT 1 /* unterminated")).toBe("SELECT ?");
});
