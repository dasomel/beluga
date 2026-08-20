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
  이 `groups`는 Trino **그룹 프로바이더**(`etc/group-provider.properties`)가 채운다 — JWT/OIDC
  클레임에서는 절대 오지 않는다. Trino OSS의 OAuth2 인증에는 groups-claim 속성 자체가 없고
  (있는 건 사용자 필드를 고르는 `principal-field`뿐), Keycloak이 토큰에 무엇을 담든 Trino의
  `identity.groups`에는 반영되지 않는다. Beluga는 **LDAP 그룹 프로바이더**(검색 모드)를 쓴다(D-D,
  Task 13) — OpenLDAP에 `memberOf` 오버레이가 없으므로(`gitops/charts/beluga-platform/templates/openldap.yaml`
  전수 확인) `ldap.use-group-filter=true` + `ldap.group-base-dn`/`ldap.group-search-filter`/
  `ldap.group-search-member-attribute` 조합만 쓸 수 있고, 속성 모드(`ldap.user-member-of-attribute`)는
  못 쓴다.
- **권한 부여(authorization)와 인증(authentication)은 서로 다른 축이다.** 그룹 프로바이더가
  `identity.groups`를 채우는 것은 인증 여부와 무관하다 — Trino 인증이 전혀 설정되지 않은 상태에서도
  그룹 프로바이더는 `X-Trino-User`(또는 매핑된 기본값)로 정해진 `identity.user` 문자열을 그대로
  받아 그룹을 조회한다. 즉 Task 13(그룹 프로바이더)은 Task 15~16(cert-manager → TLS → OAuth2, D-E)과
  독립적으로 먼저 동작한다 — 하나가 됐다고 다른 하나가 자동으로 되는 게 아니다. 인증이 없는 동안은
  `X-Trino-User`로 아무 사용자나 자칭할 수 있다는 구멍이 그대로 남으며, 이건 Task 16이 닫는다.
- **롤 이름: 선언·Keycloak·Rego·PG는 모두 LDAP 그룹 `cn` 값과 동일한 이름을 쓴다** —
  `analysts`/`engineers`/`admins` (Task 11, D-F). 예전 계획의 `beluga-analyst`/`beluga-engineer`/
  `beluga-admin`은 폐기됐다: Rego가 `identity.groups`를 그대로 대조하므로 선언의 롤 이름이 그룹
  프로바이더가 채우는 값(OpenLDAP `cn=analysts,ou=groups,...` 등, `gitops/charts/beluga-platform/templates/openldap.yaml`
  ~238/246/254행)과 정확히 같아야 `g in {...}` 매칭이 성립한다. **PG DDL만 여전히 언더스코어로
  변환**한다(`toPgRole()`) — 하이픈이 있던 시절의 규칙이 그대로 남아 있는 건, 이 이름들이
  현재는 하이픈이 없어도 향후 `data-team`처럼 하이픈 섞인 롤 이름이 선언될 수 있고, 그 경우
  `CREATE ROLE data-team`은 그대로 문법 오류이기 때문이다. `toPgRole()`은 소문자 접기도 겸한다 —
  PostgreSQL이 따옴표 없는 식별자를 소문자로 접기 때문에 대소문자만 다른 두 선언이 조용히 같은
  물리 롤로 합쳐지는 것을 막기 위함이다(`src/pgrole.ts`).
- **`pii` 리소스는 `sensitiveColumns`를 선언하고 `select`에 대해 그 전부를 마스킹해야 한다.** 디코이 컬럼 하나만 마스킹하고 나머지를 노출하는 우회를 막는다. (§5.4)
- **`pii` 리소스에 마스킹 없는 `select`를 부여하려면 해당 grant에 `allowUnmasked: true`를 명시해야 한다.** `engineers`·`admins`처럼 원문 PII를 봐야 하는 롤을 위한 옵트인이며, `sensitiveColumns`가 없는 경우의 `PII_NO_SENSITIVE_COLUMNS`는 이 옵트인과 무관하게 그대로 적용된다.
- **`rowFilter`는 단일 연산자 종류(AND 체인 또는 OR 체인)만 허용하는 화이트리스트 문법만 통과한다.** 혼합·괄호는 미지원 — `A AND B OR C`를 SQL 우선순위대로 `(A AND B) OR C`로 잘못 읽는 함정을 막는다. (§5.4)

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
  - `type Resource = { resource: string; classification: "public" | "internal" | "pii"; grants: Grant[]; sensitiveColumns?: string[] }`
  - `type Grant = { roles: string[]; privileges: Privilege[]; columnMask?: Record<string, MaskKind>; rowFilter?: string; allowUnmasked?: boolean }`
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
    sensitiveColumns: [email]
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
  allowUnmasked: z.boolean().optional(),
});

export const resourceSchema = z.strictObject({
  resource: z.string().min(1),
  classification: z.enum(["public", "internal", "pii"]),
  grants: z.array(grantSchema),
  sensitiveColumns: z.array(z.string().min(1)).optional(),
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

test("PII 리소스에 민감 컬럼이 없으면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [analyst]
        privileges: [select]
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_NO_SENSITIVE_COLUMNS");
});

test("PII 리소스에 마스킹 없는 select를 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email]
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
    sensitiveColumns: [email]
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("PII 리소스의 모든 민감 컬럼이 마스킹되어야 한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        columnMask:
          email: hash
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("rowFilter는 허용 문법만 수용한다", () => {
  // 유효한 cases
  const valid1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'KR'"
`);
  expect(validateDeclaration(valid1)).toEqual([]);

  const valid2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "dept_id IN (1, 2)"
`);
  expect(validateDeclaration(valid2)).toEqual([]);

  const valid3 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "owner = current_user"
`);
  expect(validateDeclaration(valid3)).toEqual([]);

  const valid4 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 AND b <> 'x'"
`);
  expect(validateDeclaration(valid4)).toEqual([]);
});

test("rowFilter는 SQL injection을 거부한다", () => {
  const invalid1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "1=1; DROP TABLE customers"
`);
  expect(validateDeclaration(invalid1).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'KR' OR 1=1 --"
`);
  expect(validateDeclaration(invalid2).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid3 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region IN (SELECT x FROM y)"
`);
  expect(validateDeclaration(invalid3).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const invalid4 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "region = 'a''b'"
`);
  expect(validateDeclaration(invalid4).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");
});

test("rowFilter는 AND와 OR을 섞는 것을 거부한다", () => {
  // AND와 OR을 섞으면 SQL 우선순위가 글로 읽히는 것과 달라진다
  const mixed1 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "tenant_id = 'acme' AND status = 'active' OR status = 'archived'"
`);
  expect(validateDeclaration(mixed1).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");

  const mixed2 = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 OR b = 2 AND c = 3"
`);
  expect(validateDeclaration(mixed2).map((e) => e.code)).toContain("ROW_FILTER_REJECTED");
});

test("rowFilter는 한 종류의 연산자만 허용한다", () => {
  // AND 체인만
  const andChain = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 AND b = 2 AND c = 3"
`);
  expect(validateDeclaration(andChain)).toEqual([]);

  // OR 체인만
  const orChain = base(`
resources:
  - resource: lake.t
    classification: internal
    grants:
      - roles: [analyst]
        privileges: [select]
        rowFilter: "a = 1 OR b = 2 OR c = 3"
`);
  expect(validateDeclaration(orChain)).toEqual([]);
});

test("allowUnmasked: true는 PII 마스킹 요구를 무시한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [engineer]
        privileges: [select]
        allowUnmasked: true
`);
  expect(validateDeclaration(d)).toEqual([]);
});

test("allowUnmasked: false는 PII 마스킹을 요구한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        allowUnmasked: false
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_UNMASKED");
});

