import type { ActualState } from "./adapters/types.js";
import { cmp } from "./compare.js";
import type { Artifacts } from "./compiler/index.js";

export type DriftKind = "unapplied" | "manual" | "mismatch";
export type DriftItem = { kind: DriftKind; target: string; detail: string };

/**
 * 선언(desired)과 실제(actual)를 대조한다.
 * 세 종류로 분류한다: 미적용(unapplied) / 수동 변경(manual) / 값 불일치(mismatch) (설계서 §7.2)
 *
 * actual은 Partial이다 — Adapter.readState()는 자신이 아는 슬라이스만 보고할 수 있어서다.
 * 필드가 "없음"(undefined)과 "값이 비어 있음"([] / {})은 서로 다른 사실이다:
 *   - undefined  → 그 시스템을 아직 읽지 않았다. 해당 카테고리 비교를 통째로 건너뛴다.
 *   - [] / {}    → 그 시스템은 실제로 비어 있다고 확인됐다. 선언과 정면으로 비교한다.
 * 이 구분을 지키지 않으면 "아직 안 읽음"을 "전부 미적용"으로 과다 보고하거나, 반대로
 * 진짜 드리프트를 조용히 숨기는(과소 보고) 결함이 생긴다.
 */
export function diffState(desired: Artifacts, actual: Partial<ActualState>): DriftItem[] {
  const items: DriftItem[] = [];

  if (actual.keycloakRoles !== undefined) {
    diffKeycloakRoles(desired, actual.keycloakRoles, items);
  }
  if (actual.keycloakGroups !== undefined) {
    diffKeycloakGroups(desired, actual.keycloakGroups, items);
  }
  if (actual.pgGrants !== undefined) {
    diffPgGrants(desired, actual.pgGrants, items);
  }

  // 실제 시스템 조회 결과(배열 순서, 객체 키 순서)는 순서를 보장하지 않는다. 항목의
  // 내용만으로 전순서를 만들어 입력 순서와 무관하게 매번 같은 출력을 강제한다.
  return items.sort((a, b) => cmp(`${a.kind}|${a.target}`, `${b.kind}|${b.target}`) || cmp(a.detail, b.detail));
}

function diffKeycloakRoles(desired: Artifacts, actualRoles: string[], items: DriftItem[]): void {
  const desiredNames = desired.keycloak.realmRoles.map((r) => r.name);
  const desiredSet = new Set(desiredNames);
  const actualSet = new Set(actualRoles);

  for (const name of desiredNames) {
    if (!actualSet.has(name)) {
      items.push({ kind: "unapplied", target: `keycloak.role/${name}`, detail: "선언됨, 실제 없음" });
    }
  }
  for (const name of actualRoles) {
    if (!desiredSet.has(name)) {
      items.push({ kind: "manual", target: `keycloak.role/${name}`, detail: "실제에만 존재 — 수동 변경 의심" });
    }
  }
}

function diffKeycloakGroups(desired: Artifacts, actualGroups: Record<string, string[]>, items: DriftItem[]): void {
  const desiredGroupNames = new Set(desired.keycloak.groups.map((g) => g.name));

  for (const g of desired.keycloak.groups) {
    const actualRolesOfGroup = actualGroups[g.name];
    if (actualRolesOfGroup === undefined) {
      items.push({ kind: "unapplied", target: `keycloak.group/${g.name}`, detail: "선언됨, 실제 없음" });
      continue;
    }
    const want = [...g.realmRoles].sort(cmp).join(",");
    const have = [...actualRolesOfGroup].sort(cmp).join(",");
    if (want !== have) {
      items.push({
        kind: "mismatch",
        target: `keycloak.group/${g.name}`,
        detail: `롤 구성이 다르다 — 선언: [${want}], 실제: [${have}]`,
      });
    }
  }

  for (const name of Object.keys(actualGroups)) {
    if (!desiredGroupNames.has(name)) {
      items.push({ kind: "manual", target: `keycloak.group/${name}`, detail: "실제에만 존재 — 수동 변경 의심" });
    }
  }
}

type ParsedGrant = { table: string; role: string; privileges: string };

/** pgddl.ts가 만드는 `GRANT <privs> ON TABLE <table> TO <role>;` 한 줄을 분해한다. */
function parseGrantLine(line: string): ParsedGrant | null {
  const m = /^GRANT (.+) ON TABLE (\S+) TO (\S+);$/.exec(line.trim());
  if (!m) return null;
  const [, privileges, table, role] = m;
  if (privileges === undefined || table === undefined || role === undefined) return null;
  return { privileges, table, role };
}

/**
 * 선언에서 나오는 PG 테이블 권한(GRANT ... ON TABLE ... TO ...) 문장만 추린다.
 * 롤 생성(CREATE ROLE)·상속(GRANT role TO role) 문장은 다루지 않는다 — 그 둘은 멱등
 * 부트스트랩이고 pgddl.ts가 이미 존재 확인 후에만 실행하도록 짜여 있다(§10.1). 실제로
 * 어긋날 수 있는 것은 테이블 권한 부여뿐이다.
 */
function desiredPgGrants(desired: Artifacts): Map<string, ParsedGrant> {
  const out = new Map<string, ParsedGrant>();
  for (const line of desired.pgddl.split("\n")) {
    if (!line.startsWith("GRANT") || !line.includes(" ON TABLE ")) continue;
    const g = parseGrantLine(line);
    if (g) out.set(`${g.table}/${g.role}`, g);
  }
  return out;
}

function diffPgGrants(desired: Artifacts, actualGrants: string[], items: DriftItem[]): void {
  const desiredByKey = desiredPgGrants(desired);

  const actualByKey = new Map<string, ParsedGrant>();
  for (const line of actualGrants) {
    const g = parseGrantLine(line);
    if (g) actualByKey.set(`${g.table}/${g.role}`, g);
  }

  for (const [key, g] of desiredByKey) {
    const a = actualByKey.get(key);
    if (a === undefined) {
      items.push({ kind: "unapplied", target: `pg.grant/${key}`, detail: `선언됨, 실제 없음 — ${g.privileges}` });
    } else if (a.privileges !== g.privileges) {
      items.push({
        kind: "mismatch",
        target: `pg.grant/${key}`,
        detail: `권한 집합이 다르다 — 선언: [${g.privileges}], 실제: [${a.privileges}]`,
      });
    }
  }
  for (const [key, a] of actualByKey) {
    if (!desiredByKey.has(key)) {
      items.push({
        kind: "manual",
        target: `pg.grant/${key}`,
        detail: `실제에만 존재 — 수동 변경 의심 (${a.privileges})`,
      });
    }
  }
}
