/**
 * 선언의 롤 이름을 PG 롤 이름으로 바꾼다: 하이픈 → 언더스코어, 그리고 소문자로 접는다.
 * 기본 롤(analysts/engineers/admins)은 하이픈이 없어 이 변환이 항등에 가깝지만, data-team처럼
 * 하이픈을 쓰는 사용자 정의 롤은 PG 롤로 바뀔 때 언더스코어(data_team)가 필요하다 —
 * 하이픈을 그대로 쓰면 CREATE ROLE이 문법 오류가 난다(따옴표 필요).
 *
 * 소문자 변환은 부수적인 정리가 아니라 정규화의 필수 부분이다 — PostgreSQL 자체가 따옴표
 * 없는 식별자를 소문자로 접기 때문이다(CREATE ROLE Team_A는 실제로 team_a를 만든다). 여기서
 * 미리 접지 않으면 (a) Team-A와 team_a처럼 대소문자만 다른 두 선언이 같은 물리 롤로 조용히
 * 합쳐지는데도 충돌 탐지를 통과하고, (b) 컴파일러가 서버에 존재하지 않을 이름(Team_A)을
 * 출력해 나중 태스크의 드리프트 비교가 실체 없는 차이를 드리프트로 보고하게 된다(수정 라운드 2).
 *
 * validate.ts(충돌 탐지)와 pgddl.ts(실제 변환)가 이 함수 하나를 공유한다 — 정규화 규칙이
 * 두 곳에 따로 있으면 한쪽만 고쳤을 때 다른 쪽이 조용히 어긋난다(수정 라운드 1: 서로 다른
 * 두 롤 이름이 정규화 후 같은 PG 롤로 충돌하는 결함을 여기서 막는다).
 */
export function toPgRole(name: string): string {
  return name.replace(/-/g, "_").toLowerCase();
}

/**
 * LOGIN 계정 이름을 큰따옴표로 감싼 PG 식별자로 바꾼다. toPgRole()과 달리 하이픈을
 * 언더스코어로 바꾸지 않는다 — LOGIN 계정 이름은 pg_hba ldap search 모드가 매칭하는
 * LDAP uid 그대로 유지되어야 한다(예: beluga-analyst). 정책 롤(NOLOGIN)에만 쓰는
 * toPgRole()과 섞어 쓰면 안 된다. 호출부는 validate.ts의 LOGIN_NAME 화이트리스트로
 * 먼저 걸러진 이름만 넘겨야 한다 — 여기서는 이스케이프를 하지 않는다.
 */
export function toPgLoginIdentifier(name: string): string {
  return `"${name}"`;
}
