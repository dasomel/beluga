import { cmp } from "../compare.js";
import { toPgRole } from "../pgrole.js";
import type { Declaration, Privilege } from "../schema.js";

const PRIV_SQL: Record<Privilege, string> = {
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

// PRIV_SQL의 키 순서(선언 순서)가 privilegeSchema의 정준(canonical) 순서와 같다.
// 정의를 두 번 쓰지 않도록 이 배열 하나로 privilege 정렬을 구동한다 — 알파벳 정렬(plain
// .sort())은 delete/insert/select/update로 재배열되어 같은 권한 집합이라도 선언 순서가
// 다르면 다른 SQL 문자열을 만들어낸다. 순서 자체는 여전히 입력과 무관하게 고정이므로
// 결정론은 유지된다.
const PRIVILEGE_ORDER = Object.keys(PRIV_SQL) as Privilege[];

/**
 * 선언 → PostgreSQL DDL (멱등).
 * ALTER DEFAULT PRIVILEGES는 절대 생성하지 않는다 — 신규 테이블 자동 부여는
 * §10.1 "기본은 거부"를 위반한다.
 */
export function compilePgDdl(d: Declaration): string {
  const out: string[] = [
    "-- 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml",
    "",
    "-- 1. 권한 롤 (NOLOGIN, 상속 가능)",
  ];

  const roles = [...d.roles].sort((a, b) => cmp(a.name, b.name));

  for (const r of roles) {
    out.push(
      "DO $$",
      "BEGIN",
      `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${toPgRole(r.name)}') THEN`,
      `    CREATE ROLE ${toPgRole(r.name)} WITH NOLOGIN INHERIT;`,
      "  END IF;",
      "END $$;",
    );
  }

  out.push("", "-- 2. 롤 상속 (D19)");
  for (const r of roles) {
    for (const parent of [...(r.includes ?? [])].sort()) {
      out.push(`GRANT ${toPgRole(parent)} TO ${toPgRole(r.name)};`);
    }
  }

  out.push("", "-- 3. 스키마 및 테이블 권한 (allow-by-role, 명시적 GRANT만)");
  const resources = d.resources.filter((r) => r.engine === "postgres").sort((a, b) => cmp(a.resource, b.resource));
  const schemas = [...new Set(resources.map((r) => r.resource.split(".")[0] ?? ""))].sort(cmp);
  const schemaRoles = new Map<string, Set<string>>();
  const sequenceRoles = new Map<string, Set<string>>();

  for (const res of resources) {
    const schema = res.resource.split(".")[0] ?? "";
    const rolesForSchema = schemaRoles.get(schema) ?? new Set<string>();
    const rolesForSequences = sequenceRoles.get(schema) ?? new Set<string>();
    for (const grant of res.grants) {
      for (const role of grant.roles) {
        rolesForSchema.add(role);
        if (grant.privileges.includes("insert")) rolesForSequences.add(role);
      }
    }
    schemaRoles.set(schema, rolesForSchema);
    sequenceRoles.set(schema, rolesForSequences);
  }

  for (const schema of schemas) {
    for (const role of [...(schemaRoles.get(schema) ?? [])].sort(cmp)) {
      out.push(`GRANT USAGE ON SCHEMA ${schema} TO ${toPgRole(role)};`);
    }
  }

  for (const res of resources) {
    for (const grant of [...res.grants].sort((a, b) => cmp(a.roles.join(), b.roles.join()))) {
      const privs = [...grant.privileges]
        .sort((a, b) => PRIVILEGE_ORDER.indexOf(a) - PRIVILEGE_ORDER.indexOf(b))
        .map((p) => PRIV_SQL[p])
        .join(", ");
      for (const role of [...grant.roles].sort()) {
        out.push(`GRANT ${privs} ON TABLE ${res.resource} TO ${toPgRole(role)};`);
      }
    }
  }

  for (const schema of schemas) {
    for (const role of [...(sequenceRoles.get(schema) ?? [])].sort(cmp)) {
      out.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${toPgRole(role)};`);
    }
  }

  out.push("");
  return out.join("\n");
}
