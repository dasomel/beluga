import type { ActualState } from "./adapters/types.js";
import { cmp } from "./compare.js";
import type { Artifacts } from "./compiler/index.js";

export type DriftKind = "unapplied" | "manual" | "mismatch";
export type DriftItem = { kind: DriftKind; target: string; detail: string };

/** diffState가 실제로 대조를 수행한 카테고리. ActualState의 키와 동일하다. */
export type DriftCategory = keyof ActualState;

/**
 * diffState의 결과. items만으로는 "드리프트 없음"과 "이 카테고리를 아예 대조하지
 * 않았음"을 구분할 수 없다(I2) — 예를 들어 PG 조회가 타임아웃 나서 어댑터가
 * keycloakRoles만 돌려주면 PG 드리프트가 items에서 통째로 사라지는데, 그 결과가
 * "PG가 완전히 깨끗함"과 바이트 단위로 같아진다. checked가 실제로 대조된 카테고리를
 * 명시해서, 호출자(장래 UI 등)가 "드리프트 0"과 "이 카테고리는 미조회"를 구분해
 * 표시할 수 있게 한다.
 */
export type DriftReport = { items: DriftItem[]; checked: DriftCategory[] };

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
export function diffState(desired: Artifacts, actual: Partial<ActualState>): DriftReport {
  const items: DriftItem[] = [];
  const checked: DriftCategory[] = [];

  if (actual.keycloakRoles !== undefined) {
    diffKeycloakRoles(desired, actual.keycloakRoles, items);
    checked.push("keycloakRoles");
  }
  if (actual.keycloakGroups !== undefined) {
    diffKeycloakGroups(desired, actual.keycloakGroups, items);
    checked.push("keycloakGroups");
  }
  if (actual.pgGrants !== undefined) {
    diffPgGrants(desired, actual.pgGrants, items);
    checked.push("pgGrants");
  }

  // 실제 시스템 조회 결과(배열 순서, 객체 키 순서)는 순서를 보장하지 않는다. 항목의
  // 내용만으로 전순서를 만들어 입력 순서와 무관하게 매번 같은 출력을 강제한다.
  //
  // 정렬 키는 kind를 알파벳 순으로 묶는다(manual < mismatch < unapplied) — 심각도도
  // 대상 순서도 아니라 우연한 문자열 순서다. 화면에 표시할 때는 별도로 재정렬한다는
  // 전제하에 여기서는 결정론만 보장한다(M2).
  //
  // `|| cmp(a.detail, b.detail)` 타이브레이크는 **제거하면 안 된다**. 미해석 GRANT 문장은
  // 전부 target이 "pg.grant/unparsed"로 같고 detail(원문)만 다르므로, 같은 kind+target에
  // 서로 다른 detail이 여럿 존재한다. 이 타이브레이크가 없으면 unparsed 항목의 순서가
  // 입력 배열 순서에 의존해 유령 diff가 난다.
  items.sort((a, b) => cmp(`${a.kind}|${a.target}`, `${b.kind}|${b.target}`) || cmp(a.detail, b.detail));

  return { items, checked };
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

/**
 * PG GRANT 문장 하나를 분해한 정규화 결과. privileges는 대소문자·나열 순서·공백을
 * 정규화한 뒤 만든 집합이다 — 어댑터가 권한을 어떤 순서·표기로 돌려주든 같은 권한
 * 집합이면 같은 비교 결과가 나와야 한다(I1). 원시 문자열로 비교하면 안 된다.
 */
type ParsedGrant = { table: string; role: string; privileges: Set<string> };

/**
 * PG 식별자를 감싼 큰따옴표를 벗긴다. 선언 측은 식별자를 절대 따옴표로 감싸지 않는다
 * (pgddl.ts, toPgRole 참조)지만, 실제 상태를 돌려주는 어댑터는 `pg_dump` 계열
 * 직렬화처럼 식별자를 항상 큰따옴표로 감싸 반환할 수 있다. 벗기지 않으면
 * `public.orders`와 `"public"."orders"`가 다른 키로 취급되어 유령
 * unapplied+manual 쌍이 생긴다.
 */
function stripQuotes(ident: string): string {
  return ident.replace(/"/g, "");
}

/**
 * `GRANT <privs> ON [TABLE] <table> TO <role> [WITH GRANT OPTION][;]` 한 줄을 분해한다.
 * 이 함수가 실제(actual) 어댑터 구현이 지켜야 할 계약을 인코딩한다:
 *   - TABLE 키워드는 SQL 표준상 선택이라 없어도 인식한다.
 *   - 키워드·권한 이름 모두 대소문자를 구분하지 않는다(대문자로 정규화한다).
 *   - 세미콜론은 있어도 없어도 된다.
 *   - WITH GRANT OPTION이 붙으면 권한 집합에 합성 항목 "GRANT OPTION"을 추가한다.
 *     선언 측 컴파일러(pgddl.ts)는 이 항목을 절대 만들지 않으므로(§10.1), 실제
 *     상태에만 있으면 반드시 mismatch 또는 manual로 드러난다 — 새 DriftKind를
 *     추가하지 않고도 기존 3분류만으로 권한 상승을 표현하는 방식이다.
 * SCHEMA/SEQUENCE 등 테이블이 아닌 대상에 대한 GRANT나 그 밖의 인식 불가 형태는
 * null을 반환한다. 호출자는 그 null을 절대 조용히 버려서는 안 된다(C2) — desired
 * 쪽은 CREATE ROLE·롤 상속 GRANT처럼 원래 이 함수의 대상이 아닌 줄이 섞여 있어
 * null을 건너뛰어도 안전하지만, actual 쪽은 무엇이 됐든 파싱에 실패하면 "해석 불가한
 * 실제 권한 문장"으로 보고해야 한다 — 승인되지 않은 권한이 그 안에 숨어 있을 수
 * 있기 때문이다.
 */
const GRANT_LINE_RE = /^GRANT\s+(.+?)\s+ON\s+(?:TABLE\s+)?(\S+)\s+TO\s+(\S+?)(\s+WITH\s+GRANT\s+OPTION)?;?$/i;

function parseGrantLine(line: string): ParsedGrant | null {
  const m = GRANT_LINE_RE.exec(line.trim());
  if (!m) return null;
  const [, rawPrivileges, rawTable, rawRole, grantOption] = m;
  if (rawPrivileges === undefined || rawTable === undefined || rawRole === undefined) return null;

  const privileges = new Set(
    rawPrivileges
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0),
  );
  if (grantOption) privileges.add("GRANT OPTION");

  return { table: stripQuotes(rawTable), role: stripQuotes(rawRole), privileges };
}

/**
 * GRANT 문장 여러 줄을 (table,role) 키로 묶는다. 같은 키의 줄이 여럿이면 권한
 * 집합을 합집합으로 병합한다(C1) — PostgreSQL의 information_schema.role_table_grants는
 * 권한 하나당 한 행을 돌려주므로 한 (table,role)에 여러 줄이 오는 것이 정상이다.
 * 마지막 줄만 남기면(last-write-wins) 논리적으로 동일한 권한 집합인데도 줄 순서에
 * 따라 다른 결과가 나오는 phantom diff가 생긴다.
 *
 * 파싱에 실패한 줄은 절대 조용히 버리지 않는다 — `onUnparsed` 콜백으로 호출자에게
 * 넘긴다. desired 쪽은 이 콜백을 생략해 조용히 건너뛰고(자기 컴파일러 출력이라 형태를
 * 안다), actual 쪽은 반드시 콜백을 넘겨 드리프트 항목으로 보고한다(C2).
 */
function mergeGrantLines(lines: string[], onUnparsed?: (line: string) => void): Map<string, ParsedGrant> {
  const byKey = new Map<string, ParsedGrant>();
  for (const line of lines) {
    const g = parseGrantLine(line);
    if (!g) {
      onUnparsed?.(line);
      continue;
    }
    const key = `${g.table}/${g.role}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const p of g.privileges) existing.privileges.add(p);
    } else {
      byKey.set(key, g);
    }
  }
  return byKey;
}

function formatPrivileges(privileges: Set<string>): string {
  return [...privileges].sort(cmp).join(", ");
}

function privilegesEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

/**
 * 선언에서 나오는 PG 테이블 권한(GRANT ... ON TABLE ... TO ...) 문장만 추린다.
 * 롤 생성(CREATE ROLE)·상속(GRANT role TO role) 문장은 GRANT_LINE_RE에 애초에
 * 매치되지 않으므로 별도 사전 필터가 필요 없다 — actual 쪽과 동일하게 "파싱
 * 성공 여부" 하나만으로 판단한다(M4). 파싱 실패는 조용히 건너뛴다: 우리 자신의
 * 컴파일러 출력이라 형태를 알고, 위 두 문장 유형이 정상적으로 여기서 걸러진다.
 */
function desiredPgGrants(desired: Artifacts): Map<string, ParsedGrant> {
  return mergeGrantLines(desired.pgddl.split("\n"));
}

function diffPgGrants(desired: Artifacts, actualGrants: string[], items: DriftItem[]): void {
  const desiredByKey = desiredPgGrants(desired);

  const actualByKey = mergeGrantLines(actualGrants, (line) => {
    // 인식하지 못한 실제 GRANT 문장은 절대 조용히 사라지게 두지 않는다(C2) —
    // 승인되지 않은 권한이 여기 숨어 있으면 탐지기가 "깨끗함"을 거짓 보고하게 된다.
    items.push({
      kind: "manual",
      target: "pg.grant/unparsed",
      detail: `해석할 수 없는 실제 GRANT 문장 — 수동 검토 필요: ${line.trim()}`,
    });
  });

  for (const [key, g] of desiredByKey) {
    const a = actualByKey.get(key);
    if (a === undefined) {
      items.push({
        kind: "unapplied",
        target: `pg.grant/${key}`,
        detail: `선언됨, 실제 없음 — ${formatPrivileges(g.privileges)}`,
      });
    } else if (!privilegesEqual(a.privileges, g.privileges)) {
      items.push({
        kind: "mismatch",
        target: `pg.grant/${key}`,
        detail: `권한 집합이 다르다 — 선언: [${formatPrivileges(g.privileges)}], 실제: [${formatPrivileges(a.privileges)}]`,
      });
    }
  }
  for (const [key, a] of actualByKey) {
    if (!desiredByKey.has(key)) {
      items.push({
        kind: "manual",
        target: `pg.grant/${key}`,
        detail: `실제에만 존재 — 수동 변경 의심 (${formatPrivileges(a.privileges)})`,
      });
    }
  }
}
