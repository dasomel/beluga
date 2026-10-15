import { cmp } from "../compare.js";
import type { Declaration } from "../schema.js";

export type KeycloakRole = { name: string; composite: boolean; composites: string[] };
export type KeycloakGroup = { name: string; realmRoles: string[] };
export type KeycloakSpec = { realmRoles: KeycloakRole[]; groups: KeycloakGroup[] };

/**
 * 선언 → Keycloak 롤·그룹 명세.
 * 상속은 컴포지트 롤로 표현한다(D19). 확장은 Keycloak이 토큰 발급 시 수행하므로
 * 여기서는 직접 부모만 넣는다.
 */
export function compileKeycloak(d: Declaration): KeycloakSpec {
  const realmRoles: KeycloakRole[] = d.roles
    .map((r) => ({
      name: r.name,
      composite: (r.includes ?? []).length > 0,
      composites: [...(r.includes ?? [])].sort(),
    }))
    .sort((a, b) => cmp(a.name, b.name));

  const groups: KeycloakGroup[] = d.groups
    .map((g) => ({ name: g.name, realmRoles: [...g.roles].sort() }))
    .sort((a, b) => cmp(a.name, b.name));

  return { realmRoles, groups };
}
