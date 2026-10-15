/**
 * locale-독립 문자열 비교자. localeCompare는 런타임 로케일/ICU 빌드에 의존해
 * 결정론적 정렬을 깬다(§5.3-2). rego/keycloak 두 컴파일러가 공유한다.
 */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
