import { cmp } from "../compare.js";
import { toPgLoginIdentifier, toPgRole } from "../pgrole.js";
import type { Declaration, Privilege } from "../schema.js";
import { expandRoles } from "../validate.js";

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

  // beluga #107(D-3): LOGIN 계정 + CONNECT 자동화. 레거시 특권 롤 정리(섹션 6)와 CNPG
  // beluga_admin 멤버십 바인딩은 일회성/외부 소유 관심사라 Epilogue에 수기로 남는다(D-3) —
  // 여기서는 D20 LOGIN 계정 생성, 정책 롤 바인딩, CONNECT 그랜트만 다룬다.
  const logins = [...(d.logins ?? [])].sort((a, b) => cmp(a.name, b.name));

  if (logins.length > 0) {
    out.push("", "-- 4. LOGIN 계정 (D20, LDAP uid — 하이픈 보존, toPgRole() 미적용)");
    out.push("DO $$", "BEGIN");
    for (const login of logins) {
      out.push(
        `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${login.name}') THEN`,
        `    CREATE ROLE ${toPgLoginIdentifier(login.name)} WITH LOGIN INHERIT;`,
        "  END IF;",
      );
    }
    out.push("END $$;");

    out.push("", "-- 5. LOGIN 계정을 정책 롤에 바인딩");
    for (const login of logins) {
      for (const role of [...login.memberOf].sort(cmp)) {
        out.push(`GRANT ${toPgRole(role)} TO ${toPgLoginIdentifier(login.name)};`);
      }
    }

    // CONNECT는 LOGIN 계정이 아니라 테이블 그랜트를 실제로 받는 정책 롤에 부여한다(§3의
    // USAGE ON SCHEMA와 같은 패턴) — LOGIN 계정은 GRANT <role> TO <login>으로 그 롤을
    // 상속하므로 CONNECT도 함께 상속된다. 이 프로젝트는 물리 DB 하나만 배포하므로(§3의
    // DEPLOYED_CATALOG D-H와 같은 결정) 리소스 자체에는 database 필드가 없고, logins[].database가
    // 그 하나뿐인 대상 DB를 가리킨다.
    const postgresGrantRoles = new Set<string>();
    for (const res of resources) {
      for (const grant of res.grants) {
        for (const role of grant.roles) postgresGrantRoles.add(role);
      }
    }
    // 수정 라운드 1: CONNECT 과다 부여 방지. 이전에는 테이블 그랜트를 가진 모든 롤 × 선언된
    // 모든 database의 전체 곱집합에 CONNECT를 부여해, 그 DB를 가리키는 LOGIN이 하나도 없는
    // 롤에도 접속 권한이 새어나갔다.
    //
    // 수정 라운드 2(2차 보안 리뷰 Defect B): 위 스코핑이 memberOf 직접 멤버십만 보고
    // includes 상속을 놓쳤다 — `analysts`가 `readers`를 includes하고 `readers`만 테이블
    // 그랜트를 가진 경우, `alice`(memberOf: [analysts])는 SELECT는 상속받지만(GRANT
    // readers TO analysts; GRANT analysts TO alice로 롤 체인 상속) CONNECT 교집합에서는
    // `readers`가 alice의 memberOf에 직접 없어 빠져 CONNECT를 못 받는 결함이 있었다.
    // expandRoles(자신 + 상속한 모든 includes, validate.ts와 동일 헬퍼 — 정책 롤 특권
    // 상속 계산의 단일 출처)로 database별 도달 가능 롤 집합을 transitively 계산한다.
    const rolesByDatabase = new Map<string, Set<string>>();
    for (const login of logins) {
      const roles = rolesByDatabase.get(login.database) ?? new Set<string>();
      for (const role of login.memberOf) {
        for (const reachable of expandRoles(d, role)) roles.add(reachable);
      }
      rolesByDatabase.set(login.database, roles);
    }
    const databases = [...rolesByDatabase.keys()].sort(cmp);
    if (postgresGrantRoles.size > 0 && databases.length > 0) {
      out.push("", "-- 6. CONNECT 권한 (테이블 그랜트 + 해당 DB의 LOGIN memberOf 교집합에서 유도)");
      for (const database of databases) {
        const reachableRoles = rolesByDatabase.get(database) ?? new Set<string>();
        for (const role of [...postgresGrantRoles].filter((r) => reachableRoles.has(r)).sort(cmp)) {
          out.push(`GRANT CONNECT ON DATABASE ${database} TO ${toPgRole(role)};`);
        }
      }
    }
  }

  out.push("");
  return out.join("\n");
}
