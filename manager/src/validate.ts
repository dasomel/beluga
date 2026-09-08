import { cmp } from "./compare.js";
import { toPgRole } from "./pgrole.js";
import { DEPLOYED_CATALOG } from "./schema.js";
import type { Declaration, Grant, Group, MaskKind } from "./schema.js";

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

// 수정 라운드 1: resource/sensitiveColumns/columnMask 키는 Rego 컴파일러가 schemaName·
// tableName·columnName 비교식에 그대로 내려보낸다. 컴파일러가 이스케이프하더라도,
// 애초에 식별자가 아닌 값은 여기서 막는다(방어 두 겹).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 수정 라운드 3: 롤/그룹 이름도 같은 이유(Rego 코드에 그대로 내려간다)로 화이트리스트가
// 필요하지만, 컬럼 등 식별자와 달리 하이픈을 legitimate하게 쓴다(data-team) — 별도 패턴.
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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

// 수정 라운드 6: rego.ts에만 있던 holdersOf를 여기로 옮겼다 — CONFLICTING_MASK 검사가
// 컴파일러와 똑같은 "직접 + 상속" 보유자 집합을 계산해야 하는데, rego.ts는 이미 이 파일의
// expandRoles를 가져다 쓰므로 반대 방향으로 옮기면 순환 import가 된다. 중복 대신 이 파일이
// 단일 출처가 되고 rego.ts가 여기서 가져다 쓴다.
/** 이 롤을 실효적으로 갖는 롤들(자신 + 자신을 상속한 상위 롤) */
export function holdersOf(d: Declaration, role: string): string[] {
  return d.roles.filter((r) => expandRoles(d, r.name).includes(role)).map((r) => r.name);
}

/** 그룹 G가 실효적으로 담는 롤 전체 — 선언된 각 롤을 상속까지 확장한 합집합.
 * Keycloak은 그룹에 매핑된 롤도 컴포지트 상속을 똑같이 확장해 멤버 토큰에 담으므로
 * (직접 할당이든 그룹 경유든 차이가 없다), 그룹의 실효 롤 집합은 롤 하나를 직접 가질 때와
 * 같은 방식으로 계산해야 한다. */
function groupEffectiveRoles(d: Declaration, g: Group): Set<string> {
  return new Set(g.roles.flatMap((r) => expandRoles(d, r)));
}

// 수정 라운드 7 — 이슈 1: CONFLICTING_MASK가 지금까지 holdersOf(롤 상속)만 봤는데, 선언된
// 그룹도 "이 롤들을 공동 보유한다"는 명시적 진술이다 — compileKeycloak은 그룹을 그 롤들을
// 담은 Keycloak 그룹으로 내보내므로, 멤버의 토큰에는 그 롤들이 전부 들어간다(실측:
// eval 입력 {"groups": ["g1","g2"]}). 그래서 roleName을 실효적으로 갖게 되는 경로는 "롤
// h가 상속으로 roleName을 포함"뿐 아니라 "그룹 G의 실효 롤 집합이 roleName을 포함"도
// 있다 — 이 함수는 그런 그룹을 roleName의 가상 공동 보유자로 취급해 holdersOf 결과에
// 더한다. 프로젝트 오너의 결정대로 롤이 권한의 축이고 그룹은 롤 묶음일 뿐이라, 그룹 이름은
// 여기서만 쓰이는 내부 표식이다 — Rego에 그룹 이름 자체로 매칭되는 규칙은 없다(그룹 멤버의
// 토큰에 나타나는 건 그룹이 담은 롤 이름들이지 그룹 이름이 아니다). CONFLICTING_MASK의 두
// 계산(겹침 판정과 opted-out 제외 집합) 모두 이 확장판을 써야 대칭이 유지된다.
//
// 재검토 라운드 7 — 이슈 1: Keycloak은 롤과 그룹을 별개 네임스페이스로 관리하므로, 롤
// 'g1'과 이름이 같은 그룹 'g1'이 공존하는 선언은 합법이다(그룹 검증 블록은 ROLE_NAME 형식과
// 롤 존재만 확인하고 이름 충돌은 막지 않는다). holdersOf가 반환하는 롤 이름과 그룹 이름을
// 태그 없이 같은 문자열 집합에 섞으면 이 경우 우연한 문자열 일치가 진짜 공동 보유로
// 오인된다(실측: opa eval로 확인한 결과 이런 선언은 서로소 집합에 가드가 걸려 절대
// 충돌하지 않는데도 CONFLICTING_MASK가 거짓 발생했다). 그룹 보유자를 `group:` 접두사로
// 태그해 롤 이름 네임스페이스와 분리한다 — 이러면 문자열이 우연히 같아도 겹치지 않는다.
function taggedGroupHolders(d: Declaration, role: string): string[] {
  return d.groups.filter((g) => groupEffectiveRoles(d, g).has(role)).map((g) => `group:${g.name}`);
}

