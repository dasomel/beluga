import { expect, test } from "vitest";
import { UpstreamHttpClient } from "../src/adapters/upstream/httpClient.js";
import { UpstreamError } from "../src/adapters/upstream/errors.js";
import { fileTokenProvider, normalizeToken, staticTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { hangForever, json, mockFetch } from "./helpers/mockUpstream.js";

const SECRET = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD.sig";
const client = (fetchImpl: typeof fetch, extra = {}) =>
  new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:9", tokenProvider: staticTokenProvider(SECRET), fetchImpl, ...extra });
const kindOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as UpstreamError);

test("sends GET with bearer, refuses redirects, builds path + query", async () => {
  const { impl, calls } = mockFetch(() => json({ ok: true }));
  expect(await client(impl, { baseUrl: "http://127.0.0.1:9/catalog/" }).getJson("/v1/config", { warehouse: "w", skip: undefined })).toEqual({ ok: true });
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.redirect).toBe("error");
  expect(calls[0]?.url.pathname).toBe("/catalog/v1/config");
  expect(calls[0]?.url.search).toBe("?warehouse=w");
  expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
});

test.each([
  [401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [500, "upstream_error"], [503, "upstream_error"],
] as const)("HTTP %i classified as %s; error never carries token or body", async (status, kind) => {
  const { impl } = mockFetch(() => json({ error: { message: `leak ${SECRET}` } }, status));
  const error = await kindOf(client(impl).getJson("/x"));
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error.kind).toBe(kind);
  expect(error.message).not.toContain(SECRET);
  expect(error.message).not.toContain("leak");
});

test("malformed JSON, oversized body, unreachable and timeout are classified", async () => {
  expect((await kindOf(client(mockFetch(() => new Response("<html>", { status: 200 })).impl).getJson("/x"))).kind).toBe("malformed");
  expect((await kindOf(client(mockFetch(() => json({ a: "x".repeat(50) })).impl, { maxBodyBytes: 10 }).getJson("/x"))).kind).toBe("malformed");
  const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  expect((await kindOf(client(refused).getJson("/x"))).kind).toBe("unreachable");
  expect((await kindOf(client(mockFetch(hangForever).impl, { timeoutMs: 20 }).getJson("/x"))).kind).toBe("timeout");
});

test("an exhausted operation deadline times out before any request", async () => {
  const { impl, calls } = mockFetch(() => json({}));
  expect((await kindOf(client(impl).getJson("/x", undefined, Date.now() - 1))).kind).toBe("timeout");
  expect(calls).toHaveLength(0);
});

test("missing token -> unauthenticated without sending a request", async () => {
  const { impl, calls } = mockFetch(() => json({}));
  const c = new UpstreamHttpClient({ upstream: "t", baseUrl: "http://127.0.0.1:9", tokenProvider: staticTokenProvider(undefined), fetchImpl: impl });
  expect((await kindOf(c.getJson("/x"))).kind).toBe("unauthenticated");
  expect(calls).toHaveLength(0);
});

test("bearer over plain http to a non-loopback host is refused unless explicitly allowed", () => {
  const base = { upstream: "t", baseUrl: "http://trino.analytics.svc:8080", tokenProvider: staticTokenProvider(SECRET) };
  expect(() => new UpstreamHttpClient(base)).toThrow(/plain http/);
  expect(() => new UpstreamHttpClient({ ...base, allowInsecureBearer: true })).not.toThrow();
  expect(() => new UpstreamHttpClient({ ...base, baseUrl: "https://trino.analytics.svc" })).not.toThrow();
  expect(() => new UpstreamHttpClient({ ...base, baseUrl: "ftp://x" })).toThrow(/http/);
});

test("token providers: normalize rejects header-injection, file provider re-reads and hides read errors", async () => {
  expect(normalizeToken("abc.def-ghi\n")).toBe("abc.def-ghi");
  expect(normalizeToken("abc\r\nX-Evil: 1")).toBeNull();
  expect(normalizeToken("")).toBeNull();
  let current = "tok1";
  const provider = fileTokenProvider("/does/not/matter", async () => current);
  expect(await provider.getToken()).toBe("tok1");
  current = "tok2";
  expect(await provider.getToken()).toBe("tok2");
  expect(await fileTokenProvider("/nope", async () => { throw new Error("ENOENT /nope"); }).getToken()).toBeNull();
});
