import type { Declaration } from "./schema.js";

export type ValidationError = { code: string; message: string };

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
    for (const grant of res.grants) {
      for (const role of grant.roles) {
        if (!known.has(role)) {
          errors.push({ code: "UNKNOWN_ROLE", message: `리소스 '${res.resource}'가 없는 롤 '${role}'을 참조한다` });
        }
      }
      // §5.4: PII 리소스는 마스킹 없이 select를 줄 수 없다
      const masked = Object.keys(grant.columnMask ?? {}).length > 0;
      if (res.classification === "pii" && grant.privileges.includes("select") && !masked) {
        errors.push({
          code: "PII_UNMASKED",
          message: `PII 리소스 '${res.resource}'에 마스킹 없이 select를 부여했다 (롤: ${grant.roles.join(", ")})`,
        });
      }
    }
  }

  return errors;
}
