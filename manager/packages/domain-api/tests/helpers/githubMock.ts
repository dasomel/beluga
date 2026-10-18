// A fetch double for the GitHub REST API driven by a route table (METHOD + path regex). Requests that match no
// route are recorded in `unmatched` and answered 599, so a test can assert that nothing unexpected was called.
// Fixtures are SPEC-DERIVED from the documented GitHub REST shapes, NOT recorded from the live API.
import crypto from "node:crypto";

export interface GhCall {
  method: string;
  path: string; // pathname + search, as sent (still percent-encoded)
  body: Record<string, unknown> | undefined;
  headers: Headers;
}
type Responder = (call: GhCall, match: RegExpMatchArray) => Response | Promise<Response>;

export const ghJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function githubMock() {
  const routes: { method: string; re: RegExp; res: Responder }[] = [];
  const calls: GhCall[] = [];
  const unmatched: GhCall[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: GhCall = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason;
    for (const route of routes) {
      const match = route.method === call.method ? call.path.match(route.re) : null;
      if (match) return route.res(call, match);
    }
    unmatched.push(call);
    return ghJson({ message: "unmatched in test" }, 599);
  }) as typeof fetch;
  return {
    impl,
    calls,
    unmatched,
    /** Later registrations win, so a test can override the defaults. */
    on(method: string, re: RegExp, res: Responder) {
      routes.unshift({ method, re, res });
    },
    reset() {
      calls.length = 0;
      unmatched.length = 0;
    },
  };
}

export const testKeyPem = (() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
})();
export const testPublicKey = crypto.createPublicKey(testKeyPem);
