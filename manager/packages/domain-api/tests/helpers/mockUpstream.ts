// Test helper: a fetch double driven by a route table. Fixtures that use it are SPEC-DERIVED (built from
// the documented Trino 483 BasicQueryInfo / Iceberg REST OpenAPI shapes), NOT recorded from a live cluster.
export interface RecordedCall { url: URL; headers: Headers; method: string; redirect: string | undefined }
export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function mockFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const call = { url: new URL(String(input)), headers: new Headers(init?.headers), method: init?.method ?? "GET", redirect: init?.redirect };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason;
    return await Promise.race([
      Promise.resolve(responder(call)),
      new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    ]);
  }) as typeof fetch;
  return { impl, calls };
}

export const hangForever: Responder = () => new Promise<Response>(() => {});
