# PostgreSQL 권한 컷오버 — 라이브 클러스터 런북 (이슈 #107)

> **범위**: `gitops/charts/beluga-data/files/db-roles.sql`의 Generated Body(§1–3)를
> policyctl 컴파일러 산출물로 컷오버한 오프라인 작업(커밋 `36a9614`, `1398d67`, `88bec03`,
> 테스트 14 parity gate)은 이미 완료되어 `main`에 병합돼 있다. 이 런북은 **그 컷오버가 이미
> 실행 중인(구버전 Job으로 넓은 권한을 부여받은) 라이브 클러스터에 적용될 때만** 필요한,
> 클러스터 접속이 있어야 수행 가능한 잔여 작업을 다룬다. 이 문서 자체는 아무것도 실행하지
> 않는다 — 클러스터 운영자가 접속 후 체크리스트를 따라간다.

## 1. 왜 필요한가

`02c-db-roles.yaml`의 Job은 ArgoCD sync마다 `db-roles.sql`을 재실행하며 **추가(additive)만
멱등**하다: `CREATE ROLE IF NOT EXISTS`와 새 `GRANT`는 재실행해도 안전하지만, SQL 파일에서
줄을 **삭제**해도 이미 부여된 권한은 자동으로 회수(REVOKE)되지 않는다.

컷오버 전(커밋 `36a9614` 이전) Job이 최소 한 번 이상 실행된 클러스터에는 다음이 이미
적용되어 있고, 새 Generated Body를 배포해도 아래 항목은 **그대로 남는다**:

| 구버전 항목 | 컷오버 후 상태 | 라이브 클러스터에 남아있는 위험 |
|---|---|---|
| `GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysts;` (`customers`만 개별 REVOKE) | 신규 Generated Body는 `orders`에만 명시적 SELECT | analysts가 `policies/resources.yaml`에 없는 미래 테이블도 여전히 SELECT 가능 — §10.1 "기본은 거부" 위반 |
| `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO engineers;` | 신규 Generated Body는 `customers`/`orders`에만 명시적 CRUD | engineers가 미선언 테이블에도 ALL 보유 |
| `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admins;` | admins는 이제 `engineers` 상속으로만 테이블 접근(§2 역할 상속) | admins에 중복 직접 GRANT가 남아 상속 경로와 별개로 권한이 존재 |
| `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO engineers;`/`admins;` | 신규 Generated Body는 engineers에 `USAGE, SELECT`만(§3) | `setval()`에 필요한 시퀀스 `UPDATE` 권한이 과다 부여 상태로 남음 |
| `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO engineers;`/`admins;` | 신규 Generated Body는 `ALTER DEFAULT PRIVILEGES`를 **절대 생성하지 않음**(pgddl.ts 설계 원칙) | **가장 위험** — 이 항목이 남아있으면 향후 아무 신규 테이블이나 자동으로 engineers/admins에 전권 부여되어, 컷오버의 실제 목적(기본 거부)이 무효화됨 |

## 2. 사전 확인 (읽기 전용, 안전)

클러스터에 `beluga_admin`(또는 동등 권한)으로 접속해 아래 쿼리로 현재 상태를 먼저 확인한다.
**아직 아무것도 수정하지 않는다.**

```sql
-- 2-1. 남아있는 ALTER DEFAULT PRIVILEGES 항목 확인 (가장 먼저 확인할 것)
SELECT defaclrole::regrole AS role, defaclnamespace::regnamespace AS schema, defaclacl
FROM pg_default_acl
WHERE defaclnamespace = 'public'::regnamespace
  AND defaclrole::regrole::text IN ('engineers', 'admins');

-- 2-2. 테이블 단위 직접 GRANT 목록 (ALL TABLES 블랭킷 여부 확인용)
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('analysts', 'engineers', 'admins')
ORDER BY grantee, table_name, privilege_type;

-- 2-3. 시퀀스 권한 확인
SELECT grantee, object_name, privilege_type
FROM information_schema.usage_privileges
WHERE object_schema = 'public' AND object_type = 'SEQUENCE'
  AND grantee IN ('engineers', 'admins');
```

2-1의 결과가 비어 있지 않으면(즉 `ALTER DEFAULT PRIVILEGES`가 남아있으면) 3단계를 반드시
수행한다. 2-2/2-3에서 `policies/resources.yaml`에 선언되지 않은 테이블·시퀀스에 대한 GRANT가
보이면 마찬가지로 해당 행을 3단계 REVOKE 대상에 포함한다.

## 3. 회수(REVOKE) 체크리스트

**순서 중요**: `ALTER DEFAULT PRIVILEGES` 회수 → 블랭킷 테이블/시퀀스 GRANT 회수 순으로
진행한다(반대로 하면 그 사이에 신규 테이블이 생성될 경우 구 default privileges가 먼저
적용되어 버릴 수 있다).