test("allowUnmasked: true여도 sensitiveColumns이 없으면 거부한다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    grants:
      - roles: [engineer]
        privileges: [select]
        allowUnmasked: true
`);
  expect(validateDeclaration(d).map((e) => e.code)).toContain("PII_NO_SENSITIVE_COLUMNS");
});

test("allowUnmasked: true와 부분 마스킹은 함께 사용할 수 있다", () => {
  const d = base(`
resources:
  - resource: lake.customers
    classification: pii
    sensitiveColumns: [email, ssn]
    grants:
      - roles: [analyst]
        privileges: [select]
        allowUnmasked: true
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
    const sensitive = res.sensitiveColumns ?? [];
    if (res.classification === "pii" && sensitive.length === 0) {
      errors.push({
        code: "PII_NO_SENSITIVE_COLUMNS",
        message: `PII 리소스 '${res.resource}'에 sensitiveColumns가 없다 — 무엇을 가려야 하는지 선언하지 않으면 마스킹을 강제할 수 없다`,
      });
    }

    for (const grant of res.grants) {
      for (const role of grant.roles) {
        if (!known.has(role)) {
          errors.push({ code: "UNKNOWN_ROLE", message: `리소스 '${res.resource}'가 없는 롤 '${role}'을 참조한다` });
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
  }

  return errors;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/validate.test.ts`
Expected: PASS — 15 tests passed

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

`src/compare.ts` (두 컴파일러가 공유):

```typescript
/**
 * locale-독립 문자열 비교자. localeCompare는 런타임 로케일/ICU 빌드에 의존해
 * 결정론적 정렬을 깬다(§5.3-2). rego/keycloak 두 컴파일러가 공유한다.
 */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
```

`src/compiler/keycloak.ts`:

```typescript
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
    sensitiveColumns: [email]
    grants:
      - roles: [beluga-engineer]
        privileges: [select, insert]
        allowUnmasked: true
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
import { cmp } from "../compare.js";
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
  const resources = [...d.resources].sort((a, b) => cmp(a.resource, b.resource));

  for (const res of resources) {
    const { schema, table } = splitResource(res.resource);
    for (const grant of [...res.grants].sort((a, b) => cmp(a.roles.join(), b.roles.join()))) {
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

> **참고**: 위 `rowFilter` 인라인(`JSON.stringify(grant.rowFilter)`)은 SQL 인젝션 검사가
> 아니라 Rego 문자열 리터럴 이스케이프일 뿐이다. 실제 방어는 `compileAll`이 컴파일 전에
> 호출하는 `validateDeclaration`(Task 4)이 담당한다 — 단일 연산자 종류(AND 체인 또는 OR
> 체인)만 허용하는 화이트리스트 문법을 통과한 값만 여기까지 도달한다.

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
import { cmp } from "../compare.js";
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

// 권한 표기 순서는 privilegeSchema의 정규 순서를 따른다. 알파벳 정렬(.sort())은
// delete/insert/select/update로 재배열되어 SQL이 읽히는 관례와 어긋나고, 선언 순서를
// 그대로 쓰면 같은 권한 집합이라도 다른 SQL이 나와 결정론이 깨진다(§5.3-2).
// 순서 정의는 PRIV_SQL 하나에만 두어 스키마와 어긋날 수 없게 한다.
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

  out.push("", "-- 3. 테이블 권한 (allow-by-role, 명시적 GRANT만)");
  const resources = [...d.resources].sort((a, b) => cmp(a.resource, b.resource));
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
    sensitiveColumns: [email]
    grants:
      - roles: [beluga-engineer]
        privileges: [select, insert, update, delete]
        allowUnmasked: true
```

`beluga-engineer`는 설계서 §10.2에서 PII 원본 접근이 허용된 롤이다. 여기에 `columnMask`를
붙이면 검증은 통과하지만 엔지니어가 원본 대신 해시를 보게 된다 — 정책이 조용히 바뀐다.
예외는 `allowUnmasked: true`로 선언에 드러내고, 기본은 그대로 거부로 둔다.

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

설계서 §9-3. LDAP 그룹을 Keycloak 그룹으로 동기화한다. §3 검증표의 페이로드를 사용한다.
**주의(D-D 이후 갱신)**: 이 매퍼는 **Trino 권한과 무관하다**. Trino는 LDAP 그룹
프로바이더로 `identity.groups`를 직접 채우므로(Task 13) Keycloak을 거치지 않는다.
이 태스크가 필요한 이유는 Keycloak을 IdP로 쓰는 **다른** 서비스들이다 — Superset의
`AUTH_ROLES_MAPPING`(그룹명 키)과 계획 2의 매트릭스 화면이 Keycloak 그룹에 의존한다.
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

## Task 11: 롤 이름 변경 — LDAP 그룹명과 일치 (D-F)

Task 6·8 리뷰(`task-8-review.md` Important 1)가 잡아낸 결함: 생성된 Rego는 롤 이름
(`beluga-analyst` 등)을 대조하는데, 실제 `identity.groups`에 실리는 값(그룹 프로바이더든
Keycloak 클레임이든)은 그룹 이름(`analyst`/`engineer`/`admin` 또는 `analysts`/`engineers`/
`admins`)이라 항상 어긋났다. 프로젝트 오너 결정(D-F): 선언의 롤 이름 자체를 OpenLDAP 그룹의
`cn` 값과 동일하게 바꾼다 — `beluga-analyst`→`analysts`, `beluga-engineer`→`engineers`,
`beluga-admin`→`admins`. 반대 방향(LDAP 그룹명을 바꾸는 것)은 기각됐다 — LDAP 그룹명은
Keycloak LDAP 페더레이션을 거쳐 Keycloak **그룹**명으로도 흘러들고, `AUTH_ROLES_MAPPING`
(`gitops/charts/beluga-data/templates/08-superset.yaml:17-21`, 키: `admin`/`engineer`/`analyst`
— 단수, Keycloak **그룹**명이지 이 태스크가 바꾸는 선언 **롤**명이 아니다)까지 건드리게 된다.
`policies/*.yaml`은 beluga 리포의 자체 산출물이라 블라스트 반경이 0이다.

**이 태스크는 두 리포에 걸친다: beluga-manager(컴파일러·테스트)와 beluga(정책 원천).**

**Files:**
- Modify (beluga 리포): `policies/roles.yaml`, `policies/groups.yaml`, `policies/resources.yaml`
- Modify (beluga-manager 리포): `tests/fixtures/sample.yaml`, `tests/golden/trino.rego`,
  `tests/compiler-rego.test.ts`, `tests/compiler-pgddl.test.ts`, `tests/compiler-keycloak.test.ts`,
  `tests/schema.test.ts`, `tests/validate.test.ts`, `src/pgrole.ts`(주석), `src/compiler/rego.ts`(주석)

**Interfaces:** 변경 없음 — 문자열 치환만이며 `compileRego`/`compileKeycloak`/`compilePgDdl`/
`validateDeclaration`의 시그니처는 그대로다.

- [ ] **Step 1: beluga 리포의 정책 원천을 새 이름으로 바꾼다**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga
sed -i '' \
  -e 's/beluga-analyst/analysts/g' \
  -e 's/beluga-engineer/engineers/g' \
  -e 's/beluga-admin/admins/g' \
  policies/roles.yaml policies/groups.yaml policies/resources.yaml
cat policies/roles.yaml
```

Expected:
```yaml
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
  - name: admins
    includes: [engineers]
```

`policies/groups.yaml`의 `name:` 필드(`analyst`/`engineer`/`admin`, Keycloak **그룹**명)는
건드리지 않는다 — 이 태스크는 선언의 **롤** 이름만 바꾼다. `roles:` 목록 값만 바뀐다:

```yaml
groups:
  - name: analyst
    roles: [analysts]
  - name: engineer
    roles: [engineers]
  - name: admin
    roles: [admins]
```

- [ ] **Step 2: beluga-manager의 테스트 원천을 같은 방식으로 바꾼다**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
sed -i '' \
  -e 's/beluga-analyst/analysts/g' \
  -e 's/beluga-engineer/engineers/g' \
  -e 's/beluga-admin/admins/g' \
  tests/fixtures/sample.yaml \
  tests/compiler-rego.test.ts tests/compiler-pgddl.test.ts tests/compiler-keycloak.test.ts \
  tests/schema.test.ts tests/validate.test.ts \
  src/pgrole.ts src/compiler/rego.ts
grep -rn "beluga-analyst\|beluga-engineer\|beluga-admin" . --include="*.ts" --include="*.yaml" \
  | grep -v node_modules
```

Expected: 마지막 grep이 빈 결과여야 한다(주석 포함 전량 치환 확인).

- [ ] **Step 3: 골든 파일 재생성**

```bash
npx tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDeclaration } from './src/schema.ts';
import { compileRego } from './src/compiler/rego.ts';
const decl = parseDeclaration(readFileSync('tests/fixtures/sample.yaml','utf8'));
writeFileSync('tests/golden/trino.rego', compileRego(decl));
"
git diff tests/golden/trino.rego
```

생성된 diff를 육안으로 확인한다 — `analysts`/`engineers`/`admins` 문자열로만 바뀌고 구조는
동일해야 한다. `allowUnmasked`/`columnMask`/`rowFilter` 관련 규칙 개수가 변하지 않았는지 확인.

- [ ] **Step 4: 통과 확인**

Run: `npm test && npm run typecheck`
Expected: 모든 테스트 PASS, 타입 오류 없음. `ROLE_NAME_COLLISION`·`CONFLICTING_MASK` 등
검증 테스트가 새 이름으로도 여전히 의도한 케이스를 잡아내는지 특히 확인한다(이름만 바뀌었지
충돌 판정 로직 자체는 손대지 않았으므로 실패하면 치환이 테스트의 의도를 깬 것이다).

- [ ] **Step 5: 실제 정책 원천으로 컴파일러를 돌려 opa check까지 통과시킨다**

```bash
mkdir -p /tmp/beluga-artifacts-task11
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/beluga-artifacts-task11
grep -c 'g in {"analysts", "engineers", "admins"}\|"analysts"\|"engineers"\|"admins"' /tmp/beluga-artifacts-task11/trino.rego
docker run --rm -v /tmp/beluga-artifacts-task11:/w openpolicyagent/opa:1.19.0-static check /w/trino.rego
```

Expected: `opa check`가 출력 없이 성공(문법 오류 없음), grep이 0보다 큰 카운트를 낸다(실제
정책이 실제로 새 이름으로 컴파일됐다는 증거 — golden 테스트만으로는 실제 `policies/`가
치환됐는지 증명하지 못한다).

- [ ] **Step 6: 커밋 (두 리포 각각)**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
git add tests/fixtures/sample.yaml tests/golden/trino.rego tests/compiler-rego.test.ts \
  tests/compiler-pgddl.test.ts tests/compiler-keycloak.test.ts tests/schema.test.ts \
  tests/validate.test.ts src/pgrole.ts src/compiler/rego.ts
git commit -m "fix(policies): 롤 이름을 LDAP 그룹명과 일치시킴 — beluga-analyst 등 폐기 (D-F)"

cd ~/Documents/IdeaProjects/20.dasomel/beluga
git add policies/roles.yaml policies/groups.yaml policies/resources.yaml
git commit -m "fix(policies): 롤 이름을 LDAP 그룹명과 일치시킴 — analysts/engineers/admins (D-F)"
```

---

## Task 12: 카탈로그·쿼리 레벨 오퍼레이션 — ExecuteQuery/ShowSchemas 갭 해소

Task 8 리뷰(`task-8-review.md` Important 2)의 실측: `default allow := false` 위에서 생성된
Rego는 테이블 오퍼레이션(select/insert/update/delete) 4종의 allow 규칙만 만든다. 그런데 Trino
OPA 접근 제어는 쿼리 실행 자체(`ExecuteQuery`)와 스키마 나열(`ShowSchemas`) 등 테이블과
무관한 오퍼레이션에도 매 요청 allow를 요구한다 — 실측으로 `ExecuteQuery -> false`,
`ShowSchemas -> false`가 나왔고, `ExecuteQuery`가 거부되면 테이블 규칙이 맞아도 쿼리 자체가
시작되지 않는다. 현재 선언 모델(`resource`+`grants`)에는 카탈로그/쿼리 레벨 오퍼레이션을
표현할 방법이 없다 — `default allow := false`이므로 이건 보안 구멍이 아니라 기능 공백이다
(권한 상승 없음, 그저 아무도 못 쓴다).

Trino 배포 카탈로그는 하나뿐이다 — `iceberg`(`gitops/charts/beluga-data/templates/06-trino.yaml:4-17`,
ConfigMap `trino-catalog-iceberg`의 데이터 키가 `iceberg.properties`이므로 카탈로그명은
`iceberg`; `policies/resources.yaml`의 `lake.events_enriched` 같은 리소스 문자열은
`schema.table`이지 `catalog.schema`가 아니다 — `lake`는 스키마, `iceberg`가 카탈로그다).

**이 태스크는 두 리포에 걸친다.**

**Files:**
- Modify (beluga-manager): `src/schema.ts`, `src/compiler/rego.ts`
- Create (beluga-manager): `tests/fixtures/catalog-grants.yaml`
- Modify (beluga-manager): `tests/compiler-rego.test.ts`, `tests/golden/trino.rego`
- Create (beluga 리포): `policies/catalog.yaml`
- Modify (beluga-manager): `bin/policyctl.ts` (4번째 정책 파일 로드, 선택적)

**Interfaces:**
- Consumes: `Declaration` (Task 3), `holdersOf` (Task 4/11)
- Produces: `declarationSchema`에 선택적 `catalogGrants` 필드 추가; `compileRego`가 그 필드로
  `ExecuteQuery`/`AccessCatalog`/`ShowSchemas` allow 규칙을 추가로 방출

- [ ] **Step 1: 실측 — Trino가 실제로 보내는 오퍼레이션·리소스 모양을 확인한다**

`ExecuteQuery`가 리소스 없이 정체성만으로 평가된다는 것(Trino `SystemAccessControl.
checkCanExecuteQuery(identity)`는 리소스 인자를 받지 않는 공개 API 시그니처)과, `AccessCatalog`/
`ShowSchemas`가 카탈로그명을 리소스로 실어 보낸다는 것은 Trino의 공개 SPI에서 나온 합리적
추정이지, 이번 리서치(`trino-auth-research.md`)에서 라이브로 확인한 사실은 아니다. **아래
Step 3의 코드를 그대로 믿지 말고, 이 Step에서 실측한 그대로 맞춘다:**

```bash
# access-control.properties에 임시로 로그 활성화
kubectl -n beluga-data patch configmap trino-access-control --type merge -p '
{"data":{"access-control.properties":"access-control.name=opa\nopa.policy.uri=http://opa.beluga-system.svc.cluster.local:8181/v1/data/trino/allow\nopa.log-requests=true\n"}}'
kubectl -n beluga-data rollout restart deployment/trino-coordinator
kubectl -n beluga-data rollout status deployment/trino-coordinator --timeout=120s

# 실제 쿼리 하나를 날려 OPA가 받는 요청을 관찰한다 (Trino 로그에 opa.log-requests 출력)
kubectl -n beluga-data exec deploy/trino-coordinator -- \
  trino --server http://localhost:8080 --execute "SELECT * FROM iceberg.lake.orders LIMIT 1" || true
kubectl -n beluga-data logs deploy/trino-coordinator --since=2m | grep -A5 '"operation"'
```

Expected: `ExecuteQuery`, `AccessCatalog`, `ShowSchemas`(스키마 나열이 실제로 발생하는 경로라면)
등 테이블 아닌 오퍼레이션의 요청 JSON을 그대로 캡처한다. `action.resource` 키가 아예 없는지,
`{"catalog":{"name":"iceberg"}}` 형태인지, 다른 형태인지 **문자 그대로 기록**한다. Step 3의
`operationOf`/리소스 매칭 코드를 이 실측과 다르게 써야 한다면 실측을 따른다.

- [ ] **Step 2: 스키마 확장**

`src/schema.ts`에 추가:

```typescript
export const queryOperationSchema = z.enum(["ExecuteQuery", "AccessCatalog", "ShowSchemas"]);

export const catalogGrantSchema = z.strictObject({
  catalog: z.string().min(1),
  roles: z.array(z.string()).min(1),
  operations: z.array(queryOperationSchema).min(1),
});

export type QueryOperation = z.infer<typeof queryOperationSchema>;
export type CatalogGrant = z.infer<typeof catalogGrantSchema>;
```

`declarationSchema`를 다음으로 바꾼다(기존 3개 필드는 그대로 두고 선택적 필드 하나 추가 —
`catalogGrants`가 없는 기존 선언도 계속 유효해야 기존 골든 테스트가 깨지지 않는다):

```typescript
export const declarationSchema = z.strictObject({
  roles: z.array(roleSchema),
  groups: z.array(groupSchema),
  resources: z.array(resourceSchema),
  catalogGrants: z.array(catalogGrantSchema).optional(),
});
```

- [ ] **Step 3: Rego 방출 확장**

`src/compiler/rego.ts`의 `compileRego` 안, 리소스 루프가 끝난 뒤(또는 전, 순서는 상관없으나
결정론을 위해 카탈로그 그랜트를 `catalog` 이름순으로 먼저 정렬한다) 추가:

```typescript
// Step 1 실측대로 맞출 것 — 아래는 Trino 공개 SPI 시그니처 기준 초안이다.
// ExecuteQuery는 리소스가 없다(identity만으로 평가). AccessCatalog/ShowSchemas는
// 카탈로그명을 리소스로 싣는다고 가정한다.
const catalogGrants = [...(d.catalogGrants ?? [])].sort((a, b) => cmp(a.catalog, b.catalog));
for (const cg of catalogGrants) {
  const effective = [...new Set(cg.roles.flatMap((r) => holdersOf(d, r)))].sort(cmp);
  for (const op of [...cg.operations].sort(cmp)) {
    const resourceGuard =
      op === "ExecuteQuery" ? [] : [`\tinput.action.resource.catalog.name == ${JSON.stringify(cg.catalog)}`];
    lines.push(
      `# 카탈로그 ${sanitizeComment(cg.catalog)} — ${op} (${effective.map(sanitizeComment).join(", ")})`,
      "allow if {",
      `\tinput.action.operation == ${JSON.stringify(op)}`,
      ...resourceGuard,
      `\tsome g in groups`,
      `\tg in {${effective.map((r) => JSON.stringify(r)).join(", ")}}`,
      "}",
      "",
    );
  }
}
```

`holdersOf`는 이미 `rego.ts`가 Task 6 수정 라운드에서 `validate.ts`로부터 가져다 쓰고 있다
(현재 `import { holdersOf } from "../validate.js";`) — 새 import 불필요.

- [ ] **Step 4: 테스트**

`tests/fixtures/catalog-grants.yaml`:

```yaml
roles:
  - name: analysts
  - name: engineers
    includes: [analysts]
  - name: admins
    includes: [engineers]
groups: []
resources: []
catalogGrants:
  - catalog: iceberg
    roles: [analysts]
    operations: [ExecuteQuery, AccessCatalog, ShowSchemas]
```

`tests/compiler-rego.test.ts`에 추가:

```typescript
test("카탈로그 레벨 오퍼레이션(ExecuteQuery 등)에 allow 규칙을 만든다", () => {
  const decl = parseDeclaration(readFileSync(new URL("./fixtures/catalog-grants.yaml", import.meta.url), "utf8"));
  const rego = compileRego(decl);
  expect(rego).toMatch(/input\.action\.operation == "ExecuteQuery"/);
  expect(rego).toMatch(/input\.action\.operation == "ShowSchemas"/);
  expect(rego).toContain('g in {"admins", "analysts", "engineers"}');
});

test("catalogGrants가 없으면 카탈로그 레벨 규칙을 만들지 않는다 (기존 선언과 하위호환)", () => {
  expect(compileRego(decl)).not.toMatch(/ExecuteQuery/);
});
```

(두 번째 테스트의 `decl`은 파일 상단의 기존 `beluga` 없는 `decl`을 재사용 — Task 11 완료
후에는 `analysts`/`engineers`로 이름이 이미 바뀌어 있을 것.)

Run: `npm test -- tests/compiler-rego.test.ts`
Expected: PASS.

- [ ] **Step 5: 실제 OPA 문법·평가 검증**

```bash
npx tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDeclaration } from './src/schema.ts';
import { compileRego } from './src/compiler/rego.ts';
const decl = parseDeclaration(readFileSync('tests/fixtures/catalog-grants.yaml','utf8'));
writeFileSync('/tmp/catalog-check.rego', compileRego(decl));
"
docker run --rm -v /tmp:/w openpolicyagent/opa:1.19.0-static check /w/catalog-check.rego
docker run --rm -v /tmp:/w openpolicyagent/opa:1.19.0-static eval \
  -d /w/catalog-check.rego \
  -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"ExecuteQuery"}}') \
  'data.trino.allow'
```

Expected: `opa check` 출력 없음(성공), `opa eval`이 `true`를 낸다.

- [ ] **Step 6: 실제 정책 원천에 카탈로그 그랜트를 추가한다**

`policies/catalog.yaml` (beluga 리포, 신규):

```yaml
catalogGrants:
  - catalog: iceberg
    roles: [analysts]
    operations: [ExecuteQuery, AccessCatalog, ShowSchemas]
```

`analysts`에 부여하면 `holdersOf`가 상속을 확장해 `engineers`·`admins`까지 실효 보유자에
포함시킨다(Task 4/6의 기존 패턴과 동일) — 세 롤 모두 별도로 선언할 필요 없다.

`bin/policyctl.ts`의 `loadPolicies`가 `catalog.yaml`도 읽도록 확장한다. **선택적 파일로
다룬다** — 없어도 기존 3파일짜리 정책 디렉터리(기존 CLI 테스트들이 만드는 임시 디렉터리
포함)가 계속 컴파일돼야 한다:

```typescript
function loadCatalogGrantsFile(dir: string): CatalogGrant[] {
  const path = join(dir, "catalog.yaml");
  if (!existsSync(path)) return [];
  const { catalogGrants } = readPolicyFile(dir, "catalog.yaml", z.strictObject({
    catalogGrants: z.array(catalogGrantSchema),
  }));
  return catalogGrants;
}
```

(`existsSync`를 `node:fs`에서 import 추가. `readPolicyFile`/`catalogGrantSchema`는 이미
`src/schema.ts`에서 가져오고 있으므로 import 목록에 추가만 한다.) `loadPolicies`의 반환문을
`declarationSchema.parse({ roles, groups, resources, catalogGrants: loadCatalogGrantsFile(dir) })`로
바꾼다.

- [ ] **Step 7: 전체 통과 확인 및 실제 정책으로 재컴파일**

```bash
npm test && npm run typecheck
mkdir -p /tmp/beluga-artifacts-task12
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/beluga-artifacts-task12
grep -c "ExecuteQuery" /tmp/beluga-artifacts-task12/trino.rego
```

Expected: 전체 테스트 PASS, grep 카운트 > 0.

- [ ] **Step 8: 커밋 (두 리포)**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
git add src/schema.ts src/compiler/rego.ts bin/policyctl.ts \
  tests/fixtures/catalog-grants.yaml tests/compiler-rego.test.ts
git commit -m "feat(compiler): 카탈로그·쿼리 레벨 오퍼레이션 — ExecuteQuery/ShowSchemas 갭 해소"

cd ~/Documents/IdeaProjects/20.dasomel/beluga
git add policies/catalog.yaml
git commit -m "feat(policies): 카탈로그 레벨 grant 추가 — ExecuteQuery/AccessCatalog/ShowSchemas"
```

- [ ] **Step 9: 임시로 켠 opa.log-requests를 되돌린다**

Step 1에서 `trino-access-control` ConfigMap에 `opa.log-requests=true`를 임시로 패치했다면,
Task 14가 그 설정을 정식으로(row-filters-uri/column-masking-uri와 함께) 다시 넣을 것이므로
여기서는 원래 상태로 되돌려 둔다:

```bash
kubectl -n beluga-data patch configmap trino-access-control --type merge -p '
{"data":{"access-control.properties":"access-control.name=opa\nopa.policy.uri=http://opa.beluga-system.svc.cluster.local:8181/v1/data/trino/allow\n"}}'
kubectl -n beluga-data rollout restart deployment/trino-coordinator
```

---

## Task 13: Trino LDAP 그룹 프로바이더 배포 (D-D)

**이 태스크는 beluga 리포에서 작업한다.** `identity.groups`를 실제로 채우는 것이 목표다 —
Task 11까지 롤 이름을 맞춰도, Trino에 그룹 프로바이더가 없으면 `identity.groups`는 항상
빈 배열이라 `g in {...}` 매칭이 절대 성립하지 않는다.

OpenLDAP에는 `memberOf` 오버레이가 없다(`gitops/charts/beluga-platform/templates/openldap.yaml`
전수 grep 확인 — `memberOf` 문자열이 파일 어디에도 없다) — 그룹은 `objectClass: groupOfNames`이고
`member:`에 멤버 전체 DN을 담는다(238~257행 근방, `cn=admins`/`cn=engineers`/`cn=analysts`,
`ou=groups,dc=beluga,dc=internal`). 그래서 **검색 모드**(`ldap.use-group-filter=true`)만
쓸 수 있고 속성 모드는 못 쓴다.

연결 정보는 이미 이 클러스터의 다른 컴포넌트가 실제로 쓰고 있는 값을 그대로 재사용한다
(`gitops/charts/beluga-platform/templates/keycloak-ldap-federation.yaml:153-161`):
`connectionUrl=ldap://openldap.iam.svc.cluster.local:389`, `bindDn=cn=admin,dc=beluga,dc=internal`,
`usersDn=ou=users,dc=beluga,dc=internal`, `usernameLDAPAttribute=uid`. TLS 자재가 없는 서비스라
(`openldap.yaml:120-121` 주석 "No TLS material is provisioned") 평문 `ldap://`를 쓴다 — PG의
LDAP 인증(`gitops/charts/beluga-data/templates/02-cnpg.yaml:30`)도 이미 같은 이유로 평문을
수용하고 있으므로 이 플랫폼의 기존 관례와 일치한다.

> **선행 위험 — 반드시 Step 2에서 실측할 것.** `openldap.yaml`이 부트스트랩 시 만드는 세 그룹
> (`admins`/`engineers`/`analysts`)은 전부 `cn=admin,dc=beluga,dc=internal` **하나만** 멤버로
> 갖는다(241/249/257행). 즉 이 태스크를 배포한 시점에 `admin`이라는 사용자가
> `ou=users,dc=beluga,dc=internal` 아래의 `uid=admin` 엔트리로 존재하고 그게 그 DN과 같다면,
> `admin`은 세 그룹 전부의 멤버가 된다 — Task 14 이전이라 아직 배포돼 있는 손수작성 정책
> (`gitops/charts/beluga-platform/files/opa/trino.rego`, `default allow = true`)의 deny 규칙은
> `is_analyst`가 참이면 PII·쓰기 작업을 막는데, `admin`이 예상 밖으로 `is_analyst`까지 참이
> 되면 `is_admin`이 있어도 개별 deny 규칙은 여전히 독립적으로 평가되어 admin이 갑자기 customers
> 테이블이나 쓰기 작업을 거부당할 수 있다. Step 4에서 이걸 실측으로 확인한다.

**Files:**
- Modify: `gitops/charts/beluga-data/templates/06-trino.yaml`

**Interfaces:**
- Consumes: 없음(순수 설정)
- Produces: Trino 코디네이터·워커의 `identity.groups`가 OpenLDAP 그룹 멤버십을 반영한다

- [ ] **Step 1: 플레이스홀더 시크릿 확인 및 크리덴셜 흐름 이해**

`ldap-admin-password`는 이미 `beluga-credentials` Secret에 존재한다
(`scripts/gitops/01-argocd-bootstrap.sh:37` `--from-literal=ldap-admin-password=...`). 새
크리덴셜을 만들 필요가 없다 — 기존 LDAP admin bind 계정(`cn=admin,dc=beluga,dc=internal`)을
그대로 재사용한다(D15: 실제 값은 절대 커밋하지 않는다 — 값은 Secret에서 런타임에 읽는다).
Helm values의 `credentials.ldapAdminPassword` 기본값은 `SET-AT-BOOTSTRAP`이며(D15 규칙 그대로),
실제 값은 부트스트랩 스크립트가 Secret에서 읽어 `--set`으로 주입한다 — 이 태스크에서 값을
새로 정의하지 않는다.

- [ ] **Step 2: 그룹 프로바이더 ConfigMap 작성 전, group-search-filter 플레이스홀더 문법 확인**

이번 리서치(`trino-auth-research.md`)는 `ldap.group-search-filter`의 정확한 자리표시자
문법(예: `{0}` vs `%s`)을 문서에서 직접 인용하지 못했다 — **아래로 넘어가기 전에**
https://trino.io/docs/current/develop/group-provider.html 을 다시 열어 `ldap.group-search-filter`
설명·예시에 나오는 자리표시자를 문자 그대로 확인한다. 아래 Step 3의 `(member={0})`는 그
확인 전까지는 초안이다 — 다르면 실측한 문법으로 바꾼다.

- [ ] **Step 3: `trino-group-provider` ConfigMap 추가**

`gitops/charts/beluga-data/templates/06-trino.yaml`의 `trino-access-control` ConfigMap
블록 뒤에 새 블록을 추가한다:

```yaml
---
# D-D: LDAP 그룹 프로바이더 — OPA 입력의 identity.groups를 채운다. OpenLDAP에 memberOf
# 오버레이가 없어(전수 확인) 검색 모드만 쓴다. 연결 정보는 keycloak-ldap-federation.yaml이
# 이미 쓰는 값과 동일 — 이 클러스터에서 실제로 동작 중인 값을 재사용한다.
apiVersion: v1
kind: ConfigMap
metadata:
  name: trino-group-provider
  namespace: analytics
data:
  group-provider.properties: |
    group-provider.name=ldap
    ldap.url=ldap://openldap.iam.svc.cluster.local:389
    ldap.allow-insecure=true
    ldap.admin-user=cn=admin,dc=beluga,dc=internal
    ldap.admin-password={{ .Values.credentials.ldapAdminPassword }}
    ldap.user-base-dn=ou=users,dc=beluga,dc=internal
    ldap.user-search-filter=(uid={0})
    ldap.use-group-filter=true
    ldap.group-base-dn=ou=groups,dc=beluga,dc=internal
    ldap.group-search-filter=(member={0})
    ldap.group-search-member-attribute=member
    ldap.group-name-attribute=cn
```

코디네이터·워커 Deployment 양쪽의 `volumeMounts`/`volumes`에 추가한다(이 파일이 이미
`access-control-volume`을 코디네이터·워커 둘 다에 마운트하는 것과 같은 패턴):

```yaml
            - name: group-provider-volume
              mountPath: /etc/trino/group-provider.properties
              subPath: group-provider.properties
```

```yaml
        - name: group-provider-volume
          configMap:
            name: trino-group-provider
```

- [ ] **Step 4: 렌더 검증**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga
helm lint gitops/charts/beluga-data
helm template gitops/charts/beluga-data -s templates/06-trino.yaml \
  --set credentials.ldapAdminPassword=x | grep -A15 "trino-group-provider"
```

Expected: `1 chart(s) linted, 0 chart(s) failed`, ConfigMap 렌더 결과에 12개 `ldap.*`/
`group-provider.name` 속성이 모두 나타난다.

- [ ] **Step 5: 라이브 적용 및 그룹 조회 실측**

```bash
export KUBECONFIG=$PWD/.kube/config
LDAP_PASS=$(kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.ldap-admin-password}' | base64 -d)
helm upgrade beluga-data gitops/charts/beluga-data --namespace storage \
  --set credentials.ldapAdminPassword="$LDAP_PASS" --reuse-values
kubectl -n analytics rollout status deployment/trino-coordinator --timeout=180s

# admin이 실제로 몇 개 그룹의 멤버가 되는지 직접 조회 (선행 위험 검증)
kubectl -n iam exec deploy/openldap -- ldapsearch -x -H ldap://localhost:389 \
  -b "ou=groups,dc=beluga,dc=internal" -D "cn=admin,dc=beluga,dc=internal" -w "$LDAP_PASS" \
  "(member=cn=admin,dc=beluga,dc=internal)" cn
```

Expected: `admin`이 몇 개 그룹에 매치되는지 그대로 기록한다. 3개 전부 매치된다면(현재
openldap.yaml의 시드 데이터가 그렇다), 이는 위 "선행 위험"이 실재한다는 뜻이며, Task 14로
넘어가기 전에 이 결함을 감수할지(admin은 어차피 `admins` 롤로도 모든 권한을 상속받으므로
Task 14 컷오버 이후에는 무해해진다) 또는 그룹 멤버십을 먼저 정리할지 판단 근거로 기록해 둔다.
이 판단은 여기서 코드로 고치지 않는다 — **관측하고 기록하는 것이 이 Step의 목적**이다.

- [ ] **Step 6: OPA 입력에 groups가 실제로 실리는지 확인**

```bash
kubectl -n iam get configmap opa-config -o jsonpath='{.data.config\.yaml}'  # decision_logs: console: true 확인
kubectl -n analytics exec deploy/trino-coordinator -- \
  trino --server http://localhost:8080 --user admin --execute "SELECT 1" || true
kubectl -n iam logs deploy/opa --since=2m | grep -A3 '"groups"'
```

Expected: OPA 콘솔 로그의 decision log에 `"groups":[...]` 배열이 빈 배열이 아니게 나타난다 —
그룹 프로바이더가 실제로 개입했다는 직접 증거.

- [ ] **Step 7: 커밋**

```bash
git add gitops/charts/beluga-data/templates/06-trino.yaml
git commit -m "feat(orch): Trino LDAP 그룹 프로바이더 배포 — identity.groups 채우기 (D-D)"
```

---

## Task 14: 생성 정책 컷오버 + OPA 행 필터·컬럼 마스킹 URI 배선

이제까지는 `gitops/charts/beluga-platform/files/opa/trino.rego`가 손수작성 상태(`default
allow = true`, deny 목록 방식)로 남아 있었다. 이 태스크가 그것을 `policyctl compile`이 만든
allow-by-role 산출물로 교체하고, Task 8 리뷰가 잡아낸 두 번째 구멍(`opa.policy.uri`만으로는
Trino가 행 필터·컬럼 마스킹을 절대 요청하지 않는다는 것)을 닫는다. **이 태스크가 실제로
`default allow := false`로 전환하는 지점이므로, Task 13과 Task 19까지 전부 끝나고 Step 5의
선행 위험 관측을 근거로 진행 여부를 판단한 뒤에만 시작한다.** Task 19가 끝나기 전에
컷오버하면 `ShowTables`/`FilterTables` 등 브라우징 오퍼레이션이 여전히 막혀 있어 Superset을
비롯한 모든 SQL 클라이언트에서 카탈로그·스키마·테이블 목록이 에러 없이 텅 빈 채로 뜬다 —
권한 문제가 아니라 데이터가 통째로 사라진 장애처럼 보인다.

`opa-policies` ConfigMap은 `.Files.Get "files/opa/trino.rego"`로 이 정적 파일을 그대로 읽어
들인다(`gitops/charts/beluga-platform/templates/opa.yaml:19-20`) — 즉 컷오버는 코드 배선이
아니라 **이 파일의 내용을 컴파일러 산출물로 교체**하는 것이다.

**이 태스크는 beluga 리포에서 작업한다(beluga-manager는 컴파일에만 쓰인다).**

**Files:**
- Modify: `gitops/charts/beluga-platform/files/opa/trino.rego` (전체 교체)
- Modify: `gitops/charts/beluga-data/templates/06-trino.yaml` (`trino-access-control` ConfigMap)

**Interfaces:**
- Consumes: beluga-manager의 `policyctl compile`(Task 2~12까지의 전체 산출물)
- Produces: OPA가 `data.trino.rowFilters`/`data.trino.columnMask`에 대한 실제 요청을 받는다

- [ ] **Step 1: 최종 컴파일**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
mkdir -p /tmp/beluga-cutover
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/beluga-cutover
docker run --rm -v /tmp/beluga-cutover:/w openpolicyagent/opa:1.19.0-static check /w/trino.rego
```

Expected: `opa check` 출력 없음(성공).

- [ ] **Step 2: 손수작성 정책을 산출물로 교체**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga
cp /tmp/beluga-cutover/trino.rego gitops/charts/beluga-platform/files/opa/trino.rego
git diff --stat gitops/charts/beluga-platform/files/opa/trino.rego
```

`is_admin`/`is_engineer`/`is_analyst`/`is_system_catalog`/`write_operations` 같은 deny
헬퍼가 전부 사라지고, `allow if { ... }` 블록들로만 이뤄진 파일로 바뀐다. 눈으로 확인:
`deny`라는 단어가 파일에 전혀 없어야 한다(§5.3-3).

```bash
grep -c '^deny\|deny if' gitops/charts/beluga-platform/files/opa/trino.rego
```

Expected: `0`.

- [ ] **Step 3: `access-control.properties`에 행 필터·컬럼 마스킹 URI 추가**

`gitops/charts/beluga-data/templates/06-trino.yaml`의 `trino-access-control` ConfigMap을
다음으로 바꾼다:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: trino-access-control
  namespace: analytics
data:
  access-control.properties: |
    access-control.name=opa
    opa.policy.uri=http://opa.iam.svc.cluster.local:8181/v1/data/trino/allow
    opa.policy.row-filters-uri=http://opa.iam.svc.cluster.local:8181/v1/data/trino/rowFilters
    opa.policy.column-masking-uri=http://opa.iam.svc.cluster.local:8181/v1/data/trino/columnMask
    opa.log-requests=true
```

URI 경로(`trino/rowFilters`, `trino/columnMask`)는 `compileRego`가 실제로 방출하는 규칙 이름
(`rowFilters contains {...}`, `columnMask := {...}`, 둘 다 `package trino` 아래)과 정확히
일치해야 한다 — 다른 이름을 쓰면 OPA가 항상 `undefined`를 반환해 필터·마스킹이 조용히
적용되지 않는 채로 "정상 동작"처럼 보인다.

- [ ] **Step 4: 렌더 검증 및 적용**

```bash
helm lint gitops/charts/beluga-platform gitops/charts/beluga-data
export KUBECONFIG=$PWD/.kube/config
helm upgrade beluga-platform gitops/charts/beluga-platform --namespace platform-system --reuse-values
helm upgrade beluga-data gitops/charts/beluga-data --namespace storage --reuse-values
kubectl -n iam rollout status deployment/opa --timeout=120s
kubectl -n analytics rollout status deployment/trino-coordinator --timeout=180s
```

Expected: `1 chart(s) linted, 0 chart(s) failed` ×2, 두 rollout 모두 성공.

- [ ] **Step 5: 실측 — 세 사용자(admin/engineer/analyst)가 실제로 의도대로 동작하는지**

```bash
for USER in admin engineer analyst; do
  echo "=== $USER ==="
  kubectl -n analytics exec deploy/trino-coordinator -- \
    trino --server http://localhost:8080 --user "$USER" \
    --execute "SELECT COUNT(*) FROM iceberg.lake.orders" 2>&1 | tail -3
done
```

Expected: 셋 다 성공(분석·엔지니어·관리자 모두 `orders`에 select 권한이 있음, `policies/resources.yaml`
확인). 하나라도 거부되면 Task 13 Step 5에서 관측한 그룹 오염이 실제 영향을 낸 것이니 여기서
멈추고 원인을 규명한다(롤백: Step 2에서 덮어쓰기 전 원본을 `git stash`/`git show HEAD:...`로
복구할 수 있다).

- [ ] **Step 6: 실측 — 행 필터·컬럼 마스킹 엔드포인트가 실제로 호출되는지**

```bash
kubectl -n analytics exec deploy/trino-coordinator -- \
  trino --server http://localhost:8080 --user engineer \
  --execute "SELECT email FROM iceberg.lake.customers LIMIT 1" || true
kubectl -n iam logs deploy/opa --since=2m | grep -E '"path":"/v1/data/trino/(rowFilters|columnMask)"'
```

Expected: 최소 `columnMask` 경로로 호출된 decision log 라인이 하나 이상 나온다 — Task 8
리뷰가 "opa.policy.uri만으로는 Trino가 이 엔드포인트들을 절대 호출하지 않는다"고 실측한
바로 그 구멍이 닫혔다는 직접 증거다. (`policies/resources.yaml`에는 아직 `columnMask` 선언이
없으므로 응답은 `undefined`/마스킹 없음이어도 무방하다 — 여기서 확인하는 건 "요청이 가는가"
이지 "마스킹이 적용되는가"가 아니다.)

- [ ] **Step 7: 커밋**

```bash
git add gitops/charts/beluga-platform/files/opa/trino.rego gitops/charts/beluga-data/templates/06-trino.yaml
git commit -m "feat(orch): 생성 정책으로 컷오버 — allow-by-role + 행 필터·컬럼 마스킹 URI 배선"
```

---

## Task 15: cert-manager 도입 + Trino 코디네이터 TLS (D-E, 1/2)

OAuth2 인증은 Trino 코디네이터 자체가 TLS로 보안돼 있을 것을 요구한다(공식 문서: "Using the
OAuth2 authentication requires the Trino coordinator to be secured with TLS" —
`trino-auth-research.md` Q2). APISIX가 외부에서 TLS를 종료해 줘도 소용없다 — 요구 조건은
코디네이터 자신이다. cert-manager는 현재 미설치이고(`VERSIONS.md`: "cert-manager | (미설치) |
— | 설치 메커니즘 부재"), `gitops/charts/beluga-platform/templates/platform-services.yaml:1-6`에
`certManager.enabled` 플래그 뒤에 네임스페이스만 만드는 스텁이 이미 있다 — 실제 오퍼레이터
설치가 빠져 있다.

이 태스크는 **인증(OAuth2)을 켜지 않는다** — TLS만 코디네이터에 얹고 검증한다. 인증 전환은
Task 16이 한다. 이렇게 나누는 이유: TLS 활성화 자체가 실패하면(키스토어 형식, 포트 충돌 등)
그 원인을 인증 설정과 뒤섞지 않고 격리해서 진단할 수 있다.

**이 태스크는 beluga 리포에서 작업한다.**

**Files:**
- Modify: `scripts/gitops/01-argocd-bootstrap.sh` (cert-manager 설치 단계 추가)
- Modify: `gitops/charts/beluga-platform/values.yaml` (`certManager.enabled` 기본값 확인/조정)
- Create: `gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml`
- Modify: `gitops/charts/beluga-data/templates/06-trino.yaml` (Certificate + HTTPS 리스너)
- Modify: `VERSIONS.md`

- [ ] **Step 1: cert-manager 버전 확인 (실측 — 여기 적힌 값을 그대로 믿지 말 것)**

이 계획 작성 시점 기준으로 cert-manager의 최신 안정 버전을 임의로 못박지 않는다. 구현 시점에
`https://github.com/cert-manager/cert-manager/releases`에서 최신 안정 태그를 확인하고,
k3s 1.36과의 호환성 노트(release notes의 "Kubernetes 지원 범위")를 함께 확인한 뒤
`VERSIONS.md`의 cert-manager 행을 실제 버전으로 채운다. `helm lint`가 통과하고 오퍼레이터
파드가 `Running`이 되는 것으로 호환성을 최종 확인한다(Step 3).

- [ ] **Step 2: 부트스트랩 스크립트에 설치 단계 추가**

`scripts/gitops/01-argocd-bootstrap.sh`의 "Installing Kubernetes Operator CRDs" 블록
근처(ArgoCD 설치 직후, Strimzi/Flink/APISIX CRD 설치와 같은 자리)에 추가한다 — 이 스크립트가
쓰는 것과 같은 패턴(`kubectl apply --server-side`, ArgoCD install.yaml 설치 방식과 동일한
공식 매니페스트 직접 적용):

```bash
log_info "Installing cert-manager <VERSION>..."
kubectl apply --server-side --force-conflicts \
  -f https://github.com/cert-manager/cert-manager/releases/download/<VERSION>/cert-manager.yaml
log_info "Waiting for cert-manager webhook to be ready..."
kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s
```

`<VERSION>`은 Step 1에서 확인한 실제 태그(예: `v1.19.x` 형식)로 채운다 — 이 문서에는 자리
표시자를 남기지 않는다.

- [ ] **Step 3: 렌더·설치 검증**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga
export KUBECONFIG=$PWD/.kube/config
bash scripts/gitops/01-argocd-bootstrap.sh   # 또는 cert-manager 설치 단계만 발췌 실행
kubectl -n cert-manager get pods
kubectl get crd | grep cert-manager.io
```

Expected: `cert-manager`/`cert-manager-cainjector`/`cert-manager-webhook` 파드 3개 모두
`Running`, `certificates.cert-manager.io`/`clusterissuers.cert-manager.io` 등 CRD가 존재.

- [ ] **Step 4: 내부용 자체서명 루트 CA ClusterIssuer**

이 클러스터는 전부 `*.local.beluga.internal`(APISIX 포트 80 통일, 외부 CA 불필요)이므로
Let's Encrypt 등 외부 ACME가 아니라 자체서명 루트로 충분하다. cert-manager 표준 패턴(부트스트랩
`SelfSigned` Issuer로 루트 CA `Certificate`를 만들고, 그 CA로 실제 서비스 인증서를 발급하는
`CA` 타입 `ClusterIssuer`)을 따른다.

`gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml`:

```yaml
{{- if .Values.certManager.enabled }}
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: beluga-internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: beluga-internal-ca
  secretName: beluga-internal-ca-secret
  duration: 8760h   # 1년 — 데모/홈랩 클러스터, 장기 회전 정책 없음
  privateKey:
    algorithm: RSA
    size: 2048
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: beluga-internal-ca-issuer
spec:
  ca:
    secretName: beluga-internal-ca-secret
{{- end }}
```

`CA` 타입 `ClusterIssuer`가 참조하는 `secretName`은 발급 네임스페이스와 무관하게 클러스터
전역에서 읽힌다는 것이 cert-manager의 문서화된 동작이다 — `beluga-internal-ca-secret`가
`cert-manager` 네임스페이스에 있어도 `analytics` 네임스페이스의 `Certificate`가 이 발급자를
참조할 수 있다. 이것도 Step 5에서 실제로 발급이 되는지로 확인한다(문서를 믿기만 하지 않는다).

- [ ] **Step 5: Trino 코디네이터용 Certificate — PKCS12 키스토어로 발급**

Trino는 Java 키스토어 기반 HTTPS 설정(`http-server.https.keystore.path`,
`http-server.https.keystore.key`)을 쓴다. cert-manager는 `Certificate.spec.keystores.pkcs12`로
PEM과 함께 PKCS12 키스토어를 같은 Secret에 넣어줄 수 있다 — 이 기능이 Step 1에서 고른
버전에 있는지 릴리스 노트로 확인한다(대부분의 근래 cert-manager 버전에 있다).

`gitops/charts/beluga-data/templates/06-trino.yaml`에 추가:

```yaml
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: trino-coordinator-tls
  namespace: analytics
spec:
  secretName: trino-coordinator-tls-secret
  dnsNames:
    - trino
    - trino.analytics.svc.cluster.local
    - {{ .Values.trino.domain | default "trino.local.beluga.internal" }}
  issuerRef:
    name: beluga-internal-ca-issuer
    kind: ClusterIssuer
  keystores:
    pkcs12:
      create: true
      passwordSecretRef:
        name: trino-keystore-password
        key: password
```

`trino-keystore-password` Secret은 새 크리덴셜이다 — D15 규칙대로 `beluga-credentials`에
`ensure_cred trino-keystore-password` 한 줄을 부트스트랩 스크립트에 추가하고, 여기서는
그 Secret을 참조만 한다(값을 여기 적지 않는다). 코디네이터 Deployment에 볼륨 마운트 추가:

```yaml
            - name: tls-volume
              mountPath: /etc/trino/tls
```
```yaml
        - name: tls-volume
          secret:
            secretName: trino-coordinator-tls-secret
```

`config.properties`(코디네이터 전용 ConfigMap, `trino-coordinator-config`)에 HTTPS 활성화
속성을 추가한다 — 기존 HTTP 리스너는 그대로 둔다(Task 16 이전까지는 인증 전환을 하지
않으므로 두 포트 모두 열어 두는 것이 안전하다):

```
http-server.https.enabled=true
http-server.https.port=8443
http-server.https.keystore.path=/etc/trino/tls/keystore.p12
http-server.https.keystore.key=${ENV:TRINO_KEYSTORE_PASSWORD}
```

키스토어 비밀번호는 파일에 평문으로 넣지 않고 환경변수 치환을 쓴다(Trino는
`config.properties`에서 `${ENV:VAR}` 치환을 지원) — 코디네이터 컨테이너 `env`에
`TRINO_KEYSTORE_PASSWORD`를 `trino-keystore-password` Secret에서 주입한다.

- [ ] **Step 6: 렌더·적용·검증**

```bash
helm lint gitops/charts/beluga-data gitops/charts/beluga-platform
export KUBECONFIG=$PWD/.kube/config
helm upgrade beluga-platform gitops/charts/beluga-platform --namespace platform-system \
  --set certManager.enabled=true --reuse-values
helm upgrade beluga-data gitops/charts/beluga-data --namespace storage --reuse-values
kubectl -n analytics wait --for=condition=Ready certificate/trino-coordinator-tls --timeout=120s
kubectl -n analytics rollout status deployment/trino-coordinator --timeout=180s
kubectl -n analytics exec deploy/trino-coordinator -- \
  curl -sk https://localhost:8443/v1/info
```

Expected: `certificate/trino-coordinator-tls condition met`, `curl -sk https://.../v1/info`가
Trino 노드 정보 JSON을 반환한다(TLS 핸드셰이크가 실제로 성공했다는 직접 증거 — `-k`는
자체서명 루트를 클라이언트가 신뢰하지 않기 때문이며 서버 쪽 TLS 동작 자체를 확인하는 데는
문제없다).

- [ ] **Step 7: VERSIONS.md 갱신 및 커밋**

`VERSIONS.md`의 `cert-manager | (미설치) | — | 설치 메커니즘 부재...` 행을 Step 1에서 확인한
실제 버전으로 바꾼다.

```bash
git add scripts/gitops/01-argocd-bootstrap.sh gitops/charts/beluga-platform/values.yaml \
  gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml \
  gitops/charts/beluga-data/templates/06-trino.yaml VERSIONS.md
git commit -m "feat(cluster): cert-manager 도입 + Trino 코디네이터 TLS (D-E 1/2)"
```

---

## Task 16: Trino OAuth2 인증 — Keycloak 연동 (D-E, 2/2)

Task 15가 깐 TLS 위에 OAuth2 인증을 켠다. 이걸 켜는 순간이 바로 D-E가 말하는 "인증 구멍"(누구나
`X-Trino-User`를 자칭해 아무 신원으로나 쿼리를 날릴 수 있는 상태)이 실제로 닫히는 지점이다 —
`http-server.authentication.type`이 설정되면 Trino가 인증되지 않은 요청을 거부하기 시작한다.

Keycloak에 `trino` 클라이언트가 이미 존재한다(`gitops/charts/beluga-platform/templates/keycloak.yaml:205-222`,
`clientId: trino`, confidential, `secret: {{ .Values.credentials.clientSecrets.trino }}` — 이미
`beluga-credentials`의 `client-secret-trino`로 채워져 있다, 새 크리덴셜 불필요). 다만
`redirectUris`가 현재 `http://trino.{{ .Values.baseDomain }}/*`로 HTTP 전용이다 — 이 태스크가
고친다.

**principal-field 선택이 Task 13(LDAP 그룹 프로바이더)과 직접 맞물린다**: OAuth2 토큰의 기본
principal 필드는 `sub`(불투명 UUID)인데, 그룹 프로바이더는 `identity.user`를 그대로
`ldap.user-search-filter=(uid={0})`에 넣어 OpenLDAP에서 찾는다 — UUID로는 아무 것도 못 찾는다.
그래서 `http-server.authentication.oauth2.principal-field=preferred_username`으로 설정해
Keycloak 사용자명(OpenLDAP `uid`와 같은 값, `keycloak-ldap-federation.yaml:158`
`usernameLDAPAttribute: uid` 때문에 이미 동기화돼 있다)을 `identity.user`로 쓰게 한다.

**이 태스크는 beluga 리포에서 작업한다.**

**Files:**
- Modify: `gitops/charts/beluga-platform/templates/keycloak.yaml` (`trino` 클라이언트 redirectUris)
- Modify: `gitops/charts/beluga-data/templates/06-trino.yaml` (`config.properties`에 OAuth2 속성)

- [ ] **Step 1: Keycloak 클라이언트 redirectUris를 HTTPS로 확장**

`gitops/charts/beluga-platform/templates/keycloak.yaml:213`의 `trino` 클라이언트
`redirectUris`를 다음으로 바꾼다(기존 HTTP 경로는 당장 제거하지 않는다 — APISIX 경유
접근이 아직 HTTP뿐이므로 그 경로가 죽지 않게 하되, 코디네이터 직접 HTTPS 경로를 추가한다):

```json
"redirectUris": [
  "http://trino.{{ .Values.baseDomain }}/*",
  "https://trino.{{ .Values.baseDomain }}/*",
  "https://trino.analytics.svc.cluster.local:8443/*"
]
```

- [ ] **Step 2: `config.properties`에 OAuth2 속성 추가**

`gitops/charts/beluga-data/templates/06-trino.yaml`의 `trino-coordinator-config` ConfigMap에
추가(Task 15가 이미 넣은 `http-server.https.*` 속성들 뒤):

```
http-server.authentication.type=oauth2
http-server.authentication.oauth2.issuer=http://keycloak.iam.svc.cluster.local:8080/realms/beluga
http-server.authentication.oauth2.client-id=trino
http-server.authentication.oauth2.client-secret={{ .Values.credentials.clientSecrets.trino }}
http-server.authentication.oauth2.principal-field=preferred_username
```

> **실측 필요**: `oauth2.issuer`가 코디네이터 파드 안에서 실제로 discovery 엔드포인트
> (`/.well-known/openid-configuration`)에 도달 가능한지, 그리고 Keycloak이 발급하는 토큰의
> `iss` 클레임과 정확히 일치하는지 확인한다 — 이 두 값이 문자 그대로 다르면(예: 포트 표기,
> trailing slash) OAuth2 검증이 조용히 실패한다. `curl`로 직접 대조하는 Step 4에서 검증한다.

- [ ] **Step 3: 렌더·적용**

```bash
helm lint gitops/charts/beluga-platform gitops/charts/beluga-data
export KUBECONFIG=$PWD/.kube/config
KC_SECRET=$(kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.client-secret-trino}' | base64 -d)
helm upgrade beluga-platform gitops/charts/beluga-platform --namespace platform-system \
  --set credentials.clientSecrets.trino="$KC_SECRET" --reuse-values
helm upgrade beluga-data gitops/charts/beluga-data --namespace storage \
  --set credentials.clientSecrets.trino="$KC_SECRET" --reuse-values
kubectl -n analytics rollout status deployment/trino-coordinator --timeout=180s
```

- [ ] **Step 4: 실측 — issuer 일치 및 인증 구멍이 실제로 닫혔는지**

```bash
# 1) issuer discovery 대조
kubectl -n analytics exec deploy/trino-coordinator -- \
  curl -s http://keycloak.iam.svc.cluster.local:8080/realms/beluga/.well-known/openid-configuration \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['issuer'])"

# 2) 인증 없이 X-Trino-User만으로 자칭 시도 — 이제는 거부돼야 한다
kubectl -n analytics exec deploy/trino-coordinator -- \
  curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost:8443/v1/statement \
  -H "X-Trino-User: admin" -d "SELECT 1"

# 3) 정상 OAuth2 토큰으로는 성공 — Keycloak 토큰 엔드포인트에서 직접 발급받아 확인
KC_PASS=$(kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.user-password-admin}' | base64 -d 2>/dev/null || echo "")
TOKEN=$(kubectl -n analytics exec deploy/trino-coordinator -- \
  curl -s -d client_id=trino -d "client_secret=$KC_SECRET" -d grant_type=password \
  -d username=admin -d "password=$KC_PASS" \
  http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))")
kubectl -n analytics exec deploy/trino-coordinator -- \
  curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost:8443/v1/statement \
  -H "Authorization: Bearer $TOKEN" -d "SELECT 1"
```

Expected: (1) issuer 문자열이 `config.properties`의 `oauth2.issuer`와 정확히 같다. (2)
`X-Trino-User`만으로는 `401`(또는 302 로그인 리다이렉트) — **이게 D-E가 닫으려던 구멍이
실제로 닫혔다는 직접 증거**다. (3) 유효한 OAuth2 토큰으로는 `200`.

하나라도 기대와 다르면(특히 (2)가 여전히 200을 반환하면 구멍이 안 닫힌 것) 여기서 멈추고
원인을 규명한다 — `http-server.https.enabled`/`authentication.type` 조합이 실제로 무인증
경로를 막는지는 이번 리서치에서 "일반 인증기 프레임워크"로만 확인됐고 oauth2 특정 동작으로
직접 인용되지 않았다(`trino-auth-research.md` Q2 마지막 문단) — 이 Step이 그 마지막 빈틈을
직접 메운다.

- [ ] **Step 5: 커밋**

```bash
git add gitops/charts/beluga-platform/templates/keycloak.yaml gitops/charts/beluga-data/templates/06-trino.yaml
git commit -m "feat(orch): Trino OAuth2 인증 활성화 — X-Trino-User 자칭 구멍 폐쇄 (D-E 2/2)"
```

---

## Task 17: Superset 롤 매핑 키를 복수형으로 정렬 (D-G)

Task 9의 group-ldap-mapper가 동기화를 시작하면 Keycloak에 **복수형** 그룹
(`admins`/`engineers`/`analysts`)이 들어온다. Superset의 `AUTH_ROLES_MAPPING`은 **단수형**
키(`admin`/`engineer`/`analyst`)를 쓰므로 어느 그룹과도 매칭되지 않고, 모든 사용자가
`AUTH_USER_REGISTRATION_ROLE`인 `Gamma`로 강등된다. 지금은 Keycloak에 그룹 자체가 없어
증상이 드러나지 않을 뿐이다.

D-G: **LDAP이 이름의 단일 원천**이므로 Superset 쪽을 복수형에 맞춘다. D-F로 선언 롤명도
이미 복수형으로 정렬했으니 이로써 플랫폼 전체가 복수형으로 일관된다.

**이 태스크는 Task 9와 함께 배포돼야 한다** — 매퍼가 동기화를 시작하기 전에 Superset 키가
맞아 있어야 강등 구간이 생기지 않는다.

**Files:**
- Modify: `gitops/charts/beluga-data/templates/08-superset.yaml` (AUTH_ROLES_MAPPING)

**Interfaces:**
- Consumes: Keycloak `groups` 클레임 — Task 9의 매퍼가 LDAP에서 동기화한 그룹 이름
- Produces: Superset 롤 동기화가 LDAP 그룹명과 직접 대응한다

- [ ] **Step 1: 현재 매핑 확인**

```bash
sed -n '17,21p' gitops/charts/beluga-data/templates/08-superset.yaml
```

Expected: 단수형 키 3개(`"admin"`, `"engineer"`, `"analyst"`).

- [ ] **Step 2: LDAP 실제 그룹명 재확인 (추측 금지)**

```bash
grep -n "^              cn: " gitops/charts/beluga-platform/templates/openldap.yaml
```

Expected: `admins` / `engineers` / `analysts`. 다르면 이 태스크를 멈추고 보고할 것 —
매핑 키는 LDAP 실제 값을 따라야 하며 이 문서의 값을 따르는 게 아니다.

- [ ] **Step 3: 매핑 키를 복수형으로 변경**

`gitops/charts/beluga-data/templates/08-superset.yaml`의 `AUTH_ROLES_MAPPING`을 이렇게 바꾼다.
Superset 쪽 롤 이름(`Admin`/`Alpha`/`Gamma`)은 그대로 두고 **키만** 바꾼다:

```python
    # 키는 Keycloak groups 클레임의 값 = LDAP 그룹 cn (복수형, D-G).
    # LDAP이 이름의 단일 원천이다 — 여기서 단수형으로 쓰면 어느 그룹과도 매칭되지 않아
    # 전원이 AUTH_USER_REGISTRATION_ROLE(Gamma)로 강등된다.
    AUTH_ROLES_MAPPING = {
        "admins": ["Admin"],
        "engineers": ["Alpha"],
        "analysts": ["Gamma"]
    }
```

- [ ] **Step 4: 렌더 검증**

```bash
helm template beluga-data gitops/charts/beluga-data \
  | yq 'select(.metadata.name == "superset-config")' \
  | grep -A5 AUTH_ROLES_MAPPING
```

Expected: 복수형 키 3개가 렌더된 ConfigMap에 나타난다.

생성되는 Python 설정이 문법적으로 유효한지도 확인한다:

```bash
helm template beluga-data gitops/charts/beluga-data \
  | yq -r 'select(.metadata.name == "superset-config") | .data["superset_config.py"]' \
  | python3 -c "import sys; compile(sys.stdin.read(), 'superset_config.py', 'exec'); print('PY OK')"
```

Expected: `PY OK`

- [ ] **Step 5: 라이브 검증 (클러스터가 있을 때만)**

클러스터가 없으면 이 단계를 **수행했다고 적지 말고 못 했다고 보고한다**.

```bash
kubectl -n analytics rollout restart deploy/superset
kubectl -n analytics rollout status deploy/superset --timeout=300s
```

Keycloak 그룹에 속한 사용자로 로그인한 뒤 부여된 롤을 확인한다:

```bash
kubectl -n analytics exec deploy/superset -- \
  superset fab list-users | head -20
```

Expected: 해당 사용자의 롤이 `Gamma`(기본값)가 아니라 그룹에 대응하는 롤이다.

- [ ] **Step 6: 커밋**

```bash
git add gitops/charts/beluga-data/templates/08-superset.yaml
git commit -m "fix(analytics): Superset 롤 매핑 키를 LDAP 그룹명(복수형)에 맞춤 (D-G)"
```

---

## Task 18: 배포 산출물 롤 이름 마이그레이션 — Keycloak realm 롤·PostgreSQL D19 특권 롤을 analysts/engineers/admins로 (D-I)

Task 11이 선언·컴파일러 산출물의 롤 이름을 `beluga-analyst`/`beluga-engineer`/`beluga-admin`에서
`analysts`/`engineers`/`admins`로 바꿨다(OpenLDAP 그룹 `cn` 값과 맞춤, D-F). 하지만 Task 11의
스코프는 `policies/*.yaml`과 beluga-manager의 컴파일러·테스트뿐이었다 — **배포된 차트는 여전히
옛 이름을 정의한다**:

- `gitops/charts/beluga-platform/templates/keycloak.yaml:19,23-24,28,33-34,38` — realm 롤
  `"beluga-analyst"`/`"beluga-engineer"`/`"beluga-admin"`(컴포지트 포함), `:48,54,60` — 네이티브
  그룹(`admin`/`engineer`/`analyst`)의 `realmRoles`도 옛 이름을 가리킨다.
- `gitops/charts/beluga-data/files/db-roles.sql:8,11,14` — D19 특권 롤이 `beluga_analyst`/
  `beluga_engineer`/`beluga_admin`(언더스코어, `NOLOGIN INHERIT`)로 생성된다.

이 결함의 실제 증상: Task 10 드리프트 비교기가 선언 쪽 이름(`analysts` 등)과 배포 쪽 이름
(`beluga-analyst` 등)을 대조하면 이름 자체가 겹치지 않아 **모든 롤이 전량 불일치**로 보고된다
— "적용이 하나도 안 됐다"처럼 보이지만 실제로는 이름만 어긋난 것이다. (드리프트 비교기의
실제 상태 조회 어댑터는 아직 구현되지 않았다 — `readState`/`apply`는 계획 2 스코프다. 그래서
이 결함이 실제로 해소됐음을 `policyctl` 드리프트 명령으로 직접 시연할 수는 없다. 이름이
맞으면 어댑터가 붙는 순간 자동으로 해소된다는 사실만 여기 기록해 둔다.)

**전수 조사(아래 grep 실측, `beluga-wt-sdd-manager` 워크트리 기준)**: 옛 이름 문자열은 이 두
파일 외에 `keycloak-users.yaml`, `02-cnpg.yaml`(pg_hba), `03-strimzi-kafka.yaml`(KafkaUser CR),
`scripts/credentials.sh`, `tests/06-authz-defaults.sh`에도 나타난다. Step 1에서 이들을 전수
분류한다 — 전부가 이 태스크의 변경 대상은 아니다.

### 핵심 함정 — 이건 단순 리네임이 아니다

PostgreSQL에는 이름이 비슷한 서로 다른 두 종류의 롤이 있다(실측):

- `beluga_analyst`/`beluga_engineer`/`beluga_admin`(언더스코어, `NOLOGIN INHERIT`) — D19
  **특권 롤**. `pgddl.ts`가 방출하는 대상이며, 이 태스크가 이름을 바꾸는 대상이다.
- `"beluga-analyst"`/`"beluga-engineer"`/`"beluga-admin"`(하이픈, **quoted**, `LOGIN`) — D20
  **LDAP 로그인 계정**. `pg_hba`가 ldap 검색모드로 인증하는 사용자명이다(`db-roles.sql:46-57`).
  선언의 롤이 아니라 로그인 사용자명이다.

그리고 **`beluga_admin`은 이 둘 중 어디에도 깔끔히 속하지 않는다.** `db-roles.sql:13-14`는 이걸
`NOLOGIN INHERIT`로 선언하려 시도하지만, `02-cnpg.yaml:14`가 이미 CNPG 부트스트랩 `owner`로
`beluga_admin`을 지정해 CNPG가 먼저 **비밀번호 있는 LOGIN 롤**(시크릿 `postgres-admin-credential`)로
만들어 버린다(`beluga_meta`/`lakekeeper`/`keycloak`/`openmetadata` 4개 DB 소유, `:20-23`) — 그래서
`db-roles.sql`의 `CREATE ROLE ... NOLOGIN`은 `IF NOT EXISTS`에 걸려 **항상 스킵된다**. `beluga_admin`은
D19 특권 롤로 실제로 존재해 본 적이 없다 — Airflow/Superset/OpenMetadata/Lakekeeper/shop-seed가
전부 이 이름으로 접속하는 서비스 로그인 계정일 뿐이다(`07-airflow.yaml`, `08-superset.yaml`,
`11-openmetadata.yaml`, `04-lakekeeper.yaml`, `02b-shop-seed.yaml`, `03-strimzi-kafka.yaml:195`
— 전부 `database.user`/연결 문자열로 `beluga_admin` 실측). `beluga_admin`을 리네임하면 이 다섯
연결 문자열과 `02-cnpg.yaml`의 CNPG owner 선언이 전부 깨진다.

### D-I(프로젝트 오너 결정): 특권 롤과 로그인 계정을 분리한다

**리네임하지 않는다 — 분리한다.** 선언이 관리하는 D19 특권 롤을 `analysts`/`engineers`/
`admins`(신규 생성, `NOLOGIN INHERIT`)로 만들고, `beluga_admin`은 CNPG owner이자 서비스 로그인
계정으로 그대로 둔 채 `GRANT admins TO beluga_admin`으로 잇는다. 이렇게 하면 다섯 서비스의
연결 문자열도, CNPG owner 선언도 건드리지 않는다. 이 방향은 나중 계획("개인별 PG 롤 전환")이
이미 향하고 있는 모양과도 맞는다.

**D20 LDAP 로그인 계정(`"beluga-analyst"` 등)도 이름을 바꾸지 않는다** — 이건 선언의 롤이
아니라 `pg_hba`의 ldap 검색모드가 매칭하는 로그인 사용자명(uid)이다. 이름을 바꾸면
`02-cnpg.yaml`의 `pg_hba` 사용자 목록(`"beluga-admin","beluga-engineer","beluga-analyst"`)과
어긋난다. 대신 이들이 물려받는 **특권 롤**만 새 이름으로 바꾼다(`GRANT analysts TO
"beluga-analyst"` 등). 같은 논리로 `keycloak-users.yaml`의 네이티브 Keycloak 사용자명
(`beluga-admin` 등)과 `03-strimzi-kafka.yaml`의 KafkaUser CR 이름(`beluga-admin` 등)도
로그인/서비스 아이덴티티이지 선언 롤이 아니므로 **이름을 바꾸지 않는다** — Step 1에서 이
분류를 실측으로 확정한다.

**이 태스크는 두 번째 함정을 하나 더 갖는다.** Keycloak은 `--import-realm`으로 기동 시
`/opt/keycloak/data/import`의 realm JSON을 읽지만(`keycloak.yaml:308-311` 마운트 경로), **realm이
이미 DB에 존재하면 재임포트를 건너뛴다.** 즉 `keycloak-realm` ConfigMap의 롤 이름을 고쳐도,
이미 부트스트랩된 클러스터에서는 Keycloak Deployment를 재시작하는 것만으로는 실제 realm의 롤이
바뀌지 않는다 — Admin REST API로 직접 마이그레이션해야 한다. `keycloak-users.yaml`이 이미 같은
이유로(사용자 생성은 realm import 범위 밖) Admin REST API Job 패턴을 쓰고 있으므로 이 태스크도
같은 패턴의 별도 Job을 추가한다(Step 6).

**Files:**
- Modify: `gitops/charts/beluga-platform/templates/keycloak.yaml`
- Add: `gitops/charts/beluga-platform/templates/keycloak-role-migration.yaml`
- Modify: `gitops/charts/beluga-data/files/db-roles.sql`
- Modify: `tests/06-authz-defaults.sh`

**Interfaces:**
- Consumes: 없음(배포 산출물을 Task 11의 선언·컴파일러 산출물 이름에 맞추는 독립 작업)
- Produces: 배포된 Keycloak realm 롤과 PostgreSQL D19 특권 롤 이름이 `analysts`/`engineers`/
  `admins`로 선언·컴파일러 산출물과 일치한다. `beluga_admin`(PG 서비스 계정)과
  `"beluga-analyst"`류(PG LDAP 로그인 계정), `beluga-analyst`류(Keycloak 네이티브 사용자·
  KafkaUser CR)는 그대로 남는다.

- [ ] **Step 1: 옛 이름 전수 조사 및 분류 (추측 금지 — grep 실측)**

```bash
grep -rln "beluga_analyst\|beluga_engineer\|beluga_admin\|beluga-analyst\|beluga-engineer\|beluga-admin" \
  --include="*.yaml" --include="*.sql" --include="*.sh" . \
  | grep -v node_modules | grep -v docs/superpowers/plans/2026-08-12-manager-policy-compiler.md
```

Expected(실측): 아래 13개 파일.

| 파일 | 참조 종류 | 이 태스크의 조치 |
|---|---|---|
| `gitops/charts/beluga-platform/templates/keycloak.yaml` | Keycloak realm 롤(선언 롤과 대응) | **변경** — Step 2 |
| `gitops/charts/beluga-data/files/db-roles.sql` | D19 특권 롤(`beluga_analyst` 등) + D20 로그인 계정 | **변경**(특권 롤만) — Step 4 |
| `tests/06-authz-defaults.sh` | D19 특권 롤(`beluga_analyst`) | **변경** — Step 8 |
| `gitops/charts/beluga-platform/templates/keycloak-users.yaml` | 네이티브 Keycloak 사용자명(`beluga-admin` 등) — 그룹 필드는 `admin`/`engineer`/`analyst`(변경 없음) | 변경 없음 — 로그인 아이덴티티 |
| `gitops/charts/beluga-data/templates/02-cnpg.yaml` | pg_hba D20 로그인 계정 목록 + `beluga_admin` owner | 변경 없음 — 로그인 아이덴티티 |
| `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml` | KafkaUser CR 이름(`beluga-admin` 등) + `beluga_admin`(Debezium DB user) | 변경 없음 — 로그인 아이덴티티 |
| `scripts/credentials.sh` | 안내 문구의 로그인 계정명 | 변경 없음 — 로그인 아이덴티티 |
| `gitops/charts/beluga-data/templates/02c-db-roles.yaml` | `beluga_admin`으로 psql 접속(Job 실행 계정) | 변경 없음 |
| `gitops/charts/beluga-data/templates/07-airflow.yaml`, `08-superset.yaml`, `11-openmetadata.yaml`, `04-lakekeeper.yaml`, `02b-shop-seed.yaml` | `beluga_admin` DB 연결 문자열 | 변경 없음 — 서비스 계정 |
| `scripts/gitops/01-argocd-bootstrap.sh` | `beluga_admin` 관련 시크릿/문구 | 변경 없음 |

`docs/*.md`(`SESSION-HANDOFF.md`, `docs/access-guide.md`, `docs/mistakes-log.md`,
`docs/superpowers/specs/*.md`)에도 옛 이름이 등장하지만 이 태스크는 코드·배포 매니페스트만
다룬다 — 문서 갱신은 스코프 밖으로 남긴다.

- [ ] **Step 2: Keycloak realm ConfigMap 롤 이름 변경**

`gitops/charts/beluga-platform/templates/keycloak.yaml`의 `roles.realm`과 `groups[].realmRoles`를
교체한다:

```json
      "roles": {
        "realm": [
          {
            "name": "analysts",
            "description": "Beluga Analyst base role"
          },
          {
            "name": "engineers",
            "description": "Beluga Engineer role (includes analysts)",
            "composite": true,
            "composites": {
              "realm": [
                "analysts"
              ]
            }
          },
          {
            "name": "admins",
            "description": "Beluga Admin role (includes engineers)",
            "composite": true,
            "composites": {
              "realm": [
                "engineers"
              ]
            }
          }
        ]
      },
      "groups": [
        {
          "name": "admin",
          "realmRoles": [
            "admins"
          ]
        },
        {
          "name": "engineer",
          "realmRoles": [
            "engineers"
          ]
        },
        {
          "name": "analyst",
          "realmRoles": [
            "analysts"
          ]
        }
      ],
```

그룹 이름(`admin`/`engineer`/`analyst`, 네이티브 Keycloak 그룹, singular)은 건드리지 않는다 —
Step 1에서 확정했듯 이건 로그인 아이덴티티 쪽이다. `realmRoles` 값만 바뀐다.

- [ ] **Step 3: 렌더 검증**

```bash
helm template beluga-platform gitops/charts/beluga-platform \
  | yq 'select(.metadata.name == "keycloak-realm") | .data["beluga-realm.json"]' -r \
  | python3 -c "import sys,json; d=json.load(sys.stdin); names=[r['name'] for r in d['roles']['realm']]; print(sorted(names))"
```

Expected: `['admins', 'analysts', 'engineers']`

```bash
helm template beluga-platform gitops/charts/beluga-platform \
  | grep -c "beluga-analyst\|beluga-engineer\|beluga-admin" || true
```

Expected: `keycloak-role-migration.yaml`(Step 6에서 추가, 옛 이름을 마이그레이션 대상으로
참조하는 게 정상이다)과 `keycloak-users.yaml`/`02-cnpg.yaml`/`03-strimzi-kafka.yaml`/
`credentials.sh`(로그인 아이덴티티, Step 1에서 변경 없음으로 분류)를 제외하면 매치가 없어야
한다 — 즉 `keycloak-realm` ConfigMap과 `db-roles-schema` ConfigMap 안에는 옛 이름이 전혀 없어야
한다:

```bash
helm template beluga-platform gitops/charts/beluga-platform \
  | yq 'select(.metadata.name == "keycloak-realm")' \
  | grep "beluga-analyst\|beluga-engineer\|beluga-admin"
echo "exit=$?"
```

Expected: `exit=1`(매치 없음).

- [ ] **Step 4: `db-roles.sql` 재작성 — D19 특권 롤 분리 + 마이그레이션**

`gitops/charts/beluga-data/files/db-roles.sql` 전체를 아래로 교체한다. 구조 1~3은 `pgddl.ts`가
`policies/roles.yaml`(engineers includes [analysts], admins includes [engineers])로부터
방출하는 것과 동일한 모양이다(`toPgRole`은 하이픈 없는 이름을 그대로 통과시킨다 —
`src/pgrole.ts` 실측). 2b·6은 이 배포 산출물에만 있는, 컴파일러가 모르는 D-I 접합·마이그레이션
로직이다.

```sql
-- PostgreSQL D19 Composite Role Hierarchy & D20 LDAP User Roles
-- Spec: docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md §10.1 & §10.2
-- Task 18(D-I): D19 특권 롤 이름을 컴파일러 산출물(policies/roles.yaml, Task 11)과 맞춰
-- analysts/engineers/admins로 바꾼다. beluga_admin은 리네임 대상이 아니다 — CNPG bootstrap
-- owner이자 Airflow/Superset/OpenMetadata/Lakekeeper/shop-seed가 실제로 접속에 쓰는 서비스
-- 로그인 계정이라(다섯 연결 문자열 + 02-cnpg.yaml의 owner 선언이 전부 이 이름을 참조) 바꾸면
-- 배포가 깨진다. 그래서 리네임이 아니라 분리다: 새 특권 롤(analysts/engineers/admins)을 만들고
-- `GRANT admins TO beluga_admin`으로 잇는다. D20 LDAP 로그인 계정("beluga-analyst" 등, 하이픈+
-- quoted)도 이름을 바꾸지 않는다 — 이들은 선언 롤이 아니라 pg_hba ldap 검색모드가 매칭하는
-- 로그인 사용자명(uid)이므로, 이들이 물려받는 특권 롤만 새 이름으로 바꾼다.
-- 이 스크립트는 ArgoCD가 매 sync마다 재실행한다(02c-db-roles.yaml, hook: Sync) — 전부 멱등이며,
-- 6번 섹션은 이전 버전이 만든 구 D19 롤(beluga_analyst/beluga_engineer)이 남아있는 클러스터의
-- 마이그레이션까지 처리한다.

-- 1. Base Privilege Roles (NOLOGIN, INHERIT) — Task 18: analysts/engineers/admins로 개명
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analysts') THEN
    CREATE ROLE analysts WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'engineers') THEN
    CREATE ROLE engineers WITH NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admins') THEN
    CREATE ROLE admins WITH NOLOGIN INHERIT;
  END IF;
END $$;

-- 2. D19 Composite Role Inheritance (admins ⊃ engineers ⊃ analysts)
GRANT analysts TO engineers;
GRANT engineers TO admins;

-- 2b. Task 18(D-I): admins를 서비스 로그인 계정 beluga_admin에 연결한다. 이 Job은 beluga_admin으로
-- 접속해 실행되고(02c-db-roles.yaml), beluga_admin은 CNPG bootstrap이 부여한 CREATEROLE을 갖는다
-- (02-cnpg.yaml: "ALTER ROLE beluga_admin WITH REPLICATION CREATEROLE"). PG16+에서는 CREATEROLE
-- 롤이 만든 롤에 자동으로 ADMIN OPTION이 실린다(이 클러스터는 PG 17.6) — 그래서 바로 위에서
-- beluga_admin이 직접 CREATE한 admins 롤에 대해 별도 부여 없이 이 GRANT가 그대로 성공한다.
-- (예전에는 beluga_admin 자체를 D19 특권 롤로 쓰려 했으나 CNPG(superuser)가 먼저 만들어서 이
-- Job에 ADMIN OPTION이 없었다 — 그래서 구버전 스크립트는 대신 로그인 계정 "beluga-admin"에
-- beluga_engineer를 부여하는 우회를 썼다. admins가 beluga_admin과 별개인 새 롤이므로 이 우회는
-- 더 이상 필요 없다.) 이 GRANT가 실패하면 Job이 ON_ERROR_STOP=1로 죽는다 — Step 9에서 Job
-- 상태로 직접 확인한다.
GRANT admins TO beluga_admin;

-- 3. Schema & Table Privileges on shop DB — Task 18: 대상 롤을 analysts/engineers/admins로 교체
GRANT CONNECT ON DATABASE shop TO analysts, engineers, admins;
GRANT USAGE ON SCHEMA public TO analysts, engineers, admins;

-- analyst: Read-only access to all tables except PII ('customers')
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysts;
REVOKE SELECT ON TABLE customers FROM analysts;

-- engineer: analyst privileges + Read/Write on all tables (including explicit customers access) + sequences
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO engineers;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO engineers;

-- admin: Full privileges. beluga_admin은 2b의 admins 멤버십(INHERIT)으로 이 전부를 물려받는다.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admins;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admins;
GRANT ALL PRIVILEGES ON DATABASE shop TO admins;

-- Default Privileges for future tables in public schema
-- analyst에 대한 ALTER DEFAULT PRIVILEGES는 두지 않는다.
-- 신규 테이블에 SELECT를 자동 부여하면 §10.1 "기본은 거부, 허용만 롤로 부여"를 위반한다
-- (신규 CDC 미러·customers_v2가 생기는 즉시 analyst가 읽게 됨). 테이블 허용은 명시적 GRANT로만.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engineers;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO admins;

-- 4. D20 LDAP Login Accounts (LOGIN, no password stored - authenticated via pg_hba ldap)
-- Task 18(D-I): 이름 유지 — 선언 롤이 아니라 pg_hba ldap 검색모드가 매칭하는 로그인 사용자명
-- (uid)이다. 바꾸면 02-cnpg.yaml pg_hba 라인의 사용자 목록과 어긋난다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-analyst') THEN
    CREATE ROLE "beluga-analyst" WITH LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-engineer') THEN
    CREATE ROLE "beluga-engineer" WITH LOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga-admin') THEN
    CREATE ROLE "beluga-admin" WITH LOGIN INHERIT;
  END IF;
END $$;

-- 5. Bind LDAP Login Accounts to the NEW privilege roles (Task 18)
GRANT analysts TO "beluga-analyst";
GRANT engineers TO "beluga-engineer";
GRANT admins TO "beluga-admin";

-- 6. Task 18 마이그레이션: 구버전이 만든 D19 특권 롤(beluga_analyst/beluga_engineer)을 정리한다.
-- 멱등 — 이미 정리된 클러스터에서는 IF EXISTS가 전부 거짓이라 아무 것도 하지 않는다.
-- beluga_admin은 정리 대상이 아니다: D19 특권 롤로 실제로 존재해 본 적이 없다(구스크립트의
-- `CREATE ROLE beluga_admin` 시도는 CNPG owner 선점으로 IF NOT EXISTS에 걸려 항상 스킵됐다).
-- beluga_admin에 남아있는 기존 직접 GRANT(3번 구버전이 TO beluga_admin으로 준 것들)는 일부러
-- 건드리지 않는다 — REVOKE ALL ON DATABASE/REVOKE CONNECT를 서비스 계정에 잘못 실행하면 실행
-- 중인 Airflow/Superset/OpenMetadata/Lakekeeper 연결을 그 자리에서 끊을 위험이 있고, 2b의
-- admins 멤버십과 중복돼도 해가 없다(같은 권한을 두 경로로 받을 뿐) — 안전보다 정리를
-- 앞세우지 않는다.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_engineer') THEN
    -- 구 default privileges 항목을 먼저 지운다 — 남아있으면 DROP ROLE이 dependency 에러로 실패한다.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM beluga_engineer;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM beluga_engineer;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM beluga_engineer;
    REVOKE CONNECT ON DATABASE shop FROM beluga_engineer;
    REVOKE USAGE ON SCHEMA public FROM beluga_engineer;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_analyst') THEN
      REVOKE beluga_analyst FROM beluga_engineer;
    END IF;
    REVOKE beluga_engineer FROM "beluga-engineer";
    REVOKE beluga_engineer FROM "beluga-admin";
    DROP ROLE beluga_engineer;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'beluga_analyst') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM beluga_analyst;
    REVOKE CONNECT ON DATABASE shop FROM beluga_analyst;
    REVOKE USAGE ON SCHEMA public FROM beluga_analyst;
    REVOKE beluga_analyst FROM "beluga-analyst";
    DROP ROLE beluga_analyst;
  END IF;
END $$;
```

- [ ] **Step 5: `db-roles.sql` 렌더 검증**

```bash
helm template beluga-data gitops/charts/beluga-data \
  | yq 'select(.metadata.name == "db-roles-schema") | .data["db-roles.sql"]' -r \
  | grep -c "^CREATE ROLE analysts\|^CREATE ROLE engineers\|^CREATE ROLE admins" 2>/dev/null; \
  helm template beluga-data gitops/charts/beluga-data \
  | yq 'select(.metadata.name == "db-roles-schema") | .data["db-roles.sql"]' -r \
  | grep -c "CREATE ROLE analysts\|CREATE ROLE engineers\|CREATE ROLE admins"
```

Expected: `3`(analysts/engineers/admins 각각 한 번씩 `CREATE ROLE`). 로컬에 라이브 PG가 없어
`psql --dry-run` 같은 구문 검증 수단은 없다 — 실제 구문 유효성은 Step 9(라이브)에서 Job이
`ON_ERROR_STOP=1`로 실행되어 실패 없이 끝나는 것으로 확인한다.

- [ ] **Step 6: Keycloak 롤 마이그레이션 Job 신설**

`--import-realm`은 realm이 이미 존재하면 재임포트를 건너뛴다(Keycloak 문서 확인 요 — 이미
부트스트랩된 클러스터에서는 ConfigMap을 고쳐도 Deployment 재시작만으로는 realm 롤이 안 바뀐다,
Task 도입부 참고). `keycloak-users.yaml`과 같은 Admin REST API 패턴으로 새 파일을 만든다.

`gitops/charts/beluga-platform/templates/keycloak-role-migration.yaml`(신규):

```yaml
# Task 18(D-I): Keycloak realm 롤 마이그레이션 Job. keycloak-realm ConfigMap(keycloak.yaml)을
# 아무리 고쳐도 --import-realm은 이미 존재하는 realm을 재임포트하지 않는다 — 그래서 이미
# 부트스트랩된 클러스터의 실제 realm 롤은 Admin REST API로 직접 옮겨야 한다.
# keycloak-users.yaml과 동일한 Admin REST API Job 패턴(토큰 획득 → REST 호출)을 재사용한다.
---
apiVersion: batch/v1
kind: Job
metadata:
  name: keycloak-role-migration
  namespace: iam
  annotations:
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 10
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: keycloak-role-migration
          image: python:3.12-slim
          command:
            - python3
            - -c
            - |
              import sys
              import time
              import json
              import urllib.request
              import urllib.parse
              import urllib.error

              KC_BASE = "http://keycloak.iam.svc.cluster.local:8080"
              REALM = "beluga"
              ADMIN_USER = "admin"
              ADMIN_PASS = {{ .Values.credentials.keycloakAdminPassword | quote }}

              # (구 realm 롤명, 신 realm 롤명, 설명, 컴포지트로 포함할 신 롤명 또는 None)
              # 순서가 중요하다 — analysts가 먼저 있어야 engineers의 컴포지트로 넣을 수 있다.
              ROLE_MIGRATIONS = [
                  ("beluga-analyst", "analysts", "Beluga Analyst base role", None),
                  ("beluga-engineer", "engineers", "Beluga Engineer role (includes analysts)", "analysts"),
                  ("beluga-admin", "admins", "Beluga Admin role (includes engineers)", "engineers"),
              ]
              # 네이티브 Keycloak 그룹(admin/engineer/analyst, singular) → (구 롤명, 신 롤명)
              GROUP_ROLE_MIGRATIONS = [
                  ("admin", "beluga-admin", "admins"),
                  ("engineer", "beluga-engineer", "engineers"),
                  ("analyst", "beluga-analyst", "analysts"),
              ]

              def make_req(url, data=None, headers=None, method=None):
                  if headers is None:
                      headers = {}
                  if data is not None and isinstance(data, (dict, list)):
                      data = json.dumps(data).encode("utf-8")
                      headers["Content-Type"] = "application/json"
                  elif data is not None and isinstance(data, str):
                      data = data.encode("utf-8")
                  req = urllib.request.Request(url, data=data, headers=headers, method=method)
                  try:
                      with urllib.request.urlopen(req) as resp:
                          body = resp.read().decode("utf-8")
                          return resp.status, body
                  except urllib.error.HTTPError as e:
                      if e.code == 404:
                          return 404, ""
                      err_body = e.read().decode("utf-8")
                      print(f"HTTPError: {e.code} for {url}: {err_body}")
                      raise e

              print("Waiting for Keycloak realm beluga to be ready...")
              ready = False
              for i in range(60):
                  try:
                      status, _ = make_req(f"{KC_BASE}/realms/{REALM}")
                      if status == 200:
                          ready = True
                          break
                  except Exception:
                      pass
                  time.sleep(5)
              if not ready:
                  print("Keycloak did not become ready in time.")
                  sys.exit(1)

              token_data = urllib.parse.urlencode({
                  "client_id": "admin-cli",
                  "grant_type": "password",
                  "username": ADMIN_USER,
                  "password": ADMIN_PASS,
              }).encode("utf-8")
              status, body = make_req(
                  f"{KC_BASE}/realms/master/protocol/openid-connect/token",
                  data=token_data,
                  headers={"Content-Type": "application/x-www-form-urlencoded"},
                  method="POST",
              )
              if status != 200:
                  print(f"Failed to get admin token, status: {status}")
                  sys.exit(1)
              auth_headers = {"Authorization": f"Bearer {json.loads(body)['access_token']}"}

              def get_role(name):
                  status, body = make_req(f"{KC_BASE}/admin/realms/{REALM}/roles/{urllib.parse.quote(name)}", headers=auth_headers)
                  return json.loads(body) if status == 200 else None

              # 1. 새 realm 롤 생성(없으면)
              for old_name, new_name, description, _ in ROLE_MIGRATIONS:
                  if get_role(new_name) is None:
                      print(f"Creating role {new_name}...")
                      status, body = make_req(
                          f"{KC_BASE}/admin/realms/{REALM}/roles",
                          data={"name": new_name, "description": description},
                          headers=auth_headers,
                          method="POST",
                      )
                      if status not in (201, 204):
                          print(f"Failed to create role {new_name}: {status} {body}")
                          sys.exit(1)

              # 2. 컴포지트 구성(engineers ⊃ analysts, admins ⊃ engineers)
              for old_name, new_name, _, child_name in ROLE_MIGRATIONS:
                  if child_name is None:
                      continue
                  role = get_role(new_name)
                  child = get_role(child_name)
                  status, body = make_req(
                      f"{KC_BASE}/admin/realms/{REALM}/roles/{urllib.parse.quote(new_name)}/composites",
                      headers=auth_headers,
                  )
                  existing_ids = {r["id"] for r in json.loads(body)} if status == 200 else set()
                  if child["id"] not in existing_ids:
                      print(f"Adding composite {child_name} -> {new_name}...")
                      status, body = make_req(
                          f"{KC_BASE}/admin/realms/{REALM}/roles/{urllib.parse.quote(new_name)}/composites",
                          data=[child],
                          headers=auth_headers,
                          method="POST",
                      )
                      if status not in (201, 204):
                          print(f"Failed to add composite for {new_name}: {status} {body}")
                          sys.exit(1)

              # 3. 네이티브 그룹의 realm 롤 매핑을 구 롤 -> 신 롤로 옮긴다
              status, body = make_req(f"{KC_BASE}/admin/realms/{REALM}/groups", headers=auth_headers)
              if status != 200:
                  print(f"Failed to fetch groups: {status} {body}")
                  sys.exit(1)
              group_map = {g["name"]: g["id"] for g in json.loads(body)}

              for group_name, old_role_name, new_role_name in GROUP_ROLE_MIGRATIONS:
                  if group_name not in group_map:
                      print(f"Group '{group_name}' not found — skipping (keycloak-users.yaml not applied yet?).")
                      continue
                  group_id = group_map[group_name]
                  mappings_url = f"{KC_BASE}/admin/realms/{REALM}/groups/{group_id}/role-mappings/realm"
                  status, body = make_req(mappings_url, headers=auth_headers)
                  current = {r["name"]: r for r in json.loads(body)} if status == 200 else {}

                  if new_role_name not in current:
                      new_role = get_role(new_role_name)
                      print(f"Mapping group {group_name} -> {new_role_name}...")
                      status, body = make_req(mappings_url, data=[new_role], headers=auth_headers, method="POST")
                      if status not in (201, 204):
                          print(f"Failed to map {new_role_name} to group {group_name}: {status} {body}")
                          sys.exit(1)

                  if old_role_name in current:
                      print(f"Unmapping group {group_name} -> {old_role_name}...")
                      status, body = make_req(mappings_url, data=[current[old_role_name]], headers=auth_headers, method="DELETE")
                      if status not in (204,):
                          print(f"Failed to unmap {old_role_name} from group {group_name}: {status} {body}")
                          sys.exit(1)

              # 4. 구 realm 롤 삭제(더 이상 어떤 그룹도 참조하지 않는다)
              for old_name, new_name, _, _ in ROLE_MIGRATIONS:
                  if get_role(old_name) is not None:
                      print(f"Deleting superseded role {old_name}...")
                      status, body = make_req(
                          f"{KC_BASE}/admin/realms/{REALM}/roles/{urllib.parse.quote(old_name)}",
                          headers=auth_headers,
                          method="DELETE",
                      )
                      if status not in (204,):
                          print(f"Failed to delete role {old_name}: {status} {body}")
                          sys.exit(1)

              print("Keycloak role migration complete.")
```

- [ ] **Step 7: 마이그레이션 Job 렌더 및 파이썬 문법 검증**

```bash
helm template beluga-platform gitops/charts/beluga-platform \
  | yq 'select(.metadata.name == "keycloak-role-migration") | .spec.template.spec.containers[0].command[2]' -r \
  | python3 -c "import sys; compile(sys.stdin.read(), 'keycloak-role-migration.py', 'exec'); print('PY OK')"
```

Expected: `PY OK`

- [ ] **Step 8: `tests/06-authz-defaults.sh`의 D19 롤 이름 갱신**

```bash
sed -n '28p' tests/06-authz-defaults.sh
```

Expected: `GRANTED=$(run_psql "SELECT has_table_privilege('beluga_analyst','authz_probe','SELECT');")`

```bash
sed -i '' "s/has_table_privilege('beluga_analyst'/has_table_privilege('analysts'/" tests/06-authz-defaults.sh
sed -n '28p' tests/06-authz-defaults.sh
```

Expected: `GRANTED=$(run_psql "SELECT has_table_privilege('analysts','authz_probe','SELECT');")`.
접속 계정(`beluga_admin`, 25행 `-U beluga_admin`)은 서비스 로그인 계정이라 그대로 둔다.

- [ ] **Step 9: 라이브 검증 (클러스터가 있을 때만)**

**클러스터가 없으면 이 단계 전체를 수행했다고 적지 말고 못 했다고 보고한다.** 지금
(`kubectl`이 `192.168.77.10:6443`에 타임아웃) 이 단계는 수행 불가 — 클러스터 복구 후 실행한다.

```bash
kubectl -n database delete job db-roles-setup --ignore-not-found
kubectl -n iam delete job keycloak-role-migration --ignore-not-found
argocd app sync beluga-data beluga-platform   # 또는 각 Job의 ArgoCD Sync hook이 자동 재생성
kubectl -n database wait --for=condition=complete job/db-roles-setup --timeout=180s
kubectl -n iam wait --for=condition=complete job/keycloak-role-migration --timeout=180s
```

Expected: 두 Job 모두 `condition=complete`. 실패하면 `kubectl logs job/<name>`으로 원인을 보고한다
(2b의 CREATEROLE 자동 ADMIN OPTION 가정이 틀렸다면 여기서 `GRANT admins TO beluga_admin`이
실패로 드러난다).

PostgreSQL 쪽 확인(비밀번호는 stdin으로만 전달 — `tests/06-authz-defaults.sh` 관례):

```bash
BELUGA_ADMIN_PW=$(kubectl -n database get secret postgres-admin-credential -o jsonpath='{.data.password}' | base64 -d)
printf '%s' "${BELUGA_ADMIN_PW}" | kubectl -n database exec -i postgres-main-1 -c postgres -- \
  bash -c 'PGPASSWORD="$(cat)" exec psql -h 127.0.0.1 -U beluga_admin -d shop -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('"'"'analysts'"'"','"'"'engineers'"'"','"'"'admins'"'"','"'"'beluga_analyst'"'"','"'"'beluga_engineer'"'"') ORDER BY 1;"'
```

Expected: `admins`, `analysts`, `engineers` 세 줄만 — `beluga_analyst`/`beluga_engineer`는 없어야
한다(마이그레이션으로 삭제됨).

```bash
bash tests/06-authz-defaults.sh
```

Expected: `[TEST 06] 신규 테이블은 기본 거부 상태.` (analysts로 갱신된 쿼리로 통과)

Keycloak 쪽 확인(admin 토큰으로 realm 롤 조회):

```bash
KC_ADMIN_PW=$(kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.keycloak-admin-password}' | base64 -d)
TOKEN=$(curl -s -X POST "http://sso.local.beluga.internal/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli&grant_type=password&username=admin&password=${KC_ADMIN_PW}" | jq -r .access_token)
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "http://sso.local.beluga.internal/admin/realms/beluga/roles" | jq -r '.[].name' | sort
```

Expected: `admins`, `analysts`, `engineers` — `beluga-admin`/`beluga-engineer`/`beluga-analyst`는
목록에 없어야 한다.

- [ ] **Step 10: 커밋**

```bash
git add gitops/charts/beluga-platform/templates/keycloak.yaml \
  gitops/charts/beluga-platform/templates/keycloak-role-migration.yaml \
  gitops/charts/beluga-data/files/db-roles.sql \
  tests/06-authz-defaults.sh
git commit -m "fix(iam): 배포 산출물 롤 이름을 analysts/engineers/admins로 마이그레이션 (D-I)"
```

---

## Task 19: 카탈로그 브라우징 오퍼레이션 갭 해소 — ShowTables/FilterTables 등 + 테이블 규칙 카탈로그 가드 (D-H)

Task 12 리뷰(`task-12-review.md` 「충분성 판정」)의 실측: `ExecuteQuery`/`AccessCatalog`/
`ShowSchemas` 세 개가 열려도, FQN을 이미 아는 프로그램의 단순 SELECT만 통과할 뿐 사람·BI
도구가 브라우징하는 경로는 여전히 전부 막혀 있다. 실제 컴파일된 정책에 `opa eval`을 먹인
결과 전부 `false`다:

- **hard deny**(즉시 에러): `ShowTables`, `ShowColumns`, `ShowCreateTable`, `ShowFunctions`,
  `SetCatalogSessionProperty`
- **soft filter**(에러 없이 목록만 텅 빔 — Superset/DBeaver에 카탈로그·스키마·테이블이 하나도
  안 보이고, `USE iceberg.lake`도 여기 걸린다): `FilterCatalogs`, `FilterSchemas`, `FilterTables`

이 여덟 오퍼레이션이 공유하지 않는 것은 리소스 모양이다. Task 12의 방출부(`rego.ts`)는 이미
`Record<QueryOperation, "none" | "catalog">` 구조로 이걸 방어하도록 고쳐져 있다(Task 12 리뷰
I-2 수정 라운드, 커밋 `030c1fa`) — enum에 새 오퍼레이션을 추가하고 이 Record를 채우지 않으면
`npm run typecheck`가 즉시 실패한다. 이 태스크는 그 구조를 그대로 확장한다: 여덟 오퍼레이션의
실제 리소스 모양을 Trino 483 태그 소스로 직접 확인했다(`plugin/trino-opa/src/main/java/io/trino/plugin/opa/`,
아래 Step 2 코드의 줄 번호 주석 참고) — 문서에 없으므로 이름 규칙으로 유도하면 안 되고(Task 12
리뷰가 이미 지적한 함정), 각 호출부의 리터럴을 확인해야 한다.

**두 번째로 접는 것 (M-4, D-H)**: 기존 테이블 규칙(`resource.table.schemaName`/`tableName`,
`resource.column.schemaName`/`tableName`/`columnName`)은 카탈로그를 아예 보지 않는다. 실측:
`SelectFromColumns` + `{catalogName:"evil", schemaName:"lake", tableName:"events_enriched"}` →
`true`. 배포 카탈로그가 `iceberg` 하나뿐인 지금은 무해하지만(`gitops/charts/beluga-data/templates/06-trino.yaml:4-17`,
ConfigMap `trino-catalog-iceberg` 하나뿐), 이 태스크가 카탈로그 개념을 `catalogGrants`로 이미
모델에 들여왔으므로 두 번째 카탈로그가 배포되는 순간 조용히 격리가 깨진다.

D-H(프로젝트 오너 결정): **지금은 `resourceSchema`에 `catalog` 필드를 추가하지 않고 단일
상수로 고정한다.** 카탈로그가 하나뿐인 현실에 필드를 얹으면 한 번도 다른 값을 받아본 적
없는 죽은 확장점이 생긴다 — Task 12 리뷰 I-2가 경고한 바로 그 함정("한 줄 수정처럼 보이지만
검증 안 된 확장")을 스키마 쪽에서 반복하지 않기 위함이다. 두 번째 카탈로그가 실제로
배포되면(`06-trino.yaml`에 두 번째 `trino-catalog-*` ConfigMap 추가) `resourceSchema`에
선택적 `catalog` 필드(기본값 `DEPLOYED_CATALOG`)를 추가하고 `rego.ts`의 참조를 `res.catalog`로
바꾸는 것이 탈출구다 — 이 결정은 코드 주석에도 남긴다.

**이 태스크는 두 리포에 걸친다.**

**Files:**
- Modify (beluga-manager): `src/schema.ts`, `src/compiler/rego.ts`
- Modify (beluga-manager): `tests/fixtures/catalog-grants.yaml`, `tests/compiler-rego.test.ts`, `tests/golden/trino.rego`
- Modify (beluga 리포): `policies/catalog.yaml`

**Interfaces:**
- Consumes: `Declaration.catalogGrants`(Task 12), `Declaration.resources`(Task 3), `OPERATION_RESOURCE_SHAPE`(Task 12 리뷰 수정)
- Produces: `queryOperationSchema`에 8개 오퍼레이션 추가; `compileRego`가 그것들의 allow 규칙을
  리소스 모양별로(catalog/schema/table/catalogSessionProperty) 방출; 기존 테이블 규칙 3종(select
  등 4-privilege, rowFilter, columnMask)에 카탈로그 가드 추가

- [ ] **Step 1: 스키마 확장**

`src/schema.ts`의 `queryOperationSchema`를 8개 오퍼레이션으로 넓힌다:

```typescript
export const queryOperationSchema = z.enum([
  "ExecuteQuery",
  "AccessCatalog",
  "ShowSchemas",
  // Task 19: 카탈로그·스키마·테이블 브라우징(BI 도구·대화형 SQL 클라이언트가 실제로 보내는
  // 시퀀스). 리소스 모양은 rego.ts의 OPERATION_RESOURCE_SHAPE 주석 참고 — 전부 Trino 483 태그
  // OpaAccessControl.java 소스로 확정(문서에 없음, 이름 규칙으로 유도 불가).
  "ShowTables",
  "ShowColumns",
  "ShowCreateTable",
  "ShowFunctions",
  "SetCatalogSessionProperty",
  "FilterCatalogs",
  "FilterSchemas",
  "FilterTables",
]);
```

같은 파일에 `DEPLOYED_CATALOG` 상수를 추가한다(`catalogGrantSchema` 정의 바로 위):

```typescript
// Task 19(M-4, D-H): 배포 카탈로그는 iceberg 하나뿐이다
// (gitops/charts/beluga-data/templates/06-trino.yaml — ConfigMap trino-catalog-iceberg 단일).
// resourceSchema에 catalog 필드를 얹는 대신 상수로 고정한다 — 한 번도 다른 값을 받아본 적
// 없는 필드는 Task 12 리뷰 I-2가 경고한 "검증 안 된 확장점"이 된다. 두 번째 카탈로그가
// 실제로 배포되면 resourceSchema에 선택적 catalog 필드(기본값 이 상수)를 추가하고
// rego.ts의 참조를 res.catalog로 바꿀 것 — 그게 이 결정의 탈출구다.
export const DEPLOYED_CATALOG = "iceberg";
```

Run: `npm run typecheck`
Expected: 아직 `rego.ts`가 `OPERATION_RESOURCE_SHAPE`를 3개 키로만 채우고 있으므로
`Record<QueryOperation, ...>`가 나머지 8개 키 누락으로 **타입 에러가 나야 한다** — Step 2로
넘어가기 전에 이 실패를 직접 확인해 구조적 방어가 실제로 작동함을 눈으로 본다.

- [ ] **Step 2: Rego 방출 확장 — 리소스 모양 4종**

`src/compiler/rego.ts`의 `OPERATION_RESOURCE_SHAPE`를 아래로 교체한다. Trino 483 태그
`OpaAccessControl.java`를 직접 확인한 결과다:

```typescript
// Task 19: 여덟 개 브라우징 오퍼레이션이 추가되며 리소스 모양이 4종으로 늘었다.
// Trino 483 태그 OpaAccessControl.java 확인:
//   "catalog"  : resource.catalog.name        — AccessCatalog(:169-176), ShowSchemas(:259-266),
//                FilterCatalogs(:199-206) — 전부 OpaQueryInputResource.builder().catalog(...)
//   "schema"   : resource.schema.catalogName  — ShowTables(:344-350), FilterSchemas(:269-277),
//                ShowFunctions(:638-645) — 전부 TrinoSchema(catalogName, schemaName)
//   "table"    : resource.table.catalogName   — ShowColumns(:367-370), ShowCreateTable(:290-293,
//                둘 다 checkTableOperation:755-762 경유), FilterTables(:354-364) — 전부 TrinoTable
//   "catalogSessionProperty": resource.catalogSessionProperty.catalogName —
//                SetCatalogSessionProperty(:550-557) — TrinoCatalogSessionProperty(catalogName, propertyName)
// catalogGrants는 카탈로그 단위 선언이라 schemaName/tableName/propertyName을 아예 싣지
// 않는다 — 이 그랜트는 "이 카탈로그 안의 아무 스키마/테이블/세션 속성이나 나열·조회할 수
// 있다"는 메타데이터 권한이고, 실제 데이터 접근(SELECT 등)은 여전히 resources.yaml의
// 테이블별 grants가 따로 막는다. 의도적 설계이며 이 태스크의 스코프다.
type ResourceShape = "none" | "catalog" | "schema" | "table" | "catalogSessionProperty";

const OPERATION_RESOURCE_SHAPE: Record<QueryOperation, ResourceShape> = {
  ExecuteQuery: "none", // :119 — 리소스 인자 없음
  AccessCatalog: "catalog", // :169-176
  ShowSchemas: "catalog", // :259-266
  FilterCatalogs: "catalog", // :199-206
  ShowTables: "schema", // :344-350
  FilterSchemas: "schema", // :269-277
  ShowFunctions: "schema", // :638-645
  ShowColumns: "table", // :367-370
  ShowCreateTable: "table", // :290-293
  FilterTables: "table", // :354-364
  SetCatalogSessionProperty: "catalogSessionProperty", // :550-557
};

// 모양별로 카탈로그명이 실리는 JSON 경로. Record라 새 모양을 추가하면서 여기 채우지 않으면
// 타입체크가 즉시 실패한다 — I-2와 동일한 구조적 방어를 경로 테이블에도 적용한 것.
const CATALOG_GUARD_PATH: Record<Exclude<ResourceShape, "none">, string> = {
  catalog: "input.action.resource.catalog.name",
  schema: "input.action.resource.schema.catalogName",
  table: "input.action.resource.table.catalogName",
  catalogSessionProperty: "input.action.resource.catalogSessionProperty.catalogName",
};
```

카탈로그 그랜트 루프 안의 `resourceGuard` 계산(라운드 1에서 `shape` 분기로 이미 바뀐 지점)을
경로 테이블을 쓰도록 바꾼다:

```typescript
const shape = OPERATION_RESOURCE_SHAPE[op];
const resourceGuard =
  shape === "none" ? [] : [`\t${CATALOG_GUARD_PATH[shape]} == ${JSON.stringify(cg.catalog)}`];
```

Run: `npm run typecheck`
Expected: 통과. Step 1의 타입 에러가 사라진다.

- [ ] **Step 3: 기존 테이블 규칙에 카탈로그 가드 추가 (M-4)**

`src/compiler/rego.ts` 상단 import에 값 import를 추가한다:

```typescript
import { DEPLOYED_CATALOG } from "../schema.js";
```

세 곳에 `catalogName` 가드를 한 줄씩 추가한다 — 전부 `input.action.resource.*.schemaName` 줄
바로 위에 넣어 기존 줄 순서와 인접성을 유지한다.

1) 4-privilege 규칙(select/insert/update/delete, 기존 `input.action.resource.table.schemaName`
줄 앞):

```typescript
`\tinput.action.resource.table.catalogName == ${JSON.stringify(DEPLOYED_CATALOG)}`,
`\tinput.action.resource.table.schemaName == ${JSON.stringify(schema)}`,
```

2) `rowFilter` 규칙의 `body`(`GetRowFilters`가 `resource.table`을 쓴다 —
`OpaHighLevelClient.java:146-152` 확인):

```typescript
`\tinput.action.resource.table.catalogName == ${JSON.stringify(DEPLOYED_CATALOG)}`,
`\tinput.action.resource.table.schemaName == ${JSON.stringify(schema)}`,
```

3) `columnMask` 규칙의 `body`(`GetColumnMask`는 `resource.column`을 쓰고, `TrinoColumn`
레코드에 `catalogName` 필드가 있다 — `schema/TrinoColumn.java` 확인):

```typescript
`\tinput.action.resource.column.catalogName == ${JSON.stringify(DEPLOYED_CATALOG)}`,
`\tinput.action.resource.column.schemaName == ${JSON.stringify(schema)}`,
```

Run: `npm run typecheck`
Expected: 통과.

- [ ] **Step 4: 테스트 — fixture 확장, 신규 어서션, 골든 갱신**

`tests/fixtures/catalog-grants.yaml`의 `operations` 배열을 8개 추가해 11개로 넓힌다:

```yaml
catalogGrants:
  - catalog: iceberg
    roles: [analysts]
    operations:
      [
        ExecuteQuery, AccessCatalog, ShowSchemas,
        ShowTables, ShowColumns, ShowCreateTable, ShowFunctions, SetCatalogSessionProperty,
        FilterCatalogs, FilterSchemas, FilterTables,
      ]
```

`tests/compiler-rego.test.ts`에 리소스 모양별 가드가 실제로 다른 경로로 나오는지 확인하는
테스트를 추가한다(카탈로그·스키마·테이블·세션속성 4종 전부):

```typescript
test("브라우징 오퍼레이션이 리소스 모양별로 다른 가드 경로를 쓴다 (Task 19)", () => {
  const decl = parseDeclaration(
    readFileSync(new URL("./fixtures/catalog-grants.yaml", import.meta.url), "utf8"),
  );
  const rego = compileRego(decl);
  expect(rego).toMatch(/input\.action\.operation == "ShowTables"[\s\S]*?resource\.schema\.catalogName == "iceberg"/);
  expect(rego).toMatch(/input\.action\.operation == "ShowColumns"[\s\S]*?resource\.table\.catalogName == "iceberg"/);
  expect(rego).toMatch(/input\.action\.operation == "FilterCatalogs"[\s\S]*?resource\.catalog\.name == "iceberg"/);
  expect(rego).toMatch(
    /input\.action\.operation == "SetCatalogSessionProperty"[\s\S]*?resource\.catalogSessionProperty\.catalogName == "iceberg"/,
  );
});
```

기존 하위호환 테스트(M-1 수정 라운드가 넓힌 정규식)를 8개 신규 오퍼레이션명까지 포함하도록
다시 넓힌다:

```typescript
expect(compileRego(decl)).not.toMatch(
  /ExecuteQuery|AccessCatalog|ShowSchemas|ShowTables|ShowColumns|ShowCreateTable|ShowFunctions|SetCatalogSessionProperty|FilterCatalogs|FilterSchemas|FilterTables/,
);
```

Run: `npm test -- tests/compiler-rego.test.ts`
Expected: 새 테스트 포함 전체 PASS. 기존 golden 비교 테스트(테이블 그랜트가 있는 fixture를
쓰는 테스트)는 **Step 3의 catalogName 가드 때문에 반드시 실패한다** — 이것이 정상이다.

`tests/golden/trino.rego`를 갱신한다. **맹목적으로 재생성해 덮어쓰지 말 것** — 골든 비교
테스트가 어떤 fixture를 쓰는지 `tests/compiler-rego.test.ts`에서 먼저 확인한 뒤, 재컴파일
결과를 기존 골든과 `diff`로 비교해 **추가된 줄이 각 테이블 규칙 블록마다
`input.action.resource.table.catalogName == "iceberg"`(또는 `.column.catalogName`) 한 줄씩뿐**임을
눈으로 확인하고 나서 덮어쓴다:

```bash
npx tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDeclaration } from './src/schema.ts';
import { compileRego } from './src/compiler/rego.ts';
// tests/compiler-rego.test.ts의 골든 비교 테스트가 참조하는 fixture 이름으로 바꿀 것
const decl = parseDeclaration(readFileSync('tests/fixtures/<golden-fixture>.yaml','utf8'));
writeFileSync('/tmp/new-golden.rego', compileRego(decl));
"
diff tests/golden/trino.rego /tmp/new-golden.rego
```

Expected: diff에 `catalogName` 가드 줄 추가 외 다른 변화가 없다. 확인 후
`cp /tmp/new-golden.rego tests/golden/trino.rego`.

Run: `npm test && npm run typecheck`
Expected: 전체 PASS.

- [ ] **Step 5: `opa check` / `opa eval` 실행 검증 (네이티브 바이너리)**

클러스터가 다운돼 있으므로(`kubectl`이 `192.168.77.10:6443`에 타임아웃) 전부 오프라인
컴파일 산출물로 검증한다. `opa` 1.19.0이 `/opt/homebrew/bin/opa`에 네이티브로 있다.

```bash
mkdir -p /tmp/beluga-artifacts-task19
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/beluga-artifacts-task19
/opt/homebrew/bin/opa check /tmp/beluga-artifacts-task19/trino.rego
```

Expected: 출력 없음(성공).

각 리소스 모양별로 하나씩, granted(`analysts`)와 ungranted(`nobody`) 양쪽을 평가한다:

```bash
OPA=/opt/homebrew/bin/opa
POL=/tmp/beluga-artifacts-task19/trino.rego

# schema 모양 — ShowTables
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"ShowTables","resource":{"schema":{"catalogName":"iceberg","schemaName":"lake"}}}}') 'data.trino.allow'
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["nobody"]}},"action":{"operation":"ShowTables","resource":{"schema":{"catalogName":"iceberg","schemaName":"lake"}}}}') 'data.trino.allow'

# table 모양 — ShowColumns
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"ShowColumns","resource":{"table":{"catalogName":"iceberg","schemaName":"lake","tableName":"events_enriched"}}}}') 'data.trino.allow'

# catalog 모양 — FilterCatalogs
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"FilterCatalogs","resource":{"catalog":{"name":"iceberg"}}}}') 'data.trino.allow'

# catalogSessionProperty 모양 — SetCatalogSessionProperty
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"SetCatalogSessionProperty","resource":{"catalogSessionProperty":{"catalogName":"iceberg","propertyName":"parquet_use_column_names"}}}}') 'data.trino.allow'

# M-4 회귀 확인 — 두 번째(가상) 카탈로그의 테이블은 이제 막힌다
$OPA eval -d $POL -i <(echo '{"context":{"identity":{"groups":["analysts"]}},"action":{"operation":"SelectFromColumns","resource":{"table":{"catalogName":"evil","schemaName":"lake","tableName":"events_enriched"}}}}') 'data.trino.allow'
```

Expected: `analysts` 4건 전부 `true`, `nobody` 건 `false`, M-4 회귀 확인 건(`catalogName:"evil"`)
`false` — Task 12 리뷰가 잡은 카탈로그 미검증 구멍이 닫혔음을 실측으로 증명한다.

- [ ] **Step 6: 실제 정책 원천 갱신 (beluga 리포)**

`policies/catalog.yaml`의 기존 `iceberg` 항목에 여덟 오퍼레이션을 추가한다(새 항목을 만들지
않는다 — `catalog`+`roles`가 같으면 `DUPLICATE_CATALOG_GRANT` 검증에 걸린다):

```yaml
catalogGrants:
  - catalog: iceberg
    roles: [analysts]
    operations:
      [
        ExecuteQuery, AccessCatalog, ShowSchemas,
        ShowTables, ShowColumns, ShowCreateTable, ShowFunctions, SetCatalogSessionProperty,
        FilterCatalogs, FilterSchemas, FilterTables,
      ]
```

`analysts`에 부여하면 `holdersOf` 상속 확장으로 `engineers`/`admins`도 자동으로 포함된다
(Task 12와 동일 패턴).

- [ ] **Step 7: 전체 통과 확인 및 실제 정책 재컴파일**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
npm test && npm run typecheck
rm -rf /tmp/beluga-artifacts-task19 && mkdir -p /tmp/beluga-artifacts-task19
npm run policyctl -- compile ~/Documents/IdeaProjects/20.dasomel/beluga/policies --out /tmp/beluga-artifacts-task19
grep -c "ShowTables\|FilterTables" /tmp/beluga-artifacts-task19/trino.rego
/opt/homebrew/bin/opa check /tmp/beluga-artifacts-task19/trino.rego
```

Expected: 전체 테스트 PASS, grep 카운트 > 0, `opa check` 출력 없음.

- [ ] **Step 8: 종단 시나리오 — SHOW TABLES / FilterTables 시퀀스**

`SHOW TABLES FROM iceberg.lake`가 실제로 발생시키는 두 요청(`ShowTables` 1회 + `FilterTables`
테이블당 1회)을 Step 7에서 만든 실제 정책에 그대로 먹여, 부여된 롤과 부여되지 않은 롤에서
반대로 나오는지 확인한다:

```bash
OPA=/opt/homebrew/bin/opa
POL=/tmp/beluga-artifacts-task19/trino.rego

for GROUP in analysts nobody; do
  echo "=== group=$GROUP ==="
  echo -n "ShowTables:   "
  $OPA eval -d $POL -i <(echo "{\"context\":{\"identity\":{\"groups\":[\"$GROUP\"]}},\"action\":{\"operation\":\"ShowTables\",\"resource\":{\"schema\":{\"catalogName\":\"iceberg\",\"schemaName\":\"lake\"}}}}") 'data.trino.allow' -f pretty
  echo -n "FilterTables: "
  $OPA eval -d $POL -i <(echo "{\"context\":{\"identity\":{\"groups\":[\"$GROUP\"]}},\"action\":{\"operation\":\"FilterTables\",\"resource\":{\"table\":{\"catalogName\":\"iceberg\",\"schemaName\":\"lake\",\"tableName\":\"events_enriched\"}}}}") 'data.trino.allow' -f pretty
done
```

Expected: `group=analysts`는 두 줄 다 `true`(목록에 `lake` 스키마와 `events_enriched` 테이블이
뜬다는 뜻), `group=nobody`는 두 줄 다 `false`(목록이 비어 보인다는 뜻) — `SHOW TABLES`가 에러
없이 텅 비던 상태에서, 권한 있는 사용자에게는 실제로 채워진 상태로 바뀌었음을 증명한다.
라이브 Trino 없이 검증 가능한 범위는 여기까지다. 실제 `SHOW TABLES FROM iceberg.lake`가 같은
결과를 내는지는 Task 14 컷오버 이후 라이브에서만 확정된다 — 이 태스크의 범위 밖으로 남긴다.

- [ ] **Step 9: 커밋 (두 리포)**

```bash
cd ~/Documents/IdeaProjects/20.dasomel/beluga-manager
git add src/schema.ts src/compiler/rego.ts \
  tests/fixtures/catalog-grants.yaml tests/compiler-rego.test.ts tests/golden/trino.rego
git commit -m "feat(compiler): 브라우징 오퍼레이션 8종 추가 + 테이블 규칙 카탈로그 가드 (D-H)"

cd ~/Documents/IdeaProjects/20.dasomel/beluga
git add policies/catalog.yaml
git commit -m "feat(policies): 카탈로그 grant에 브라우징 오퍼레이션 8종 추가 — ShowTables 등"
```

---

## 완료 정의

이 계획이 끝나면 아래가 모두 성립한다.

1. `bash tests/06-authz-defaults.sh` 통과 — 신규 테이블이 기본 거부 상태 (Task 1)
2. `npm test` 전체 통과 — 스키마·검증·컴파일러 3종·드리프트·카탈로그 오퍼레이션 (Task 3~8, 10~12)
3. `npm run typecheck` 오류 없음
4. `npm run policyctl -- compile <beluga>/policies --out /tmp/artifacts` 가 세 파일을 생성하고,
   생성된 `trino.rego`가 `opa check`를 통과한다 (Task 8)
5. Keycloak 그룹 목록에 LDAP 그룹이 나타난다 (Task 9)
6. 선언·Keycloak·Rego·PG의 롤 이름이 `analysts`/`engineers`/`admins`로 일치하고, `beluga-analyst`
   류 이름이 코드·정책 원천·배포 매니페스트 어디에도 남아 있지 않다 — 선언·Rego·PG 컴파일러
   산출물은 Task 11, 배포된 Keycloak realm 롤·PostgreSQL D19 특권 롤 마이그레이션은 Task 18
7. `ExecuteQuery`/`AccessCatalog`/`ShowSchemas`가 실제 OPA 평가에서 `allow`를 받는다 — 테이블
   규칙이 맞아도 카탈로그 레벨에서 막혀 있던 상태가 해소된다 (Task 12)
8. Trino 코디네이터가 실제로 `identity.groups`를 채운 상태로 쿼리를 평가한다 — OPA decision
   log에서 빈 배열이 아닌 `groups`를 직접 확인한다 (Task 13)
9. 배포된 `gitops/charts/beluga-platform/files/opa/trino.rego`가 컴파일러 산출물이고
   (`deny` 규칙이 전혀 없다), `opa.policy.row-filters-uri`/`opa.policy.column-masking-uri`
   요청이 OPA decision log에 실제로 찍힌다 (Task 14)
10. Trino 코디네이터가 자체 TLS(cert-manager 발급)로 `https://.../v1/info`에 응답한다 (Task 15)
11. Trino가 OAuth2 인증을 요구한다 — `X-Trino-User`만으로 보낸 요청이 거부되고(401/redirect),
    유효한 Keycloak 토큰으로는 성공한다 (Task 16)

## 다음 계획으로 넘길 것

- 어댑터 실제 구현(`readState`/`apply`의 네트워크 부분) — 계획 2에서 UI와 함께
- Git 커밋 경로(하이브리드 쓰기의 Git 절반) — 계획 2
- 5개 화면, diff 게이트, sync worker CronJob — 계획 2
- 마스킹 산출물의 PG 쪽 적용(`SECURITY LABEL`) — 계획 3 (PG18 승급 후)
- 개인별 PG 롤 전환 — 계획 4
