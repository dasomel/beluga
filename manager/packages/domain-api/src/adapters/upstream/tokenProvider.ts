// Credential source for upstream bearer tokens. Manager must not mint credentials: the token comes
// from deployment config (a mounted file, rotated outside this process, or an env var).
// Production guidance (docs/api-reference.md): use a dedicated Keycloak client with least-privilege
// read-only grants; never an admin token. A token value is never logged or put in an error.
import { readFileSync, statSync } from "node:fs";
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

// Startup check for a `*_TOKEN_FILE` variable: must exist, be a regular file, be readable and hold a valid
// non-empty token. Returns warnings (e.g. world-readable); throws a plain Error whose message never contains
// the file content (the caller wraps it in ConfigError naming the variable). The provider keeps re-reading
// lazily afterwards so rotation still works.
export function verifyTokenFile(path: string): string[] {
  let stats;
  try { stats = statSync(path); } catch { throw new Error("does not exist or is not accessible"); }
  if (!stats.isFile()) throw new Error("is not a regular file");
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { throw new Error("is not readable"); }
  if (content.trim() === "") throw new Error("is empty");
  if (normalizeToken(content) === null) throw new Error("does not contain a valid bearer token (content not shown)");
  return (stats.mode & 0o004) !== 0 ? ["is world-readable; restrict its permissions (e.g. 0400)"] : [];
}
