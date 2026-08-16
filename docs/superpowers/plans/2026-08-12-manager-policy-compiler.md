# beluga manager — 정책 컴파일러 · 권한 사슬 복구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정책 선언 YAML 한 벌을 Keycloak·Rego·PostgreSQL DDL 세 갈래 산출물로 컴파일하는 순수 함수 라이브러리와, 그것을 적용·대조하는 CLI를 만든다. UI 없이도 동작하고 검증 가능한 manager의 두뇌다.

**Architecture:** `beluga-manager` 리포를 새로 만들고 그 안에 `src/compiler`(순수 함수, 네트워크 모름)와 `src/adapters`(네트워크만 알고 정책 의미 모름)를 분리한다. 컴파일러는 골든 테스트로 "이 선언은 이 산출물이 된다"를 고정한다. CLI(`bin/policyctl`)가 compile/apply/diff 세 명령을 제공한다.

**Tech Stack:** TypeScript 6.0.3, Node 22, vitest 4.1.10, zod 4.4.3(스키마 검증), yaml 2.9.0. Next.js UI는 이 계획의 범위가 아니다(계획 2).

## Global Constraints

설계서 `docs/superpowers/specs/2026-08-12-beluga-manager-design.md`에서 그대로 가져온 제약이며, 모든 태스크에 적용된다.

- **컴파일러는 순수 함수다.** 네트워크·시계·난수를 쓰지 않는다. (§5.3-1)
- **컴파일러는 결정론적이다.** 같은 입력에 항상 같은 출력. 드리프트 비교가 이것에 의존한다. (§5.3-2)
- **allow-by-role만 허용한다.** deny 규칙 금지 — deny를 롤에 걸면 상속받은 상위 롤까지 막혀 D19 상속 모델이 깨진다. (§5.3-3)
- **어댑터는 `readState()`와 `apply(artifact)` 두 가지만 노출한다.** (§4.1)
- 버전 핀(D17): `typescript@6.0.3`, `vitest@4.1.10`, `zod@4.4.3`, `yaml@2.9.0`. TypeScript 7.0.2가 `latest`이나 네이티브 포트 신규 버전이라 자매 프로젝트(narwhal-portal)가 검증한 6.x를 유지한다.
- 커밋은 Conventional Commits + 모듈 스코프, **LOCAL only**(push는 명시 요청 시에만).
- 정책 원천 파일은 **beluga 리포**의 `policies/`에 두고, manager 리포는 그것을 읽는다. (M4)
- **Rego는 `input.context.identity.groups`를 읽는다.** 라이브 실측 결과 Trino OPA 입력의
  `identity` 키는 `groups`/`user` 뿐이다 — `extraCredentials.roles`는 항상 비어 모든 요청이 거부된다.
- **롤 이름: 선언·Keycloak·Rego는 하이픈(`beluga-analyst`), PG DDL만 언더스코어로 변환**한다
  (`toPgRole()`). 기존 PG 롤과 맞추기 위함이며, 하이픈은 `CREATE ROLE` 문법 오류를 낸다.

---

## 계획 분할

이 계획은 네 계획 중 첫 번째다. 나머지는 이 계획 완료 후 각각 작성한다.

| 계획 | 내용 | 상태 |
|---|---|---|
| **1. 정책 컴파일러 · 권한 사슬 복구** (이 문서) | 선행 결함 수정, 선언 스키마, 3갈래 컴파일러, CLI, group-ldap-mapper | 지금 |
| 2. manager 앱 (BFF + UI 5화면) | Next.js 16.3, 5개 화면, diff 게이트, sync worker | 이후 |
| 3. PostgreSQL 18 승급 + anon 마스킹 | CNPG 메이저 업그레이드, 소비자 6종 호환 검증, 확장 도입 | 이후 |
| 4. 개인별 PG 롤 전환 | 공유 계정 3개 폐기, RLS·개인 감사 성립 | 이후 |

---

## File Structure

### beluga 리포 (기존)

| 파일 | 책임 |
|---|---|
| `gitops/charts/beluga-data/files/db-roles.sql` | **수정** — analyst 기본 권한 결함 제거 (Task 1) |
| `policies/roles.yaml` | **신규** — 롤 계층 선언 (D19) |
| `policies/groups.yaml` | **신규** — 그룹→롤 매핑 |
| `policies/resources.yaml` | **신규** — 리소스별 권한 매트릭스 (D18) |
| `gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml` | **신규** — group-ldap-mapper 등록 Job (Task 8) |

### beluga-manager 리포 (신규)

| 파일 | 책임 |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | 프로젝트 설정 |
| `src/schema.ts` | 선언 스키마 정의(zod) + 파싱 |
| `src/validate.ts` | 선언 의미 검증 (순환 상속, PII 규칙 등) |
| `src/compiler/keycloak.ts` | 선언 → Keycloak 롤·그룹 명세 |
| `src/compiler/rego.ts` | 선언 → Trino용 Rego |
| `src/compiler/pgddl.ts` | 선언 → PostgreSQL DDL |
| `src/compiler/index.ts` | 세 컴파일러를 묶는 진입점 |
| `src/adapters/types.ts` | 어댑터 인터페이스 정의 |
| `src/adapters/keycloak.ts` | Keycloak Admin API 어댑터 |
| `src/adapters/postgres.ts` | PostgreSQL 어댑터 |
| `src/adapters/opa.ts` | OPA 정책 번들 어댑터 |
| `src/drift.ts` | 선언 상태 vs 실제 상태 비교 |
| `bin/policyctl.ts` | CLI (compile / apply / diff) |
| `tests/fixtures/*.yaml` | 골든 테스트 입력 |
| `tests/golden/*.{rego,sql,json}` | 골든 테스트 기대 출력 |

---

## Task 1: 기본 권한 결함 수정 (선행, manager와 독립)

설계서 §9-1. 신규 테이블에 analyst SELECT가 자동 부여되어 §10.1 "기본은 거부"를 정면 위반한다.
**이 태스크만 beluga 리포에서 작업한다.**

**Files:**
- Modify: `gitops/charts/beluga-data/files/db-roles.sql:40`
- Create: `tests/06-authz-defaults.sh`

**Interfaces:**
- Produces: `beluga_analyst`는 앞으로 생성되는 테이블에 자동 SELECT를 받지 않는다. 이후 계획 4(개인 롤)와 Task 6(PG DDL 적용)이 이 전제를 사용한다.

- [ ] **Step 1: 결함을 재현하는 검증 스크립트 작성**