function holdersOfIncludingGroups(d: Declaration, role: string): string[] {
  const roleHolders = holdersOf(d, role);
  const groupHolders = taggedGroupHolders(d, role);
  return [...new Set([...roleHolders, ...groupHolders])];
}

/** overlap 항목(롤 이름 또는 `group:`로 태그된 그룹 이름)을 에러 메시지용으로 사람이 읽을 수
 * 있게 바꾼다 — 태그를 벗기고 그룹임을 명시해, 그룹을 롤 이름으로 오인하지 않게 한다. */
function describeHolder(h: string): string {
  return h.startsWith("group:") ? `그룹 ${h.slice("group:".length)}` : `롤 ${h}`;
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
    if (!ROLE_NAME.test(r.name)) {
      errors.push({
        code: "INVALID_IDENTIFIER",
        message: `롤 이름 '${r.name}'이 올바른 형식이 아니다([A-Za-z_][A-Za-z0-9_-]*)`,
      });
    }
    for (const parent of r.includes ?? []) {
      if (!known.has(parent)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `롤 '${r.name}'이 없는 롤 '${parent}'을 상속한다` });
      }
      if (!ROLE_NAME.test(parent)) {
        errors.push({
          code: "INVALID_IDENTIFIER",
          message: `롤 '${r.name}'의 includes 항목 '${parent}'이 올바른 형식이 아니다`,
        });
      }
    }
  }

  // 수정 라운드 1: data-team과 data_team은 둘 다 ROLE_NAME 화이트리스트를 통과하지만
  // pgddl.ts의 toPgRole()이 하이픈을 언더스코어로 바꾸므로 같은 물리 PG 롤로 조용히 합쳐진다 —
  // 선언이 표현하지 않은 권한 유니온이 발생한다. 알파벳을 제한하는 대신(data_team처럼 정당한
  // 이름까지 막힌다) 정규화 후 충돌하는 조합만 잡는다. 그룹은 Keycloak 그룹으로만 컴파일되고
  // toPgRole을 거치지 않으므로 이 검사 대상이 아니다.
  const byPgRole = new Map<string, string[]>();
  for (const r of d.roles) {
    const pg = toPgRole(r.name);
    byPgRole.set(pg, [...(byPgRole.get(pg) ?? []), r.name]);
  }
  for (const [pg, names] of [...byPgRole].sort((a, b) => cmp(a[0], b[0]))) {
    if (names.length > 1) {
      const offenders = [...names].sort(cmp);
      errors.push({
        code: "ROLE_NAME_COLLISION",
        message: `롤 이름 ${offenders.map((n) => `'${n}'`).join(", ")}이(가) 모두 PG 롤 '${pg}'로 정규화된다 — 하나를 다른 이름으로 바꿔야 한다`,
      });
    }
  }

  for (const g of d.groups) {
    if (!ROLE_NAME.test(g.name)) {
      errors.push({
        code: "INVALID_IDENTIFIER",
        message: `그룹 이름 '${g.name}'이 올바른 형식이 아니다([A-Za-z_][A-Za-z0-9_-]*)`,
      });
    }
    for (const role of g.roles) {
      if (!known.has(role)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `그룹 '${g.name}'이 없는 롤 '${role}'을 참조한다` });
      }
      if (!ROLE_NAME.test(role)) {
        errors.push({
          code: "INVALID_IDENTIFIER",
          message: `그룹 '${g.name}'의 롤 항목 '${role}'이 올바른 형식이 아니다`,
        });
      }
    }
  }

  // 수정 라운드 7 — 이슈 2: CONFLICTING_MASK는 이 아래 리소스 루프 안에서, 한 엔트리의
  // res.grants끼리만 짝지어 비교한다. 같은 'schema.table'을 두 리소스 엔트리로 나눠 선언하면
  // 그랜트가 서로 다른 엔트리에 흩어져 절대 비교되지 않는다 — 실측: 마스킹이 겹치는 두
  // 그랜트를 엔트리 둘로 쪼개면 검증은 통과하고 컴파일된 Rego는 그대로 eval_conflict_error를
  // 낸다. 테이블을 두 번 선언하는 것은 마스킹 충돌 여부와 무관하게 거의 항상 작성 실수이므로
  // 여기서 별도로 거부한다 — 이렇게 하면 아래 CONFLICTING_MASK의 "리소스 엔트리당 한 번"
  // 스코프가 그 자체로 안전해진다(엔트리를 합치라고 강제하므로).
  const resourceOccurrences = new Map<string, number>();
  for (const res of d.resources) {
    const key = `${res.engine ?? "trino"}:${res.resource}`;
    resourceOccurrences.set(key, (resourceOccurrences.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...resourceOccurrences].sort((a, b) => cmp(a[0], b[0]))) {
    if (count > 1) {
      const [, name] = key.split(":", 2);
      errors.push({
        code: "DUPLICATE_RESOURCE",
        message: `리소스 '${name}'이 선언에서 ${count}번 나온다 — 그랜트를 한 엔트리로 합쳐야 한다(엔트리를 나누면 서로의 그랜트가 비교되지 않아 마스킹 충돌 검사를 우회한다)`,
      });
    }
  }

  for (const res of d.resources) {
    const sensitive = res.sensitiveColumns ?? [];

    const resourceParts = res.resource.split(".");
    if (resourceParts.length !== 2 || !resourceParts.every((p) => IDENTIFIER.test(p))) {
      errors.push({
        code: "INVALID_IDENTIFIER",
        message: `리소스 '${res.resource}'는 'schema.table' 형식이어야 하며 두 부분 모두 식별자([A-Za-z_][A-Za-z0-9_]*)여야 한다`,
      });
    }

    for (const col of sensitive) {
      if (!IDENTIFIER.test(col)) {
        errors.push({
          code: "INVALID_IDENTIFIER",
          message: `리소스 '${res.resource}'의 sensitiveColumns 항목 '${col}'이 식별자가 아니다`,
        });
      }
    }

    if (res.classification === "pii" && sensitive.length === 0) {
      errors.push({
        code: "PII_NO_SENSITIVE_COLUMNS",
        message: `PII 리소스 '${res.resource}'에 sensitiveColumns가 없다 — 무엇을 가려야 하는지 선언하지 않으면 마스킹을 강제할 수 없다`,
      });
    }

    for (const grant of res.grants) {
      if (res.engine === "postgres" && grant.columnMask !== undefined) {
        errors.push({
          code: "POSTGRES_UNSUPPORTED_MASK",
          message: `PostgreSQL 리소스 '${res.resource}'는 columnMask를 지원하지 않는다 — 표준 테이블 GRANT만 컴파일한다`,
        });
      }
      if (res.engine === "postgres" && grant.rowFilter !== undefined) {
        errors.push({
          code: "POSTGRES_UNSUPPORTED_ROW_FILTER",
          message: `PostgreSQL 리소스 '${res.resource}'는 rowFilter를 지원하지 않는다 — 표준 테이블 GRANT만 컴파일한다`,
        });
      }
      for (const role of grant.roles) {
        if (!known.has(role)) {
          errors.push({ code: "UNKNOWN_ROLE", message: `리소스 '${res.resource}'가 없는 롤 '${role}'을 참조한다` });
        }
        if (!ROLE_NAME.test(role)) {
          errors.push({
            code: "INVALID_IDENTIFIER",
            message: `리소스 '${res.resource}'의 그랜트 롤 '${role}'이 올바른 형식이 아니다`,
          });
        }
      }

      for (const col of Object.keys(grant.columnMask ?? {})) {
        if (!IDENTIFIER.test(col)) {
          errors.push({
            code: "INVALID_IDENTIFIER",
            message: `리소스 '${res.resource}'의 columnMask 키 '${col}'이 식별자가 아니다`,
          });
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

    // 수정 라운드 6: rego.ts 라운드 5부터 allowUnmasked 그랜트는 자신의 columnMask에 가드가
    // 없다. 서로 다른 두 그랜트가 같은 컬럼을 마스킹하고 보유자가 겹치면, 두 규칙이 동시에
    // 평가돼 OPA가 eval_conflict_error를 낸다(재검토 candidate L, 실측: HTTP 500) — 컴파일
    // 타임이 아니라 여기서 막는다.
    //
    // 어떤 쌍이 실제로 충돌하는지(실측으로 검증):
    //   - opted-out 하나 + 일반 하나: 일반 쪽 가드는 이 리소스의 opted-out 보유자 전체를
    //     걸러내고, opted-out 쪽 보유자는 반드시 그 전체 집합에 포함되므로 겹치는 보유자는
    //     항상 가드에 걸려 제외된다 — 수학적으로 절대 충돌하지 않는다. opa eval로 확인:
    //     단일 값만 나오고 에러가 없었다. 그래서 이 조합은 검사하지 않는다(하나만
    //     allowUnmasked면 건너뛴다) — "컴파일되는 정책을 거부하지 않는다"는 원칙을 지킨다.
    //   - opted-out 둘 다: 둘 다 가드가 없으므로 보유자 교집합이 있으면 그대로 충돌한다.
    //   - 일반 둘 다: 이 리소스에 다른 opted-out 그랜트가 있으면 그 보유자 전체(U)만큼은
    //     둘 다에게 같은 가드가 걸리므로, 교집합에서 U를 뺀 나머지가 남아야 실제로 충돌한다.
    //     opted-out 그랜트가 이 리소스에 아예 없으면 U가 비어 있어 가드가 전혀 없다 — 이
    //     경우도 opa eval로 같은 eval_conflict_error를 재현했다. allowUnmasked와 무관하게
    //     이미 존재하던, 더 넓은 범위의 같은 실패 모양이라 여기도 포함한다.
    // 마스킹 종류(kind)가 같으면 두 규칙 바디가 같은 값을 내므로 OPA는 충돌로 보지 않는다
    // (opa eval로 실측: 값이 같은 두 complete rule은 에러 없이 단일 값을 낸다) — kind가
    // 다를 때만 진짜 충돌이다.
    //
    // rowFilter는 대상이 아니다: rowFilters는 partial-set(contains) 규칙이라 여러 개가
    // 동시에 참이어도 집합으로 합쳐질 뿐이다(opa eval로 실측: 에러 없음, 두 필터가 함께
    // 적용됨) — complete rule인 columnMask와 다른 규칙 종류라 애초에 충돌이 불가능하다.
    //
    // 이 검사의 한계: 선언 자체가 만드는 공동 보유(롤 상속, 하나의 그룹)만 본다. 한 사용자가
    // 서로 다른 두 그룹의 멤버가 되어(예: analytics=[g1,g2], reporting=[g2,g3]) 그 두 그룹이
    // 각자 담은 롤을 합쳐 가지는 경우는 선언이 "공동 보유"라고 명시한 적이 없으므로 이 검사
    // 대상이 아니다(실측: opa eval로 재현하면 eval_conflict_error가 나지만, 위 예의 g1과
    // g3는 어느 한 그룹에도 함께 담기지 않았으니 이 규칙 하에서는 정상적으로 통과한다) —
    // 오너의 결정대로 그룹은 "이 롤들이 함께 쓰인다"는 선언자의 명시적 진술을 나타낼 때만
    // 근거가 된다. 운영자가 Keycloak 콘솔에서 서로 무관한 두 롤(또는 두 그룹)을 한 사용자에게
    // 직접 부여하는 경우도 마찬가지로 선언 밖의 일이라 어떤 선언 단계 검사로도 볼 수 없다 —
    // 이 검사를 완전한 보증으로 착각하면 안 된다.
    const resourceUnmasked = new Set(
      res.grants
        .filter((g) => g.allowUnmasked === true)
        .flatMap((g) => g.roles.flatMap((r) => holdersOfIncludingGroups(d, r))),
    );
    const maskedBy = new Map<string, { grant: Grant; holders: Set<string>; kind: MaskKind }[]>();
    for (const grant of res.grants) {
      for (const [col, kind] of Object.entries(grant.columnMask ?? {})) {
        const holders = new Set(grant.roles.flatMap((r) => holdersOfIncludingGroups(d, r)));
        const list = maskedBy.get(col) ?? [];
        list.push({ grant, holders, kind });
        maskedBy.set(col, list);
      }
    }
    for (const [col, entries] of [...maskedBy].sort((a, b) => cmp(a[0], b[0]))) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i];
          const b = entries[j];
          if (!a || !b || a.kind === b.kind) continue;
          const aOpt = a.grant.allowUnmasked === true;
          const bOpt = b.grant.allowUnmasked === true;
          if (aOpt !== bOpt) continue; // 하나만 opted-out — 절대 충돌하지 않는다(위 설명 참고)
          let overlap = [...a.holders].filter((h) => b.holders.has(h));
          if (!aOpt) {
            // 둘 다 일반 그랜트 — 이 리소스의 다른 opted-out 그랜트가 걸어주는 가드로
            // 이미 제외되는 보유자는 실제로 충돌하지 않는다.
            overlap = overlap.filter((h) => !resourceUnmasked.has(h));
          }
          if (overlap.length > 0) {
            errors.push({
              code: "CONFLICTING_MASK",
              message: `리소스 '${res.resource}'의 컬럼 '${col}'을 롤 [${a.grant.roles.join(", ")}] 그랜트와 롤 [${b.grant.roles.join(", ")}] 그랜트가 서로 다른 방식(${a.kind}/${b.kind})으로 마스킹하며, 그 보유자가 겹친다(${[...new Set(overlap)].sort(cmp).map(describeHolder).join(", ")}) — OPA가 평가 시 eval_conflict_error를 낸다`,
            });
          }
        }
      }
    }
  }

  // 수정 라운드 1(Task 12 리뷰 I-1): roles[].includes/groups[].roles/resources[].grants[].roles
  // 세 곳에 있던 롤 참조 검증이 네 번째 지점인 catalogGrants[].roles에는 없었다. default
  // allow := false라 권한 상승은 아니지만, roles: [analyst](단수 오타) 하나로 카탈로그 전체가
  // 조용히 막히고 opa check는 rc=0으로 통과한다 — 이 플랜이 반복해서 당해온 실패 유형이라
  // 다른 세 지점과 동일한 검사를 적용한다.
  for (const cg of d.catalogGrants ?? []) {
    // 최종 리뷰 M-2: catalog 필드는 스키마상 임의 문자열을 받지만, rego.ts의 테이블 레벨
    // 규칙은 선언자가 쓴 문자열이 아니라 DEPLOYED_CATALOG 상수로 가드된다. 여기서 걸러주지
    // 않으면 catalogGrants: [{catalog: "postgres", ...}]가 조용히 컴파일을 통과하면서도,
    // 짝을 이루도록 의도된 테이블 규칙은 계속 "iceberg"로만 열려 있는 상태가 된다 —
    // 배포 카탈로그가 정말 하나뿐인 동안은 이 불일치를 여기서 막아야 한다. 두 번째 카탈로그가
    // 실제로 배포되면 schema.ts의 DEPLOYED_CATALOG 결정 주석(D-H)이 가리키는 대로 고칠 것.
    if (cg.catalog !== DEPLOYED_CATALOG) {
      errors.push({
        code: "UNSUPPORTED_CATALOG",
        message: `카탈로그 그랜트가 '${cg.catalog}'를 참조하지만 이 프로젝트는 '${DEPLOYED_CATALOG}' 카탈로그 하나만 배포한다(src/schema.ts의 DEPLOYED_CATALOG). 두 번째 카탈로그가 실제로 배포되면 그 상수를 먼저 바꿀 것`,
      });
    }
    for (const role of cg.roles) {
      if (!known.has(role)) {
        errors.push({
          code: "UNKNOWN_ROLE",
          message: `카탈로그 그랜트 '${cg.catalog}'가 없는 롤 '${role}'을 참조한다`,
        });
      }
      if (!ROLE_NAME.test(role)) {
        errors.push({
          code: "INVALID_IDENTIFIER",
          message: `카탈로그 그랜트 '${cg.catalog}'의 롤 '${role}'이 올바른 형식이 아니다`,
        });
      }
    }
  }

  // M-2: resources의 DUPLICATE_RESOURCE와 동일한 취지 — 같은 (catalog, operation) 조합을
  // 서로 다른 catalogGrants 엔트리에 나눠 쓰면 rego.ts가 동일하거나 겹치는 allow 블록을
  // 중복 방출한다(opa check는 통과하지만 낭비고, 롤 집합이 엔트리마다 다르면 의도 파악도
  // 어려워진다). 카탈로그·오퍼레이션 쌍 단위로 세어 잡는다.
  // 카탈로그 이름은 resource(schema.table)와 달리 식별자 형식 검증이 없어 구분자로 쓸 문자를
  // 통제할 수 없다 — JSON.stringify([catalog, op])는 배열 요소 각각을 이스케이프해 인코딩하므로
  // 서로 다른 (catalog, op) 쌍이 우연히 같은 키로 충돌하지 않는다.
  const catalogGrantOpOccurrences = new Map<string, number>();
  for (const cg of d.catalogGrants ?? []) {
    for (const op of cg.operations) {
      const key = JSON.stringify([cg.catalog, op]);
      catalogGrantOpOccurrences.set(key, (catalogGrantOpOccurrences.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of [...catalogGrantOpOccurrences].sort((a, b) => cmp(a[0], b[0]))) {
    if (count > 1) {
      const [catalog, op] = JSON.parse(key) as [string, string];
      errors.push({
        code: "DUPLICATE_CATALOG_GRANT",
        message: `카탈로그 '${catalog}'의 오퍼레이션 '${op}'이 catalogGrants에서 ${count}번 선언된다 — 같은 (카탈로그, 오퍼레이션) 조합을 여러 엔트리로 나누면 동일하거나 겹치는 allow 규칙이 중복 방출된다. 한 엔트리로 합칠 것`,
      });
    }
  }

  return errors;
}