```sql
BEGIN;

-- 3-1. 구버전 ALTER DEFAULT PRIVILEGES 제거 — 미래 테이블 자동 권한 부여 중단
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM engineers;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM admins;

-- 3-2. 블랭킷 "ALL TABLES" 부여를 명시적 GRANT로 대체 (Generated Body가 이미
--      customers/orders에 필요한 권한을 명시적으로 재부여했으므로, 아래 REVOKE는
--      "선언되지 않은 나머지 테이블"에 대한 접근만 제거한다)
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM analysts;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM engineers;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM admins;

-- 3-3. 시퀀스 과다 권한 축소 (engineers/admins → USAGE, SELECT만 남기고 회수)
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM engineers;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM admins;

COMMIT;
```

`admins`에 직접 부여된 `ALL PRIVILEGES ON DATABASE shop`은 Epilogue(수기 유지 구간, §10.2)가
의도적으로 존속시키는 항목이므로 **건드리지 않는다** — db-roles.sql 44–47행 주석 참고.

`beluga_admin`(CNPG bootstrap owner, 서비스 로그인 계정) 자체에 대한 직접 GRANT도 위 REVOKE
대상에서 **제외**한다 — db-roles.sql 74–78행 주석(Task 18 마이그레이션 설계)이 이미 이유를
기록했다: Airflow/Superset/OpenMetadata/Lakekeeper 연결이 그 자리에서 끊길 위험이 있다.

## 4. 재적용 및 검증

```bash
# 4-1. ArgoCD sync를 트리거해 Generated Body를 재적용(멱등 — 안전)
argocd app sync beluga-data --resource batch/Job:02c-db-roles  # 또는 해당 Job 재실행

# 4-2. Job 로그로 ON_ERROR_STOP 트리거 없이 완료됐는지 확인
kubectl -n database logs job/<db-roles-job-name>
```

```sql
-- 4-3. 2단계 쿼리를 재실행해 pg_default_acl이 비어 있고,
--      role_table_grants가 db-roles.sql Generated Body(§3)와 정확히 일치하는지 확인
```

## 5. 롤백

3단계는 트랜잭션(`BEGIN`/`COMMIT`) 단위로 실행하므로 실행 도중 문제가 발견되면 `ROLLBACK`으로
즉시 되돌릴 수 있다. COMMIT 이후 되돌려야 하는 경우, 컷오버 이전 커밋(`36a9614`의 부모,
`8dedb46`)의 `db-roles.sql`을 임시로 재적용해 구버전 블랭킷 GRANT/`ALTER DEFAULT PRIVILEGES`를
복원한다. 서비스 연결(Airflow/Superset/OpenMetadata/Lakekeeper, 모두 `beluga_admin` 사용)은
이 절차 전체에서 영향받지 않는다 — 대상이 `analysts`/`engineers`/`admins` 상속 트리와
`beluga-*` LOGIN 계정뿐이기 때문이다.

## 6. 이 런북이 다루지 않는 것 — Epilogue 추가 흡수는 별도 차단 사유로 보류

이슈 코멘트(2026-09-18)가 언급한 "Epilogue 6개 항목의 컴파일러 흡수"는 **부분적으로만**
가능해졌다: beluga-manager PR #66(커밋 `3da9a12`)이 `pgddl.ts`에 D20 LOGIN 계정 생성·역할
바인딩·CONNECT 그랜트 자동 산출(§4–6, `Declaration.logins` 필드, `pgLoginSchema`)을 이미
추가했다. 그러나 **CLI가 아직 이를 소비하지 못한다** — `beluga-manager/packages/policy-compiler/bin/policyctl.ts`의
`loadPolicies()`는 `roles.yaml`/`groups.yaml`/`resources.yaml`/`catalog.yaml`만 읽고
`logins.yaml` 같은 파일을 로드하지 않으며, `resourcesFileSchema`가 `strictObject`라 최상위에
`logins` 키를 추가해도 컴파일러 CLI가 거부한다(직접 확인: `npm run policyctl -- compile
policies --out <dir>` 결과에 §4–6이 전혀 나타나지 않음, PR #66 테스트는 `compileAll()`을
프로그램적으로만 호출).

즉 남은 흡수 작업(CONNECT/LOGIN 롤 바인딩을 db-roles.sql Generated Body로 이관, Epilogue를
`beluga_admin` 바인딩 + 레거시 정리 DO 블록만으로 축소)은 **beluga-manager 쪽에
`policies/logins.yaml`을 읽는 CLI 로더 추가가 선행돼야** 시작할 수 있다. beluga-manager는 이
작업 범위 밖(read-only)이므로 이슈 #107은 이 항목에 대해서는 계속 열어 둔다.