`tests/06-authz-defaults.sh`:

```bash
#!/usr/bin/env bash
# §10.1 "기본은 거부" 회귀 검증 — 신규 테이블에 analyst가 자동 SELECT를 받으면 실패
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

PSQL=(kubectl -n beluga-data exec postgres-main-1 -c postgres -- psql -U postgres -d shop -tAc)

log_info "[TEST 06] 기본 권한(ALTER DEFAULT PRIVILEGES) 회귀 검증..."

"${PSQL[@]}" "CREATE TABLE IF NOT EXISTS authz_probe (id int);" >/dev/null
GRANTED=$("${PSQL[@]}" "SELECT has_table_privilege('beluga_analyst','authz_probe','SELECT');")
"${PSQL[@]}" "DROP TABLE authz_probe;" >/dev/null

if [[ "${GRANTED}" == "t" ]]; then
  log_error "신규 테이블에 analyst SELECT가 자동 부여됨 — §10.1 위반"
  exit 1
fi
log_success "[TEST 06] 신규 테이블은 기본 거부 상태."
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `chmod +x tests/06-authz-defaults.sh && bash tests/06-authz-defaults.sh`
Expected: FAIL — `신규 테이블에 analyst SELECT가 자동 부여됨`

- [ ] **Step 3: 결함 수정**

`gitops/charts/beluga-data/files/db-roles.sql` 40행을 삭제하고 그 자리에 주석을 남긴다:

```sql
-- analyst에 대한 ALTER DEFAULT PRIVILEGES는 두지 않는다.
-- 신규 테이블에 SELECT를 자동 부여하면 §10.1 "기본은 거부, 허용만 롤로 부여"를 위반한다
-- (신규 CDC 미러·customers_v2가 생기는 즉시 analyst가 읽게 됨). 테이블 허용은 명시적 GRANT로만.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO beluga_engineer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO beluga_admin;
```

- [ ] **Step 4: 기존에 부여된 기본 권한을 실제로 회수**

```bash
export KUBECONFIG=$PWD/.kube/config
kubectl -n beluga-data exec postgres-main-1 -c postgres -- psql -U beluga_admin -d shop -c \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM beluga_analyst;"
```

- [ ] **Step 5: 검증 통과 확인**

Run: `bash tests/06-authz-defaults.sh`
Expected: PASS — `신규 테이블은 기본 거부 상태.`

- [ ] **Step 6: 커밋**

```bash
git add gitops/charts/beluga-data/files/db-roles.sql tests/06-authz-defaults.sh
git commit -m "fix(gitops): analyst 기본 권한 자동 부여 제거 — §10.1 기본 거부 원칙 복구"
```

---

## Task 2: beluga-manager 리포 스캐폴딩

**Files:**
- Create: `../beluga-manager/package.json`
- Create: `../beluga-manager/tsconfig.json`
- Create: `../beluga-manager/vitest.config.ts`
- Create: `../beluga-manager/.gitignore`
- Create: `../beluga-manager/README.md`

**Interfaces:**
- Produces: `npm test`가 동작하는 TypeScript 프로젝트. 이후 모든 태스크가 이 위에서 작업한다.

- [ ] **Step 1: 리포 생성 및 초기화**

```bash
cd ~/Documents/IdeaProjects/20.dasomel
mkdir -p beluga-manager && cd beluga-manager
git init
```

- [ ] **Step 2: package.json 작성**

```json
{
  "name": "beluga-manager",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "policyctl": "tsx bin/policyctl.ts"
  },
  "dependencies": {
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "22.15.3",
    "tsx": "4.20.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 3: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: vitest.config.ts와 .gitignore 작성**

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 5: 설치하고 빈 테스트가 도는지 확인**

```bash
npm install
mkdir -p tests
cat > tests/smoke.test.ts <<'EOF'
import { expect, test } from "vitest";

test("test runner works", () => {
  expect(1 + 1).toBe(2);
});
EOF
npm test
```

Expected: PASS — 1 test passed

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore: beluga-manager 프로젝트 스캐폴딩 (TypeScript 6 + vitest 4)"
```

---

## Task 3: 선언 스키마와 파서

**Files:**
- Create: `src/schema.ts`
- Create: `tests/schema.test.ts`
- Create: `tests/fixtures/minimal.yaml`

**Interfaces:**
- Produces:
  - `type Declaration = { roles: Role[]; groups: Group[]; resources: Resource[] }`
  - `type Role = { name: string; includes?: string[] }`
  - `type Group = { name: string; roles: string[] }`
  - `type Resource = { resource: string; classification: "public" | "internal" | "pii"; grants: Grant[] }`
  - `type Grant = { roles: string[]; privileges: Privilege[]; columnMask?: Record<string, MaskKind>; rowFilter?: string }`
  - `type Privilege = "select" | "insert" | "update" | "delete"`
  - `type MaskKind = "hash" | "partial" | "null"`
  - `parseDeclaration(yamlText: string): Declaration` — 스키마 위반 시 `throw ZodError`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/schema.test.ts`:

```typescript
import { expect, test } from "vitest";
import { parseDeclaration } from "../src/schema.js";

test("유효한 선언을 파싱한다", () => {
  const yaml = `
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups:
  - name: analysts
    roles: [beluga-analyst]
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
        columnMask:
          email: hash
`;
  const d = parseDeclaration(yaml);
  expect(d.roles).toHaveLength(2);
  expect(d.roles[1]?.includes).toEqual(["beluga-analyst"]);
  expect(d.resources[0]?.classification).toBe("pii");
  expect(d.resources[0]?.grants[0]?.columnMask?.email).toBe("hash");
});

test("알 수 없는 privilege는 거부한다", () => {
  const yaml = `
roles: []
groups: []
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [r]
        privileges: [drop]
`;
  expect(() => parseDeclaration(yaml)).toThrow();
});

test("모르는 키는 거부한다", () => {
  const yaml = `
roles: []
groups: []
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
        columMask: { email: hash }
`;
  expect(() => parseDeclaration(yaml)).toThrow();
});
```

`columMask`는 `columnMask`의 오타다. 스키마가 모르는 키를 버리면 이 선언은 오류 없이
**마스킹 없는 select 권한**이 된다 — 오타 하나로 PII 마스킹이 사라진다. 그래서 아래
Step 3의 모든 오브젝트 스키마는 `z.object()`가 아니라 `z.strictObject()`를 쓴다.

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/schema.test.ts`
Expected: FAIL — `Cannot find module '../src/schema.js'`

- [ ] **Step 3: 스키마 구현**

`src/schema.ts`:

```typescript
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const privilegeSchema = z.enum(["select", "insert", "update", "delete"]);
export const maskKindSchema = z.enum(["hash", "partial", "null"]);

export const grantSchema = z.strictObject({
  roles: z.array(z.string()).min(1),
  privileges: z.array(privilegeSchema).min(1),
  columnMask: z.record(z.string(), maskKindSchema).optional(),
  rowFilter: z.string().optional(),
});

export const resourceSchema = z.strictObject({
  resource: z.string().min(1),
  classification: z.enum(["public", "internal", "pii"]),
  grants: z.array(grantSchema),
});

export const roleSchema = z.strictObject({
  name: z.string().min(1),
  includes: z.array(z.string()).optional(),
});

export const groupSchema = z.strictObject({
  name: z.string().min(1),
  roles: z.array(z.string()).min(1),
});

export const declarationSchema = z.strictObject({
  roles: z.array(roleSchema),
  groups: z.array(groupSchema),
  resources: z.array(resourceSchema),
});

export type Privilege = z.infer<typeof privilegeSchema>;
export type MaskKind = z.infer<typeof maskKindSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Group = z.infer<typeof groupSchema>;
export type Declaration = z.infer<typeof declarationSchema>;

export function parseDeclaration(yamlText: string): Declaration {
  return declarationSchema.parse(parseYaml(yamlText));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/schema.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 5: 커밋**

```bash
git add src/schema.ts tests/schema.test.ts
git commit -m "feat(schema): 정책 선언 스키마와 파서 (zod)"
```

---

## Task 4: 선언 의미 검증

설계서 §5.4. 스키마는 통과하지만 의미가 틀린 선언을 거부한다.

**Files:**
- Create: `src/validate.ts`
- Create: `tests/validate.test.ts`

**Interfaces:**
- Consumes: `Declaration`, `Role`, `Resource` (Task 3)
- Produces:
  - `type ValidationError = { code: string; message: string }`
  - `validateDeclaration(d: Declaration): ValidationError[]` — 빈 배열이면 유효
  - `expandRoles(d: Declaration, roleName: string): string[]` — 상속 확장(자신 포함, 결정론적 정렬)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/validate.test.ts`:

```typescript
import { expect, test } from "vitest";
import { parseDeclaration } from "../src/schema.js";
import { expandRoles, validateDeclaration } from "../src/validate.js";

const base = (extra: string) => parseDeclaration(`
roles:
  - name: analyst
  - name: engineer
    includes: [analyst]
groups: []
${extra}
`);

test("정의되지 않은 롤 참조를 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [ghost]
        privileges: [select]
`);
  const errs = validateDeclaration(d);
  expect(errs.map((e) => e.code)).toContain("UNKNOWN_ROLE");
});

test("순환 상속을 거부한다", () => {
  const d = parseDeclaration(`
roles:
  - name: a
    includes: [b]
  - name: b
    includes: [a]
groups: []
resources: []
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("CYCLIC_INHERITANCE");
});

test("PII 리소스에 마스킹 없는 select를 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("PII 리소스라도 마스킹이 있으면 허용한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("상속을 확장한다 (결정론적 정렬)", () => {
  const d = base(`resources: []`);
  expect(expandRoles(d, "engineer")).toEqual(["analyst", "engineer"]);
  expect(expandRoles(d, "analyst")).toEqual(["analyst"]);
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/validate.test.ts`
Expected: FAIL — `Cannot find module '../src/validate.js'`

- [ ] **Step 3: 검증기 구현**

`src/validate.ts`:

```typescript
import type { Declaration } from "./schema.js";

export type ValidationError = { code: string; message: string };

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
    for (const parent of r.includes ?? []) {
      if (!known.has(parent)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `롤 '${r.name}'이 없는 롤 '${parent}'을 상속한다` });
      }
    }
  }

  for (const g of d.groups) {
    for (const role of g.roles) {
      if (!known.has(role)) {
        errors.push({ code: "UNKNOWN_ROLE", message: `그룹 '${g.name}'이 없는 롤 '${role}'을 참조한다` });
      }
    }
  }

  for (const res of d.resources) {
    for (const grant of res.grants) {
      for (const role of grant.roles) {
        if (!known.has(role)) {
          errors.push({ code: "UNKNOWN_ROLE", message: `리소스 '${res.resource}'가 없는 롤 '${role}'을 참조한다` });
        }
      }
      // §5.4: PII 리소스는 마스킹 없이 select를 줄 수 없다
      const masked = Object.keys(grant.columnMask ?? {}).length > 0;
      if (res.classification === "pii" && grant.privileges.includes("select") && !masked) {
        errors.push({
          code: "PII_UNMASKED",
          message: `PII 리소스 '${res.resource}'에 마스킹 없이 select를 부여했다 (롤: ${grant.roles.join(", ")})`,
        });
      }
    }
  }

  return errors;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/validate.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 5: 커밋**

```bash
git add src/validate.ts tests/validate.test.ts
git commit -m "feat(validate): 선언 의미 검증 — 순환 상속·미정의 롤·PII 마스킹 강제"
```

---

## Task 5: Keycloak 명세 컴파일러

**Files:**
- Create: `src/compiler/keycloak.ts`
- Create: `tests/compiler-keycloak.test.ts`

**Interfaces:**
- Consumes: `Declaration` (Task 3)
- Produces:
  - `type KeycloakSpec = { realmRoles: KeycloakRole[]; groups: KeycloakGroup[] }`
  - `type KeycloakRole = { name: string; composite: boolean; composites: string[] }`
  - `type KeycloakGroup = { name: string; realmRoles: string[] }`
  - `compileKeycloak(d: Declaration): KeycloakSpec` — 결정론적(이름순 정렬)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/compiler-keycloak.test.ts`:

```typescript
import { expect, test } from "vitest";
import { compileKeycloak } from "../src/compiler/keycloak.js";
import { parseDeclaration } from "../src/schema.js";

const d = parseDeclaration(`
roles:
  - name: beluga-engineer
    includes: [beluga-analyst]
  - name: beluga-analyst
groups:
  - name: engineers
    roles: [beluga-engineer]
resources: []
`);

test("컴포지트 롤을 만든다", () => {
  const spec = compileKeycloak(d);
  const engineer = spec.realmRoles.find((r) => r.name === "beluga-engineer");
  expect(engineer?.composite).toBe(true);
  expect(engineer?.composites).toEqual(["beluga-analyst"]);
});

test("상속이 없는 롤은 composite가 아니다", () => {
  const analyst = compileKeycloak(d).realmRoles.find((r) => r.name === "beluga-analyst");
  expect(analyst?.composite).toBe(false);
  expect(analyst?.composites).toEqual([]);
});

test("그룹에 롤을 매핑한다", () => {
  expect(compileKeycloak(d).groups).toEqual([{ name: "engineers", realmRoles: ["beluga-engineer"] }]);
});

test("결정론적이다 — 이름순으로 정렬된다", () => {
  const names = compileKeycloak(d).realmRoles.map((r) => r.name);
  expect(names).toEqual(["beluga-analyst", "beluga-engineer"]);
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/compiler-keycloak.test.ts`
Expected: FAIL — `Cannot find module '../src/compiler/keycloak.js'`

- [ ] **Step 3: 컴파일러 구현**

`src/compiler/keycloak.ts`:

```typescript
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
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups: KeycloakGroup[] = d.groups
    .map((g) => ({ name: g.name, realmRoles: [...g.roles].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { realmRoles, groups };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/compiler-keycloak.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 5: 커밋**

```bash
git add src/compiler/keycloak.ts tests/compiler-keycloak.test.ts
git commit -m "feat(compiler): Keycloak 롤·그룹 명세 컴파일러 (컴포지트 상속)"
```

---

## Task 6: Rego 컴파일러 (Trino)

설계서 §3 검증표: Trino OPA는 438부터 `getColumnMask`/`getRowFilters`를 지원한다.
행 필터는 `{"expression": "..."}` 배열, 컬럼 마스킹은 컬럼당 단일 객체다.

**Files:**
- Create: `src/compiler/rego.ts`
- Create: `tests/compiler-rego.test.ts`
- Create: `tests/golden/trino.rego`

**Interfaces:**
- Consumes: `Declaration` (Task 3), `expandRoles` (Task 4)
- Produces: `compileRego(d: Declaration): string` — Rego 소스 텍스트, 결정론적

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/compiler-rego.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { compileRego } from "../src/compiler/rego.js";
import { parseDeclaration } from "../src/schema.js";

const decl = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups: []
resources:
  - resource: lake.events_enriched
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [beluga-engineer]
        privileges: [select, insert]
      - roles: [beluga-analyst]
        privileges: [select]
        columnMask:
          email: hash
        rowFilter: "region = 'KR'"
`);

test("골든 출력과 일치한다", () => {
  const expected = readFileSync(new URL("./golden/trino.rego", import.meta.url), "utf8");
  expect(compileRego(decl)).toBe(expected);
});

test("결정론적이다 — 두 번 호출해도 같다", () => {
  expect(compileRego(decl)).toBe(compileRego(decl));
});

test("deny 규칙을 만들지 않는다 (allow-by-role)", () => {
  expect(compileRego(decl)).not.toMatch(/^\s*deny\b/m);
});

test("실제 Trino OPA 입력 경로(identity.groups)를 읽는다", () => {
  const rego = compileRego(decl);
  expect(rego).toContain('"context", "identity", "groups"');
  expect(rego).not.toContain("extraCredentials");
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/compiler-rego.test.ts`
Expected: FAIL — `Cannot find module '../src/compiler/rego.js'`

- [ ] **Step 3: 컴파일러 구현**

`src/compiler/rego.ts`:

```typescript
import type { Declaration, MaskKind } from "../schema.js";
import { expandRoles } from "../validate.js";

const MASK_EXPR: Record<MaskKind, (col: string) => string> = {
  hash: (col) => `to_hex(sha256(cast(${col} as varbinary)))`,
  partial: (col) => `concat(substr(${col}, 1, 2), '***')`,
  null: () => `null`,
};

/** 리소스 문자열 "schema.table" → { schema, table } */
function splitResource(resource: string): { schema: string; table: string } {
  const idx = resource.lastIndexOf(".");
  if (idx < 0) throw new Error(`리소스는 'schema.table' 형식이어야 한다: ${resource}`);
  return { schema: resource.slice(0, idx), table: resource.slice(idx + 1) };
}

/**
 * 선언 → Trino OPA용 Rego.
 * allow-by-role만 생성한다(§5.3-3). 어떤 롤에도 허용되지 않으면 기본 거부다.
 */
export function compileRego(d: Declaration): string {
  const lines: string[] = [
    "# 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml",
    "package trino",
    "",
    "import rego.v1",
    "",
    "default allow := false",
    "",
    "# 요청자의 그룹 (Trino OPA 입력의 실제 경로 — 라이브 실측: identity 키는 groups/user 뿐)",
    "groups := object.get(input, [\"context\", \"identity\", \"groups\"], [])",
    "",
  ];

  // 리소스·롤을 이름순으로 돌아 결정론적 출력을 만든다
  const resources = [...d.resources].sort((a, b) => a.resource.localeCompare(b.resource));

  for (const res of resources) {
    const { schema, table } = splitResource(res.resource);
    for (const grant of [...res.grants].sort((a, b) => a.roles.join().localeCompare(b.roles.join()))) {
      const effective = [...new Set(grant.roles.flatMap((r) => holdersOf(d, r)))].sort();
      for (const priv of [...grant.privileges].sort()) {
        lines.push(
          `# ${res.resource} — ${priv} (${effective.join(", ")})`,
          "allow if {",
          `\tinput.action.operation == "${operationOf(priv)}"`,
          `\tinput.action.resource.table.schemaName == "${schema}"`,
          `\tinput.action.resource.table.tableName == "${table}"`,
          `\tsome g in groups`,
          `\tg in {${effective.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }

      if (grant.rowFilter) {
        lines.push(
          `# ${res.resource} — 행 필터`,
          "rowFilters contains {\"expression\": " + JSON.stringify(grant.rowFilter) + "} if {",
          `\tinput.action.resource.table.schemaName == "${schema}"`,
          `\tinput.action.resource.table.tableName == "${table}"`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }

      for (const [col, kind] of Object.entries(grant.columnMask ?? {}).sort()) {
        lines.push(
          `# ${res.resource}.${col} — 마스킹(${kind})`,
          "columnMask := {\"expression\": " + JSON.stringify(MASK_EXPR[kind](col)) + "} if {",
          `\tinput.action.resource.column.schemaName == "${schema}"`,
          `\tinput.action.resource.column.tableName == "${table}"`,
          `\tinput.action.resource.column.columnName == "${col}"`,
          `\tsome g in groups`,
          `\tg in {${grant.roles.map((r) => `"${r}"`).join(", ")}}`,
          "}",
          "",
        );
      }
    }
  }

  return lines.join("\n");
}

/** 이 롤을 실효적으로 갖는 롤들(자신 + 자신을 상속한 상위 롤) */
function holdersOf(d: Declaration, role: string): string[] {
  return d.roles.filter((r) => expandRoles(d, r.name).includes(role)).map((r) => r.name);
}

function operationOf(priv: string): string {
  switch (priv) {
    case "select":
      return "SelectFromColumns";
    case "insert":
      return "InsertIntoTable";
    case "update":
      return "UpdateTableColumns";
    case "delete":
      return "DeleteFromTable";
    default:
      throw new Error(`알 수 없는 privilege: ${priv}`);
  }
}
```

- [ ] **Step 4: 골든 파일 생성 및 육안 검토**

```bash
mkdir -p tests/golden
npx tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDeclaration } from './src/schema.ts';
import { compileRego } from './src/compiler/rego.ts';
const decl = parseDeclaration(readFileSync('tests/fixtures/sample.yaml','utf8'));
writeFileSync('tests/golden/trino.rego', compileRego(decl));
"
cat tests/golden/trino.rego
```

생성된 Rego를 눈으로 확인한다: `deny` 규칙이 없어야 하고, engineer가 analyst 권한을 상속받아
`lake.events_enriched` allow 규칙에 함께 나타나야 한다.

> **주의**: 위 명령은 `tests/fixtures/sample.yaml`을 읽는다. 테스트에 인라인으로 쓴 것과 같은
> 내용으로 이 파일을 먼저 만들 것(Step 1 테스트의 `decl` 문자열과 동일).

- [ ] **Step 5: 실제 OPA로 문법 검증**

```bash
docker run --rm -v "$PWD/tests/golden:/w" openpolicyagent/opa:1.19.0-static check /w/trino.rego
```

Expected: 출력 없음(성공). 실패하면 Rego 문법 오류다.

- [ ] **Step 6: 통과 확인**

Run: `npm test -- tests/compiler-rego.test.ts`
Expected: PASS — 3 tests passed

- [ ] **Step 7: 커밋**

```bash
git add src/compiler/rego.ts tests/compiler-rego.test.ts tests/golden/trino.rego tests/fixtures/sample.yaml
git commit -m "feat(compiler): Trino Rego 컴파일러 — allow-by-role, 컬럼 마스킹, 행 필터"
```

---

## Task 7: PostgreSQL DDL 컴파일러

**Files:**
- Create: `src/compiler/pgddl.ts`
- Create: `tests/compiler-pgddl.test.ts`
- Create: `tests/golden/roles.sql`

**Interfaces:**
- Consumes: `Declaration` (Task 3)
- Produces: `compilePgDdl(d: Declaration): string` — 멱등 SQL 텍스트, 결정론적

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/compiler-pgddl.test.ts`:

```typescript
import { expect, test } from "vitest";
import { compilePgDdl } from "../src/compiler/pgddl.js";
import { parseDeclaration } from "../src/schema.js";

const decl = parseDeclaration(`
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
groups: []
resources:
  - resource: public.orders
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
`);

test("선언의 하이픈을 PG 롤의 언더스코어로 변환한다", () => {
  expect(compilePgDdl(decl)).toContain("CREATE ROLE beluga_analyst WITH NOLOGIN INHERIT");
  expect(compilePgDdl(decl)).not.toContain("beluga-analyst");
});

test("롤을 멱등하게 생성한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("pg_roles WHERE rolname = 'beluga_analyst'");
  expect(sql).toContain("CREATE ROLE beluga_analyst WITH NOLOGIN INHERIT");
});

test("상속을 GRANT role TO role로 표현한다", () => {
  expect(compilePgDdl(decl)).toContain("GRANT beluga_analyst TO beluga_engineer;");
});

test("권한을 GRANT로 부여한다", () => {
  const sql = compilePgDdl(decl);
  expect(sql).toContain("GRANT SELECT ON TABLE public.orders TO beluga_analyst;");
  expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO beluga_engineer;");
});

test("ALTER DEFAULT PRIVILEGES를 만들지 않는다 (§10.1 기본 거부)", () => {
  expect(compilePgDdl(decl)).not.toContain("ALTER DEFAULT PRIVILEGES");
});

test("결정론적이다", () => {
  expect(compilePgDdl(decl)).toBe(compilePgDdl(decl));
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/compiler-pgddl.test.ts`
Expected: FAIL — `Cannot find module '../src/compiler/pgddl.js'`

- [ ] **Step 3: 컴파일러 구현**

`src/compiler/pgddl.ts`:

```typescript
import type { Declaration, Privilege } from "../schema.js";

/**
 * 선언의 롤 이름(하이픈)을 PG 롤 이름(언더스코어)으로 바꾼다.
 * 선언·Keycloak·Rego는 beluga-analyst, PG는 beluga_analyst — 기존 PG 롤과 맞추기 위함이며
 * 하이픈을 그대로 쓰면 CREATE ROLE이 문법 오류가 난다(따옴표 필요).
 */
export function toPgRole(name: string): string {
  return name.replace(/-/g, "_");
}

const PRIV_SQL: Record<Privilege, string> = {
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

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

  const roles = [...d.roles].sort((a, b) => a.name.localeCompare(b.name));

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

  out.push("", "-- 3. 테이블 권한 (allow-by-role, 명시적 GRANT만)");
  const resources = [...d.resources].sort((a, b) => a.resource.localeCompare(b.resource));
  for (const res of resources) {
    for (const grant of [...res.grants].sort((a, b) => a.roles.join().localeCompare(b.roles.join()))) {
      const privs = [...grant.privileges].sort().map((p) => PRIV_SQL[p]).join(", ");
      for (const role of [...grant.roles].sort()) {
        out.push(`GRANT ${privs} ON TABLE ${res.resource} TO ${toPgRole(role)};`);
      }
    }
  }

  out.push("");
  return out.join("\n");
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/compiler-pgddl.test.ts`
Expected: PASS — 5 tests passed

- [ ] **Step 5: 커밋**

```bash
git add src/compiler/pgddl.ts tests/compiler-pgddl.test.ts
git commit -m "feat(compiler): PostgreSQL DDL 컴파일러 — 멱등 롤·상속·명시적 GRANT"
```

---

## Task 8: 컴파일러 진입점과 CLI

**Files:**
- Create: `src/compiler/index.ts`
- Create: `bin/policyctl.ts`
- Create: `tests/compiler-index.test.ts`

**Interfaces:**
- Consumes: `compileKeycloak` (Task 5), `compileRego` (Task 6), `compilePgDdl` (Task 7), `validateDeclaration` (Task 4)
- Produces:
  - `type Artifacts = { keycloak: KeycloakSpec; rego: string; pgddl: string }`
  - `compileAll(d: Declaration): Artifacts` — 검증 실패 시 `throw Error`
  - CLI: `policyctl compile <policies-dir> --out <dir>`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/compiler-index.test.ts`:

```typescript
import { expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { parseDeclaration } from "../src/schema.js";

const valid = parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: analysts
    roles: [analyst]
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
`);

test("세 산출물을 모두 만든다", () => {
  const a = compileAll(valid);
  expect(a.keycloak.realmRoles).toHaveLength(1);
  expect(a.rego).toContain("package trino");
  expect(a.pgddl).toContain("CREATE ROLE analyst");
});

test("검증 실패 시 컴파일하지 않는다", () => {
  const invalid = parseDeclaration(`
roles: []
groups: []
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [ghost]
        privileges: [select]
`);
  expect(() => compileAll(invalid)).toThrow(/UNKNOWN_ROLE|PII_UNMASKED/);
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/compiler-index.test.ts`
Expected: FAIL — `Cannot find module '../src/compiler/index.js'`

- [ ] **Step 3: 진입점 구현**

`src/compiler/index.ts`:

```typescript
import type { Declaration } from "../schema.js";
import { validateDeclaration } from "../validate.js";
import { compileKeycloak, type KeycloakSpec } from "./keycloak.js";
import { compilePgDdl } from "./pgddl.js";
import { compileRego } from "./rego.js";

export type Artifacts = { keycloak: KeycloakSpec; rego: string; pgddl: string };

/** 선언을 검증한 뒤 세 갈래 산출물로 컴파일한다. 검증 실패 시 컴파일하지 않는다. */
export function compileAll(d: Declaration): Artifacts {
  const errors = validateDeclaration(d);
  if (errors.length > 0) {
    throw new Error("선언 검증 실패:\n" + errors.map((e) => `  [${e.code}] ${e.message}`).join("\n"));
  }
  return { keycloak: compileKeycloak(d), rego: compileRego(d), pgddl: compilePgDdl(d) };
}

export { compileKeycloak, compilePgDdl, compileRego };
export type { KeycloakSpec };
```

- [ ] **Step 4: CLI 구현**

`bin/policyctl.ts`:

```typescript
#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileAll } from "../src/compiler/index.js";
import { declarationSchema, type Declaration } from "../src/schema.js";
import { parse as parseYaml } from "yaml";

function loadPolicies(dir: string): Declaration {
  const read = (name: string) => parseYaml(readFileSync(join(dir, name), "utf8"));
  return declarationSchema.parse({
    roles: read("roles.yaml").roles,
    groups: read("groups.yaml").groups,
    resources: read("resources.yaml").resources,
  });
}

function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (cmd !== "compile" || !dir) {
    console.error("사용법: policyctl compile <policies-dir> --out <dir>");
    process.exit(2);
  }
  const outIdx = rest.indexOf("--out");
  const outDir = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  if (!outDir) {
    console.error("--out <dir> 이 필요하다");
    process.exit(2);
  }

  const artifacts = compileAll(loadPolicies(dir));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "trino.rego"), artifacts.rego);
  writeFileSync(join(outDir, "roles.sql"), artifacts.pgddl);
  writeFileSync(join(outDir, "keycloak.json"), JSON.stringify(artifacts.keycloak, null, 2) + "\n");
  console.log(`컴파일 완료 → ${outDir} (trino.rego, roles.sql, keycloak.json)`);
}

main();
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- tests/compiler-index.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 6: 실제 정책 파일로 CLI 확인**

beluga 리포에 정책 파일을 만든다(`~/Documents/IdeaProjects/20.dasomel/beluga/policies/`):

`roles.yaml`:

```yaml
roles:
  - name: beluga-analyst
  - name: beluga-engineer
    includes: [beluga-analyst]
  - name: beluga-admin
    includes: [beluga-engineer]
```

`groups.yaml`:

```yaml
groups:
  - name: analyst
    roles: [beluga-analyst]
  - name: engineer
    roles: [beluga-engineer]
  - name: admin
    roles: [beluga-admin]
```

`resources.yaml`:

```yaml
resources:
  - resource: lake.events_enriched
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
  - resource: lake.orders
    classification: internal
    grants:
      - roles: [beluga-analyst]
        privileges: [select]
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
```

실행:

```bash
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/artifacts
docker run --rm -v /tmp/artifacts:/w openpolicyagent/opa:1.19.0-static check /w/trino.rego
```

Expected: `컴파일 완료 → /tmp/artifacts` 그리고 opa check 무출력(성공)

- [ ] **Step 7: 커밋 (두 리포)**

```bash
# manager 리포
git add src/compiler/index.ts bin/policyctl.ts tests/compiler-index.test.ts
git commit -m "feat(cli): policyctl compile — 선언을 세 갈래 산출물로"

# beluga 리포
cd ~/Documents/IdeaProjects/20.dasomel/beluga
git add policies/
git commit -m "feat(policies): 정책 선언 원천 추가 — 롤 계층·그룹·리소스 매트릭스"
```

---

## Task 9: Keycloak group-ldap-mapper 등록

설계서 §9-3. 이것이 있어야 "그룹이 권한 축"이 실제가 된다. §3 검증표의 페이로드를 사용한다.
**이 태스크는 beluga 리포에서 작업한다.**

**Files:**
- Create: `gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml`
- Modify: `scripts/gitops/01-argocd-bootstrap.sh` (Job 적용 순서에 포함)

**Interfaces:**
- Consumes: 기존 `keycloak-ldap-federation` Job이 만든 LDAP 프로바이더 컴포넌트 ID
- Produces: LDAP 그룹이 Keycloak 그룹으로 동기화된다. 계획 2의 매트릭스 화면이 이것에 의존한다.

- [ ] **Step 1: 매퍼 등록 Job 작성**

`gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml`:

```yaml
# D19: LDAP 그룹 → Keycloak 그룹 동기화.
# 이것이 없으면 사용자만 임포트되고 그룹이 넘어오지 않아 "사용자→그룹→롤" 사슬이 끊긴다.
# mode=LDAP_ONLY라야 Keycloak→LDAP 쓰기가 된다 (IMPORT/READ_ONLY는 쓰기 안 됨).
apiVersion: batch/v1
kind: Job
metadata:
  name: keycloak-group-mapper
  namespace: beluga-system
  annotations:
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 10
  template:
    metadata:
      labels:
        app: keycloak-group-mapper
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mapper
          image: python:3.12-slim
          command:
            - python3
            - -c
            - |
              import json, sys, time, urllib.error, urllib.parse, urllib.request

              KC = "http://keycloak.beluga-system.svc.cluster.local:8080"
              REALM = "beluga"
              ADMIN_PASS = "{{ .Values.credentials.keycloakAdminPassword }}"

              def req(url, data=None, headers=None, method=None):
                  headers = dict(headers or {})
                  if isinstance(data, (dict, list)):
                      data = json.dumps(data).encode()
                      headers["Content-Type"] = "application/json"
                  r = urllib.request.Request(url, data=data, headers=headers, method=method)
                  try:
                      with urllib.request.urlopen(r) as resp:
                          body = resp.read().decode()
                          return resp.status, (json.loads(body) if body else None)
                  except urllib.error.HTTPError as e:
                      return e.code, e.read().decode()

              # 1. Keycloak 준비 대기
              for _ in range(60):
                  s, _b = req(f"{KC}/realms/{REALM}")
                  if s == 200:
                      break
                  time.sleep(5)
              else:
                  print("Keycloak이 준비되지 않았다"); sys.exit(1)

              # 2. admin 토큰
              tok_data = urllib.parse.urlencode({
                  "client_id": "admin-cli", "grant_type": "password",
                  "username": "admin", "password": ADMIN_PASS,
              }).encode()
              s, body = req(f"{KC}/realms/master/protocol/openid-connect/token",
                            data=tok_data,
                            headers={"Content-Type": "application/x-www-form-urlencoded"},
                            method="POST")
              if s != 200:
                  print(f"토큰 실패: {s} {body}"); sys.exit(1)
              auth = {"Authorization": f"Bearer {body['access_token']}"}

              # 3. LDAP 프로바이더 컴포넌트 찾기
              #    서버측 type 필터는 빈 목록을 반환하므로 전체를 받아 클라이언트에서 거른다
              s, comps = req(f"{KC}/admin/realms/{REALM}/components", headers=auth)
              if s != 200:
                  print(f"컴포넌트 조회 실패: {s} {comps}"); sys.exit(1)
              ldap = [c for c in comps if c.get("providerId") == "ldap"]
              if len(ldap) != 1:
                  print(f"LDAP 프로바이더가 정확히 1개여야 한다 (현재 {len(ldap)}개)"); sys.exit(1)
              parent_id = ldap[0]["id"]

              # 4. group-ldap-mapper 멱등 생성
              existing = [c for c in comps
                          if c.get("providerId") == "group-ldap-mapper" and c.get("parentId") == parent_id]
              payload = {
                  "name": "beluga-groups",
                  "providerId": "group-ldap-mapper",
                  "providerType": "org.keycloak.storage.ldap.mappers.LDAPStorageMapper",
                  "parentId": parent_id,
                  "config": {
                      "groups.dn": ["ou=Groups,dc=beluga,dc=internal"],
                      "group.name.ldap.attribute": ["cn"],
                      "group.object.classes": ["groupOfNames"],
                      "membership.ldap.attribute": ["member"],
                      "membership.attribute.type": ["DN"],
                      "membership.user.ldap.attribute": ["uid"],
                      "mode": ["LDAP_ONLY"],
                      "user.roles.retrieve.strategy": ["LOAD_GROUPS_BY_MEMBER_ATTRIBUTE"],
                      "preserve.group.inheritance": ["false"],
                      "drop.non.existing.groups.during.sync": ["false"],
                  },
              }
              if existing:
                  payload["id"] = existing[0]["id"]
                  s, b = req(f"{KC}/admin/realms/{REALM}/components/{existing[0]['id']}",
                             data=payload, headers=auth, method="PUT")
                  ok = s in (200, 204)
              else:
                  s, b = req(f"{KC}/admin/realms/{REALM}/components", data=payload, headers=auth, method="POST")
                  ok = s == 201
              if not ok:
                  print(f"매퍼 생성/갱신 실패: {s} {b}"); sys.exit(1)
              print("group-ldap-mapper 등록 완료")
```

- [ ] **Step 2: 렌더 검증**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga
helm lint gitops/charts/beluga-platform
helm template gitops/charts/beluga-platform \
  --set credentials.keycloakAdminPassword=x --set credentials.apisixAdminKey=x \
  --set credentials.ldapAdminPassword=x --set credentials.clientSecrets.superset=x \
  --set credentials.clientSecrets.airflow=x --set credentials.clientSecrets.openmetadata=x \
  --set credentials.clientSecrets.grafana=x --set credentials.clientSecrets.trino=x \
  -s templates/keycloak-group-mapper.yaml \
  | yq 'select(.kind=="Job") | .spec.template.spec.containers[0].command[2]' \
  | python3 -c "import sys; compile(sys.stdin.read(),'m','exec'); print('PY OK')"
```

Expected: `1 chart(s) linted, 0 chart(s) failed` 그리고 `PY OK`

- [ ] **Step 3: 라이브 적용**

```bash
export KUBECONFIG=$PWD/.kube/config
KC=$(kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.keycloak-admin-password}' | base64 -d)
helm template beluga-platform gitops/charts/beluga-platform --namespace beluga-system \
  --set credentials.keycloakAdminPassword="$KC" --set credentials.apisixAdminKey=x \
  --set credentials.ldapAdminPassword=x --set credentials.clientSecrets.superset=x \
  --set credentials.clientSecrets.airflow=x --set credentials.clientSecrets.openmetadata=x \
  --set credentials.clientSecrets.grafana=x --set credentials.clientSecrets.trino=x \
  -s templates/keycloak-group-mapper.yaml | kubectl apply -f -
kubectl -n beluga-system wait --for=condition=complete job/keycloak-group-mapper --timeout=180s
```

Expected: `job.batch/keycloak-group-mapper condition met`

> **선행 조건**: LDAP 프로바이더가 정확히 1개여야 한다. 현 세션 핸드오프의 1순위 작업
> (LDAP write-back 마감)이 끝나지 않았다면 이 Job은 "정확히 1개여야 한다"로 실패한다.
> 그 경우 핸드오프의 재개 절차를 먼저 수행할 것.

- [ ] **Step 4: 그룹 동기화 확인**

```bash
KC=$(kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.keycloak-admin-password}' | base64 -d)
TOKEN=$(curl -s -d client_id=admin-cli -d username=admin -d "password=$KC" -d grant_type=password \
  http://sso.local.beluga.internal/realms/master/protocol/openid-connect/token \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://sso.local.beluga.internal/admin/realms/beluga/groups \
  | python3 -c "import sys,json; print([g['name'] for g in json.load(sys.stdin)])"
```

Expected: LDAP의 `ou=Groups` 아래 그룹 이름들이 나타난다.

- [ ] **Step 5: 커밋**

```bash
git add gitops/charts/beluga-platform/templates/keycloak-group-mapper.yaml
git commit -m "feat(gitops): Keycloak group-ldap-mapper 등록 — 그룹→롤 사슬 연결 (D19)"
```

---

## Task 10: 드리프트 비교

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/drift.ts`
- Create: `tests/drift.test.ts`

**Interfaces:**
- Consumes: `Artifacts` (Task 8)
- Produces:
  - `type ActualState = { keycloakRoles: string[]; keycloakGroups: Record<string, string[]>; pgGrants: string[] }`
  - `type DriftKind = "unapplied" | "manual" | "mismatch"`
  - `type DriftItem = { kind: DriftKind; target: string; detail: string }`
  - `diffState(desired: Artifacts, actual: ActualState): DriftItem[]`
  - `interface Adapter { readState(): Promise<Partial<ActualState>>; apply(a: Artifacts): Promise<void> }`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/drift.test.ts`:

```typescript
import { expect, test } from "vitest";
import { compileAll } from "../src/compiler/index.js";
import { diffState } from "../src/drift.js";
import { parseDeclaration } from "../src/schema.js";

const desired = compileAll(parseDeclaration(`
roles:
  - name: analyst
groups:
  - name: analysts
    roles: [analyst]
resources: []
`));

test("선언에만 있으면 미적용이다", () => {
  const items = diffState(desired, { keycloakRoles: [], keycloakGroups: {}, pgGrants: [] });
  expect(items).toContainEqual({ kind: "unapplied", target: "keycloak.role/analyst", detail: "선언됨, 실제 없음" });
});

test("실제에만 있으면 수동 변경이다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst", "ghost-role"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toContainEqual({ kind: "manual", target: "keycloak.role/ghost-role", detail: "실제에만 존재 — 수동 변경 의심" });
});

test("일치하면 드리프트가 없다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: ["analyst"] },
    pgGrants: [],
  });
  expect(items).toEqual([]);
});

test("그룹의 롤 구성이 다르면 불일치다", () => {
  const items = diffState(desired, {
    keycloakRoles: ["analyst"],
    keycloakGroups: { analysts: [] },
    pgGrants: [],
  });
  expect(items.map((i) => i.kind)).toContain("mismatch");
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `npm test -- tests/drift.test.ts`
Expected: FAIL — `Cannot find module '../src/drift.js'`

- [ ] **Step 3: 어댑터 인터페이스와 드리프트 비교 구현**

`src/adapters/types.ts`:

```typescript
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
```

`src/drift.ts`:

```typescript
import type { ActualState } from "./adapters/types.js";
import type { Artifacts } from "./compiler/index.js";

export type DriftKind = "unapplied" | "manual" | "mismatch";
export type DriftItem = { kind: DriftKind; target: string; detail: string };

/**
 * 선언(desired)과 실제(actual)를 대조한다.
 * 세 종류로 분류한다: 미적용 / 수동 변경 / 값 불일치 (설계서 §7.2)
 */
export function diffState(desired: Artifacts, actual: ActualState): DriftItem[] {
  const items: DriftItem[] = [];

  const desiredRoles = desired.keycloak.realmRoles.map((r) => r.name);
  const actualRoles = new Set(actual.keycloakRoles);

  for (const name of desiredRoles) {
    if (!actualRoles.has(name)) {
      items.push({ kind: "unapplied", target: `keycloak.role/${name}`, detail: "선언됨, 실제 없음" });
    }
  }
  for (const name of actual.keycloakRoles) {
    if (!desiredRoles.includes(name)) {
      items.push({ kind: "manual", target: `keycloak.role/${name}`, detail: "실제에만 존재 — 수동 변경 의심" });
    }
  }

  for (const g of desired.keycloak.groups) {
    const actualRolesOfGroup = actual.keycloakGroups[g.name];
    if (actualRolesOfGroup === undefined) {
      items.push({ kind: "unapplied", target: `keycloak.group/${g.name}`, detail: "선언됨, 실제 없음" });
      continue;
    }
    const want = [...g.realmRoles].sort().join(",");
    const have = [...actualRolesOfGroup].sort().join(",");
    if (want !== have) {
      items.push({
        kind: "mismatch",
        target: `keycloak.group/${g.name}`,
        detail: `롤 구성이 다르다 — 선언: [${want}], 실제: [${have}]`,
      });
    }
  }

  return items;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/drift.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `npm test && npm run typecheck`
Expected: 모든 테스트 PASS, 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/adapters/types.ts src/drift.ts tests/drift.test.ts
git commit -m "feat(drift): 선언 vs 실제 대조 — 미적용·수동변경·불일치 3분류"
```

---

## 완료 정의

이 계획이 끝나면 아래가 모두 성립한다.

1. `bash tests/06-authz-defaults.sh` 통과 — 신규 테이블이 기본 거부 상태 (Task 1)
2. `npm test` 전체 통과 — 스키마·검증·컴파일러 3종·드리프트 (Task 3~8, 10)
3. `npm run typecheck` 오류 없음
4. `npm run policyctl -- compile <beluga>/policies --out /tmp/artifacts` 가 세 파일을 생성하고,
   생성된 `trino.rego`가 `opa check`를 통과한다 (Task 8)
5. Keycloak 그룹 목록에 LDAP 그룹이 나타난다 (Task 9)

## 다음 계획으로 넘길 것

- 어댑터 실제 구현(`readState`/`apply`의 네트워크 부분) — 계획 2에서 UI와 함께
- Git 커밋 경로(하이브리드 쓰기의 Git 절반) — 계획 2
- 5개 화면, diff 게이트, sync worker CronJob — 계획 2
- 마스킹 산출물의 PG 쪽 적용(`SECURITY LABEL`) — 계획 3 (PG18 승급 후)
- 개인별 PG 롤 전환 — 계획 4
