import type { Declaration } from "../schema.js";
import { validateDeclaration } from "../validate.js";
import { compileKeycloak, type KeycloakSpec } from "./keycloak.js";
import { compilePgDdl } from "./pgddl.js";
import { compileRego } from "./rego.js";

export type Artifacts = { keycloak: KeycloakSpec; rego: string; pgddl: string };

/** 선언을 검증한 뒤 세 갈래 산출물로 컴파일한다. 검증 실패 시 컴파일하지 않는다. */
export function compileAll(d: Declaration): Artifacts {
  const errors = validateDeclaration(d);
  if (errors.length > 0) {
    throw new Error("선언 검증 실패:\n" + errors.map((e) => `  [${e.code}] ${e.message}`).join("\n"));
  }
  return { keycloak: compileKeycloak(d), rego: compileRego(d), pgddl: compilePgDdl(d) };
}

export { compileKeycloak, compilePgDdl, compileRego };
export type { KeycloakSpec };
