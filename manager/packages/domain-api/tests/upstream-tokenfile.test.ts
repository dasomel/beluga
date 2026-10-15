import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { TRINO_HISTORY_ACK_VALUE, loadUpstreamWiring } from "../src/adapters/upstream/config.js";
import { fileTokenProvider } from "../src/adapters/upstream/tokenProvider.js";
import { ConfigError } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "beluga-token-"));
const SECRET = "eyJhbGciOiJSUzI1NiJ9.FILE-SECRET.sig";
const file = (name: string, content: string, mode = 0o600) => {
  const p = join(dir, name);
  writeFileSync(p, content, { mode });
  chmodSync(p, mode);
  return p;
};
const trino = (tokenFile: string) => ({
  BELUGA_TRINO_ENABLED: "true", BELUGA_TRINO_BASE_URL: "https://trino.example", BELUGA_TRINO_TOKEN_FILE: tokenFile,
  BELUGA_TRINO_HISTORY_ACK: TRINO_HISTORY_ACK_VALUE,
});
const lakekeeper = (tokenFile: string) => ({
  BELUGA_LAKEKEEPER_ENABLED: "true", BELUGA_LAKEKEEPER_BASE_URL: "https://catalog.example", BELUGA_LAKEKEEPER_WAREHOUSES: "w",
  BELUGA_LAKEKEEPER_TOKEN_FILE: tokenFile,
});
const message = (env: Record<string, string>) => {
  try { loadUpstreamWiring(env); } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as Error).message; }
  throw new Error("expected ConfigError");
};

test.each([
  ["trino", trino, "BELUGA_TRINO_TOKEN_FILE"],
  ["lakekeeper", lakekeeper, "BELUGA_LAKEKEEPER_TOKEN_FILE"],
] as const)("%s: bad token files fail at startup naming the variable, never the content", (_n, make, variable) => {
  mkdirSync(join(dir, "adir"), { recursive: true });
  const cases: Array<[string, string, RegExp]> = [
    ["missing", join(dir, "nonexistent", "x"), /does not exist/],
    ["directory", join(dir, "adir"), /not a regular file/],
    ["empty", file("empty", ""), /is empty/],
    ["whitespace only", file("ws", " \n\t"), /is empty/],
    ["invalid content", file("bad", `${SECRET} with spaces\nX-Evil: 1`), /valid bearer token/],
  ];
  for (const [, path, pattern] of cases) {
    const msg = message(make(path));
    expect(msg).toContain(variable);
    expect(msg).toMatch(pattern);
    expect(msg).not.toContain("FILE-SECRET");
  }
});

test("unreadable file fails at startup (skipped when running as root)", () => {
  if (process.getuid?.() === 0) return;
  const p = file("noread", SECRET, 0o000);
  expect(message(trino(p))).toMatch(/not readable/);
});

test("valid file loads; world-readable only warns; rotation is still picked up lazily", async () => {
  const ok = loadUpstreamWiring(trino(file("ok", `${SECRET}\n`, 0o400)));
  expect(ok.queryHistoryAdapter).toBeDefined();
  expect(ok.diagnostics.filter((d) => d.startsWith("warning"))).toEqual([]);
  const open = loadUpstreamWiring(lakekeeper(file("open", SECRET, 0o644)));
  expect(open.dataAssetSource).toBeDefined();
  expect(open.diagnostics.join("\n")).toContain("BELUGA_LAKEKEEPER_TOKEN_FILE is world-readable");
  expect(open.diagnostics.join("\n")).not.toContain("FILE-SECRET");
  const rotating = file("rot", "tok.one");
  const provider = fileTokenProvider(rotating);
  expect(await provider.getToken()).toBe("tok.one");
  writeFileSync(rotating, "tok.two");
  expect(await provider.getToken()).toBe("tok.two");
});

test("server.ts: a ConfigError prints one clean line (no stack) and exits 1, like the Flink adapter", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const run = (env: Record<string, string>) =>
    spawnSync("npx", ["tsx", "src/server.ts"], { cwd, env: { ...process.env, PORT: "0", ...env }, encoding: "utf8", timeout: 60_000 });
  for (const [env, needle] of [
    [trino(join(dir, "nonexistent", "x")), "BELUGA_TRINO_TOKEN_FILE"],
    [{ BELUGA_FLINK_REST_URL: "nope" }, "BELUGA_FLINK_REST_URL"],
  ] as const) {
    const result = run({ ...env });
    expect(result.status).toBe(1);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Configuration error:");
    expect(lines[0]).toContain(needle);
    expect(result.stderr).not.toContain("    at ");
  }
}, 120_000);
