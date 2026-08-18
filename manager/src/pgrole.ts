/**
 * 선언의 롤 이름(하이픈)을 PG 롤 이름(언더스코어)으로 바꾼다.
 * 선언·Keycloak·Rego는 beluga-analyst, PG는 beluga_analyst — 기존 PG 롤과 맞추기 위함이며
 * 하이픈을 그대로 쓰면 CREATE ROLE이 문법 오류가 난다(따옴표 필요).
 *
 * validate.ts(충돌 탐지)와 pgddl.ts(실제 변환)가 이 함수 하나를 공유한다 — 정규화 규칙이
 * 두 곳에 따로 있으면 한쪽만 고쳤을 때 다른 쪽이 조용히 어긋난다(수정 라운드 1: 서로 다른
 * 두 롤 이름이 정규화 후 같은 PG 롤로 충돌하는 결함을 여기서 막는다).
 */
export function toPgRole(name: string): string {
  return name.replace(/-/g, "_");
}
