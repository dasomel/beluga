#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileAll } from "../src/compiler/index.js";
import { declarationSchema, type Declaration } from "../src/schema.js";
import { parse as parseYaml } from "yaml";

function loadPolicies(dir: string): Declaration {
  const read = (name: string) => parseYaml(readFileSync(join(dir, name), "utf8"));
  return declarationSchema.parse({
    roles: read("roles.yaml").roles,
    groups: read("groups.yaml").groups,
    resources: read("resources.yaml").resources,
  });
}

function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (cmd !== "compile" || !dir) {
    console.error("사용법: policyctl compile <policies-dir> --out <dir>");
    process.exit(2);
  }
  const outIdx = rest.indexOf("--out");
  const outDir = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  if (!outDir) {
    console.error("--out <dir> 이 필요하다");
    process.exit(2);
  }

  const artifacts = compileAll(loadPolicies(dir));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "trino.rego"), artifacts.rego);
  writeFileSync(join(outDir, "roles.sql"), artifacts.pgddl);
  writeFileSync(join(outDir, "keycloak.json"), JSON.stringify(artifacts.keycloak, null, 2) + "\n");
  console.log(`컴파일 완료 → ${outDir} (trino.rego, roles.sql, keycloak.json)`);
}

main();
