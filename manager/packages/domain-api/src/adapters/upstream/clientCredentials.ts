// D-MCAT-4: exchange only the dedicated service credential, cache below expiry and coalesce refresh.
// Cost: one Keycloak round trip per token lifetime; escape hatch: use a rotated TOKEN_FILE instead.
import type { BearerTokenProvider } from "./tokenProvider.js";
import { normalizeToken } from "./tokenProvider.js";

export function clientCredentialsProvider(options: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  allowInsecureBearer: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): BearerTokenProvider {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { throw new Error("token endpoint must be an http(s) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("token endpoint must be an http(s) URL without credentials, query or fragment");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !options.allowInsecureBearer) {
    throw new Error("refusing client credentials over plain http without explicit opt-in");
  }
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string | null> | undefined;

  async function exchange(): Promise<string | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = now();
    const work = async () => {
      const response = await fetchImpl(url, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "openid",
          client_id: options.clientId, client_secret: options.clientSecret }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) return null;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const token = typeof body["access_token"] === "string" ? normalizeToken(body["access_token"]) : null;
      const ttl = body["expires_in"];
      if (!token || typeof body["token_type"] !== "string" || body["token_type"].toLowerCase() !== "bearer" ||
        typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 2 || ttl > 86400) return null;
      if (controller.signal.aborted) return null;
      cached = { token, until: started + ttl * 1000 - Math.min(30000, ttl * 100) };
      return now() < cached.until ? token : null;
    };
    try {
      return await Promise.race([work(), new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, 1500);
      })]);
    } catch { return null; } // Never expose Keycloak error bodies, tokens or secrets.
    finally { clearTimeout(timer); }
  }
  return {
    async getToken() {
      if (cached && now() < cached.until) return cached.token;
      cached = undefined; // Fail closed: an expired token is never reused on exchange failure.
      pending ??= exchange().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
