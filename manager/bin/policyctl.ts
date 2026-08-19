#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileAll } from "../src/compiler/index.js";
import { declarationSchema, groupSchema, resourceSchema, roleSchema, type Declaration } from "../src/schema.js";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

// npm 스크립트로만 노출된다 (package.json에 bin 필드 없음, 실행 비트 없음) — 사용법
// 메시지는 실제로 동작하는 호출 형태를 안내한다.
const USAGE = "사용법: npm run policyctl -- compile <policies-dir> --out <dir>";

/** 사용자(정책 선언 작성자) 원인 오류. main()에서 스택 없이 메시지만 출력하고 exit 1. */
class UserError extends Error {}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function formatZodIssues(issues: z.ZodError["issues"]): string {
  return issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

// 파일별 최상위 스키마 — declarationSchema의 배열 요소 스키마를 그대로 재사용해
// "resourcs:" 같은 최상위 키 오타를 이 층에서 바로 잡는다(Minor 2).
const rolesFileSchema = z.strictObject({ roles: z.array(roleSchema) });
const groupsFileSchema = z.strictObject({ groups: z.array(groupSchema) });
const resourcesFileSchema = z.strictObject({ resources: z.array(resourceSchema) });

function readYamlFile(dir: string, name: string): unknown {
  const path = join(dir, name);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new UserError(`파일을 찾을 수 없다: ${path}`);
    }
    throw err;
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const firstLine = (err.message.split("\n")[0] ?? err.message).replace(/:$/, "");
      throw new UserError(`${path}: YAML 파싱 실패 — ${firstLine}`);
    }
    throw err;
  }
}

function readPolicyFile<T>(dir: string, name: string, schema: z.ZodType<T>): T {
  const result = schema.safeParse(readYamlFile(dir, name));
  if (!result.success) {
    throw new UserError(`${name}:\n${formatZodIssues(result.error.issues)}`);
  }
  return result.data;
}

function loadPolicies(dir: string): Declaration {
  const { roles } = readPolicyFile(dir, "roles.yaml", rolesFileSchema);
  const { groups } = readPolicyFile(dir, "groups.yaml", groupsFileSchema);
  const { resources } = readPolicyFile(dir, "resources.yaml", resourcesFileSchema);
  return declarationSchema.parse({ roles, groups, resources });
}

function parseArgs(argv: string[]): { dir: string; outDir: string } {
  const [cmd, ...rest] = argv;
  if (cmd !== "compile") {
    console.error(USAGE);
    process.exit(2);
  }

  const positionals: string[] = [];
  let outDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--out") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("--out 뒤에 디렉터리 경로가 필요하다");
        process.exit(2);
      }
      outDir = value;
      i++;
    } else if (arg.startsWith("--")) {
      console.error(`알 수 없는 옵션: ${arg}`);
      process.exit(2);
    } else {
      positionals.push(arg);
    }
  }

  const [dir, ...extra] = positionals;
  if (dir === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  if (extra.length > 0) {
    console.error(`예상치 못한 인자: ${extra.join(" ")}`);
    process.exit(2);
  }
  if (!outDir) {
    console.error("--out <dir> 이 필요하다");
    process.exit(2);
  }
  return { dir, outDir };
}

/** 사용자 원인 오류는 메시지만 출력하고 exit 1. 분류되지 않는 오류는 다시 던져
 * 내부 결함으로서 스택 트레이스가 남게 한다(검증-우선 구조는 여기서 바꾸지 않는다). */
function reportUserErrorOrRethrow(err: unknown, outDir: string): never {
  if (err instanceof UserError) {
    console.error(err.message);
    process.exit(1);
  }
  if (err instanceof Error && err.message.startsWith("선언 검증 실패")) {
    console.error(err.message);
    process.exit(1);
  }
  if (isErrnoException(err) && err.code === "EEXIST") {
    console.error(`출력 경로가 이미 파일로 존재한다: ${err.path ?? outDir}`);
    process.exit(1);
  }
  throw err;
}

function main() {
  const { dir, outDir } = parseArgs(process.argv.slice(2));
  try {
    const artifacts = compileAll(loadPolicies(dir));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "trino.rego"), artifacts.rego);
    writeFileSync(join(outDir, "roles.sql"), artifacts.pgddl);
    writeFileSync(join(outDir, "keycloak.json"), JSON.stringify(artifacts.keycloak, null, 2) + "\n");
    console.log(`컴파일 완료 → ${outDir} (trino.rego, roles.sql, keycloak.json)`);
  } catch (err) {
    reportUserErrorOrRethrow(err, outDir);
  }
}

main();
