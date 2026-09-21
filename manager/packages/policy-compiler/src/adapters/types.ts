import type { Artifacts } from "../compiler/index.js";

/** 각 시스템의 현재 상태를 정규화한 형태 */
export type ActualState = {
  keycloakRoles: string[];
  keycloakGroups: Record<string, string[]>;
  pgGrants: string[];
};

/**
 * 어댑터는 네트워크만 안다 — 정책 의미를 모른다.
 * 노출하는 것은 두 가지뿐이다.
 */
export interface Adapter {
  readState(): Promise<Partial<ActualState>>;
  apply(artifacts: Artifacts): Promise<void>;
}
