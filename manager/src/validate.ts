import type { Declaration } from "./schema.js";

export type ValidationError = { code: string; message: string };

// §5.4: rowFilter는 선언에서 Trino 행 필터로 그대로 흘러간다. 허용 문법을 열거하고
// 그 외는 전부 거부한다. 위험한 토큰을 나열하는 블랙리스트는 빠뜨린 하나로 뚫린다.
const IDENT = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?`;
const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const STRING = String.raw`'[^'\\]*'`;
const SESSION = String.raw`current_user`;
const VALUE = `(?:${NUMBER}|${STRING}|${SESSION})`;
const IN_LIST = String.raw`\(\s*` + VALUE + String.raw`(?:\s*,\s*` + VALUE + String.raw`)*\s*\)`;
const COMPARISON = String.raw`(?:<>|!=|<=|>=|=|<|>)`;
const TERM = `(?:${IDENT}\\s*${COMPARISON}\\s*${VALUE}|${IDENT}\\s+IN\\s*${IN_LIST})`;

// AND와 OR을 섞으면 괄호 없이는 우선순위가 글로 읽히는 것과 달라진다
// (A AND B OR C == (A AND B) OR C). 한 종류만 허용해 그 함정을 없앤다.
const AND_CHAIN = new RegExp(`^\\s*${TERM}(?:\\s+AND\\s+${TERM})*\\s*$`, "i");
const OR_CHAIN = new RegExp(`^\\s*${TERM}(?:\\s+OR\\s+${TERM})*\\s*$`, "i");
const ROW_FILTER_MAX_LENGTH = 200;

/** 롤 상속을 확장한다. 자신을 포함하고, 결정론적으로 정렬해 반환한다. */
export function expandRoles(d: Declaration, roleName: string): string[] {
  const byName = new Map(d.roles.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const parent of byName.get(name)?.includes ?? []) walk(parent);
  };
  walk(roleName);
  return [...seen].sort();
}

function findCycle(d: Declaration): string[] | null {
  const byName = new Map(d.roles.map((r) => [r.name, r]));
  const state = new Map<string, "visiting" | "done">();
  let cycle: string[] | null = null;

  const walk = (name: string, path: string[]) => {
    if (cycle) return;
    if (state.get(name) === "visiting") {
      cycle = [...path, name];
      return;
    }
    if (state.get(name) === "done") return;
    state.set(name, "visiting");
    for (const parent of byName.get(name)?.includes ?? []) walk(parent, [...path, name]);
    state.set(name, "done");
  };

  for (const r of d.roles) walk(r.name, []);
  return cycle;
}

export function validateDeclaration(d: Declaration): ValidationError[] {
  const errors: ValidationError[] = [];
  const known = new Set(d.roles.map((r) => r.name));

  const cycle = findCycle(d);
  if (cycle) {
    errors.push({
      code: "CYCLIC_INHERITANCE",
      message: `롤 상속에 순환이 있다: ${cycle.join(" -> ")}`,
    });
  }

  for (const r of d.roles) {
    for (const parent of r.includes ?? []) {
      if (!known.has(parent)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `롤 '${r.name}'이 없는 롤 '${parent}'을 상속한다` });
      }
    }
  }

  for (const g of d.groups) {
    for (const role of g.roles) {
      if (!known.has(role)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `그룹 '${g.name}'이 없는 롤 '${role}'을 참조한다` });
      }
    }
  }

  for (const res of d.resources) {
    const sensitive = res.sensitiveColumns ?? [];
    if (res.classification === "pii" && sensitive.length === 0) {
      errors.push({
        code: "PII_NO_SENSITIVE_COLUMNS",
        message: `PII 리소스 '${res.resource}'에 sensitiveColumns가 없다 — 무엇을 가려야 하는지 선언하지 않으면 마스킹을 강제할 수 없다`,
      });
    }

    for (const grant of res.grants) {
      for (const role of grant.roles) {
        if (!known.has(role)) {
          errors.push({ code: "UNKNOWN_ROLE", message: `리소스 '${res.resource}'가 없는 롤 '${role}'을 참조한다` });
        }
      }

      // §5.4: rowFilter는 선언에서 Trino 행 필터로 그대로 흘러간다. 허용 문법만 수용한다.
      if (grant.rowFilter !== undefined) {
        const isValid = (AND_CHAIN.test(grant.rowFilter) || OR_CHAIN.test(grant.rowFilter)) && grant.rowFilter.length <= ROW_FILTER_MAX_LENGTH;
        if (!isValid) {
          errors.push({
            code: "ROW_FILTER_REJECTED",
            message: `리소스 '${res.resource}'의 rowFilter가 허용 문법이 아니다. AND와 OR을 섞을 수 없으며, 괄호는 미지원된다: ${grant.rowFilter}`,
          });
        }
      }

      // §5.4: PII 리소스의 모든 민감 컬럼은 마스킹되어야 한다 (allowUnmasked: true로 명시되지 않은 한)
      const masked = new Set(Object.keys(grant.columnMask ?? {}));
      const uncovered = sensitive.filter((c) => !masked.has(c));
      if (
        res.classification === "pii" &&
        grant.privileges.includes("select") &&
        grant.allowUnmasked !== true &&
        uncovered.length > 0
      ) {
        errors.push({
          code: "PII_UNMASKED",
          message: `PII 리소스 '${res.resource}'의 민감 컬럼 ${uncovered.join(", ")}이(가) 마스킹되지 않은 채 select에 노출된다 (롤: ${grant.roles.join(", ")})`,
        });
      }
    }
  }

  return errors;
}
