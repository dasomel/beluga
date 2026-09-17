import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "vitest";

// bin/policyctl.ts는 셔뱅만 있고 실행 비트/bin 필드가 없어 npm run 경유로만 동작한다
// (Minor 3). 테스트에서는 tsx 로더를 node로 직접 구동해 같은 경로를 재현한다.
const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const policyctlEntry = fileURLToPath(new URL("../bin/policyctl.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxBin, policyctlEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const VALID_ROLES = "roles:\n  - name: analyst\n";
const VALID_GROUPS = "groups:\n  - name: analysts\n    roles: [analyst]\n";
const VALID_RESOURCES = [
  "resources:",
  "  - resource: lake.t",
  "    classification: internal",
  "    grants:",
  "      - roles: [analyst]",
  "        privileges: [select]",
  "",
].join("\n");

function writeValidPolicies(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roles.yaml"), VALID_ROLES);
  writeFileSync(join(dir, "groups.yaml"), VALID_GROUPS);
  writeFileSync(join(dir, "resources.yaml"), VALID_RESOURCES);
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "policyctl-cli-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("--out 누락 시 exit 2", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);

  const result = runCli(["compile", policiesDir]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--out");
});

test("무효 선언은 산출물을 만들지 않는다 (출력 디렉터리조차 생기지 않는다)", () => {
  const policiesDir = join(workDir, "policies");
  mkdirSync(policiesDir, { recursive: true });
  writeFileSync(join(policiesDir, "roles.yaml"), "roles: []\n");
  writeFileSync(join(policiesDir, "groups.yaml"), "groups: []\n");
  writeFileSync(
    join(policiesDir, "resources.yaml"),
    [
      "resources:",
      "  - resource: lake.customers",
      "    classification: pii",
      "    grants:",
      "      - roles: [ghost]",
      "        privileges: [select]",
      "",
    ].join("\n"),
  );
  const outDir = join(workDir, "out");

  const result = runCli(["compile", policiesDir, "--out", outDir]);

  expect(result.status).toBe(1);
  expect(existsSync(outDir)).toBe(false);
  // 스택 트레이스가 아니라 검증 에러 코드가 담긴 깨끗한 메시지여야 한다(Important 4)
  expect(result.stderr).toContain("UNKNOWN_ROLE");
  expect(result.stderr).not.toMatch(/^\s*at /m);
  expect(result.stderr).not.toContain("node:internal");
});

test("동일 입력을 두 번 컴파일하면 산출물이 바이트 단위로 동일하다", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);
  const outDir1 = join(workDir, "out1");
  const outDir2 = join(workDir, "out2");

  const r1 = runCli(["compile", policiesDir, "--out", outDir1]);
  const r2 = runCli(["compile", policiesDir, "--out", outDir2]);

  expect(r1.status).toBe(0);
  expect(r2.status).toBe(0);
  for (const name of ["trino.rego", "roles.sql", "keycloak.json"]) {
    const a = readFileSync(join(outDir1, name));
    const b = readFileSync(join(outDir2, name));
    expect(a.equals(b)).toBe(true);
  }
});

test("잉여 위치 인자는 exit 2 (Minor 1)", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);
  const outDir = join(workDir, "out");

  const result = runCli(["compile", policiesDir, "EXTRA", "--out", outDir]);

  expect(result.status).toBe(2);
  expect(existsSync(outDir)).toBe(false);
});

test("알 수 없는 옵션은 그 이름을 그대로 보고한다 (Minor 1)", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);

  const result = runCli(["compile", policiesDir, "--outt", join(workDir, "out")]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--outt");
});

test("--out을 <dir> 앞에 둬도 정상 동작한다 (Minor 1)", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);
  const outDir = join(workDir, "out");

  const result = runCli(["compile", "--out", outDir, policiesDir]);

  expect(result.status).toBe(0);
  expect(existsSync(join(outDir, "trino.rego"))).toBe(true);
});

test("깨진 YAML은 스택 없이 파일명·위치가 담긴 메시지로 exit 1 (Important 4)", () => {
  const policiesDir = join(workDir, "policies");
  mkdirSync(policiesDir, { recursive: true });
  writeFileSync(join(policiesDir, "roles.yaml"), "roles: [1,2\n");
  writeFileSync(join(policiesDir, "groups.yaml"), "groups: []\n");
  writeFileSync(join(policiesDir, "resources.yaml"), "resources: []\n");

  const result = runCli(["compile", policiesDir, "--out", join(workDir, "out")]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("roles.yaml");
  expect(result.stderr).not.toMatch(/^\s*at /m);
  expect(result.stderr).not.toContain("node:internal");
});

test("--out이 이미 파일을 가리키면 스택 없이 exit 1 (Important 4)", () => {
  const policiesDir = join(workDir, "policies");
  writeValidPolicies(policiesDir);
  const outAsFile = join(workDir, "out-is-a-file");
  writeFileSync(outAsFile, "");

  const result = runCli(["compile", policiesDir, "--out", outAsFile]);

  expect(result.status).toBe(1);
  expect(result.stderr).not.toMatch(/^\s*at /m);
});
