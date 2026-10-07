// Credential source for upstream bearer tokens. Manager must not mint credentials: the token comes
// from deployment config (a mounted file, rotated outside this process, or an env var).
// Production guidance (docs/api-reference.md): use a dedicated Keycloak client with least-privilege
// read-only grants; never an admin token. A token value is never logged or put in an error.
import { readFile } from "node:fs/promises";

export interface BearerTokenProvider {
  // null = no token available right now (adapter reports `unauthenticated` without sending a request).
  getToken(): Promise<string | null>;
}

// RFC 6750 b64token-ish plus JWT dots; rejects whitespace/control characters (header injection).
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

export function normalizeToken(raw: string | undefined | null): string | null {
  const token = raw?.trim();
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

export function staticTokenProvider(token: string | undefined): BearerTokenProvider {
  const normalized = normalizeToken(token);
  return { getToken: async () => normalized };
}

// Re-read on every call so a rotated projected/mounted token is picked up without a restart.
export function fileTokenProvider(path: string, read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): BearerTokenProvider {
  return {
    getToken: async () => {
      try {
        return normalizeToken(await read(path));
      } catch {
        return null; // do not echo the path/ENOENT detail upward
      }
    },
  };
}
