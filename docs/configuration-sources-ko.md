# 공식 구성 원천 및 드리프트 경계 (Authoritative Configuration Sources and Drift Boundaries)

[English](configuration-sources.md) | 한국어

이 문서는 [이슈 #39](https://github.com/dasomel/beluga/issues/39)의 인수 기준 1번("Authoritative configuration sources are documented — 공식 구성 원천 문서화")을 충족하기 위한 Beluga 데이터 플랫폼의 공식 구성 기준선(Configuration Baseline)을 정의한다. 기준 2~5번(중대한 드리프트 탐지 및 보고, 미승인 변경과 정상 생성 상태 구분, 재현 가능한 복구 절차, 운영 검토용 증적 보존)은 후속 구현 단계의 대상이며 본 문서에서는 완료로 주장하지 않는다.

---

## 1. 단일 진실 원천 (공식 구성 원천)

배포 가능한 모든 인프라, 애플리케이션 파라미터, 컨테이너 이미지, 접근 통제 정책은 Git에 추적되는 선언적 파일로부터 비롯된다. 수동 또는 명령형(imperative) 변경은 단일 원천으로 인정되지 않는다.

| 영역 | 공식 파일 경로 | 설명 및 범위 | 검증 도구 / 소비자 |
|---|---|---|---|
| **클러스터 및 네트워크 사이징** | [`configs/cluster.env`](../configs/cluster.env) | 마스터/워커 노드 IP (`192.168.77.x`), RAM 프로파일 사이징 (`BELUGA_PROFILE=64`), VM 프로바이더, MetalLB 주소 범위 (`192.168.77.200-220`), APISIX LB IP (`192.168.77.200`), 도메인 레지스트리 (`*.local.beluga.internal`). | `Vagrantfile`, `scripts/up.sh`, 노드 프로비저닝 스크립트 (`scripts/cluster/`), `scripts/gitops/01-argocd-bootstrap.sh`에서 참조. |
| **컴포넌트 및 이미지 버전** | [`VERSIONS.md`](../VERSIONS.md) | 31개 인프라·데이터 플랫폼·오퍼레이터·유틸리티 이미지의 표준 버전, 이미지 태그 (`repo:tag`), 오픈소스 라이선스의 단일 원천. | [`scripts/ci/check-version-consistency.py`](../scripts/ci/check-version-consistency.py)(Helm 템플릿 렌더 결과의 이미지 태그가 `VERSIONS.md`와 어긋나면 실패) 및 [`scripts/ci/check-license-policy.py`](../scripts/ci/check-license-policy.py)로 강제. |
| **플랫폼 Helm Values** | [`gitops/charts/beluga-platform/values.yaml`](../gitops/charts/beluga-platform/values.yaml) | 기본 도메인 (`local.beluga.internal`), APISIX 로드밸런서 IP, cert-manager 활성화 여부 및 버전, Prometheus/Grafana 포트. | `helm template gitops/charts/beluga-platform` 렌더링; ArgoCD `beluga-platform` Application이 동기화. |
| **데이터 스택 Helm Values** | [`gitops/charts/beluga-data/values.yaml`](../gitops/charts/beluga-data/values.yaml) | 기본 도메인, SeaweedFS 포트/이미지, CNPG Postgres 버전/DB명 (`shop`, `beluga_meta`), Strimzi Kafka 복제본 수/포트/인증 플래그, Lakekeeper 포트, Flink 메모리 사이징, Trino 힙/포트, Airflow 익스큐터, Superset 포트. | `helm template gitops/charts/beluga-data` 렌더링; ArgoCD `beluga-data` Application이 동기화. |
| **GitOps Application 매니페스트** | [`gitops/apps/app-of-apps.yaml`](../gitops/apps/app-of-apps.yaml)<br>[`gitops/apps/beluga-platform.yaml`](../gitops/apps/beluga-platform.yaml)<br>[`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml) | Git 저장소 URL, 브랜치 (`HEAD`), 차트 경로, 대상 네임스페이스, Server-Side Apply(SSA), automated prune, `selfHeal: true`를 지정하는 ArgoCD CRD. | [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py)로 구문 검증; [`scripts/gitops/01-argocd-bootstrap.sh`](../scripts/gitops/01-argocd-bootstrap.sh)가 부트스트랩 배포. |
| **선언적 접근 통제 정책** | [`policies/catalog.yaml`](../policies/catalog.yaml)<br>[`policies/groups.yaml`](../policies/groups.yaml)<br>[`policies/resources.yaml`](../policies/resources.yaml)<br>[`policies/roles.yaml`](../policies/roles.yaml) | 데이터 카탈로그, 사용자 그룹 (`admins`, `engineers`, `analysts`), 스키마/테이블 자원, 역할 권한을 정의하는 선언적 YAML. | [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py)로 구문 검증; 외부 컴파일러가 서비스별 네이티브 형식으로 컴파일. |

### 정책 컴파일러 산출물 및 생성 Seam

[`policies/`](../policies/) 하위의 선언적 YAML은 쿼리 엔진이나 DB가 직접 읽지 않는다. companion 리포인 **`dasomel/beluga-manager`**의 CLI 컴파일러 `policyctl`(`npm run policyctl -- compile policies --out <dir>`)이 이를 서비스 네이티브 산출물로 컴파일한다:

1. **Trino OPA Rego**: [`gitops/charts/beluga-platform/files/opa/trino.rego`](../gitops/charts/beluga-platform/files/opa/trino.rego) (package `trino`). OPA 사이드카에서 Trino 쿼리 인가 규칙을 적용.
2. **Keycloak 롤 & LDAP Seam**: `keycloak.json` (realmRoles 및 groups 할당). [`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml)의 시드 LDIF 및 init Job이 생성하는 LDAP 그룹 CN과 일치해야 함.
3. **PostgreSQL 롤 DDL**: [`gitops/charts/beluga-data/files/db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql)의 **Generated Body** (`-- BEGIN GENERATED BODY`와 `-- END GENERATED BODY` 사이 구간). NOLOGIN 롤 (`admins`, `engineers`, `analysts`), 롤 상속 (`engineers` -> `admins`, `analysts` -> `engineers`), 명시적 테이블/시퀀스 `GRANT`로 구성된다. 전후의 Prelude 및 Epilogue (LDAP 로그인 계정 `CREATE ROLE "beluga-analyst"` 등)는 수작업으로 관리된다.

이 컴파일 경계의 무결성은 `make validate`의 [`tests/14-policy-compiler-seam.sh`](../tests/14-policy-compiler-seam.sh) 스크립트가 정적으로 교차 검증한다.

---

## 2. 런타임 생성 상태 (Git 선언과의 정상 차이)

일부 클러스터 상태는 런타임에 동적으로 생성되거나 쿠버네티스 컨트롤러에 의해 기본값이 채워진다. 이 상태들은 Git 매니페스트와 차이가 발생하는 것이 정상이며 미승인 드리프트로 분류하지 않는다:

### A. 부트스트랩 및 워크로드 자격증명
- **비밀값 미커밋 원칙**: [SECURITY-ko.md](../SECURITY-ko.md)에 따라 평문 암호나 시크릿 키는 Git에 일절 커밋되지 않는다. Helm values의 기본값은 모두 `SET-AT-BOOTSTRAP` 플레이스홀더다.
- **부트스트랩 시점 생성**: [`scripts/gitops/01-argocd-bootstrap.sh`](../scripts/gitops/01-argocd-bootstrap.sh)가 `openssl rand -hex 16`을 통해 난수를 생성하고, `platform-system` 네임스페이스의 `beluga-credentials` Secret에 저장한다.
- **네임스페이스 파생 Secret**: `01-argocd-bootstrap.sh`는 워크로드 네임스페이스에 비관리(unmanaged) Secret(`postgres-admin-credential`, `keycloak-admin-credential`, `keycloak-db-credential`, `trino-keystore-password`, `ldap-admin-credential`, `ldap-reader-credential`, `trino-ldap-service-credential`, `keycloak-user-passwords`, `keycloak-client-secrets`, `superset-credential`, `apisix-admin-credential`, `trino-internal-shared-secret`, `seaweedfs-s3-credentials`)을 생성한다. 워크로드 차트는 이를 `secretKeyRef`로 읽는다. ArgoCD가 관리하는 리소스가 아니므로 `selfHeal`이 이를 삭제하거나 되돌리지 않는다.

### B. 오퍼레이터 생성 Secret 및 인증서
- **cert-manager**: [`gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml), [`gitops/charts/beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml), [`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml), [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)의 `Certificate` 커스텀 리소스에 의해 `cert-manager`가 동적 X.509 인증서를 발급하고 TLS Secret(`beluga-internal-ca-secret`, `apisix-gateway-tls-secret`, `openldap-tls-secret`, `trino-coordinator-tls-secret`)을 갱신한다. Secret 데이터(`tls.crt`, `tls.key`, `ca.crt`, `keystore.p12`)는 PKI 컨트롤러가 런타임에 동적으로 채운다.
- **CloudNativePG (CNPG)**: [`gitops/charts/beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml)의 `Cluster` 리소스 `postgres-main`은 자체 내부 자격증명 및 인증서를 관리한다. CNPG 오퍼레이터는 `postgres-main-app`, `postgres-main-superuser`, `postgres-main-ca`, `postgres-main-server` Secret을 런타임에 자동 생성하고 회전한다.

### C. 쿠버네티스 API 서버 기본값 주입 (비교 제외 대상)
- **SeaweedFS StatefulSet `volumeClaimTemplates`**: 쿠버네티스 API 서버는 `spec.volumeClaimTemplates`에 불변 기본 필드(`apiVersion`, `kind`, `spec.volumeMode: Filesystem`, `status: {phase: Pending}`)를 자동 주입한다. ArgoCD의 Server-Side Apply(SSA) 비교에서 이 필드들이 영구적인 `OutOfSync`를 유발하여 selfHeal이 무한 재시도하는 현상이 라이브 실측에서 확인되었다.
- **명시적 비교 제외 (ignoreDifferences)**: [`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml)은 `syncOptions: [- RespectIgnoreDifferences=true]`를 지정하고, 해당 필드들을 `jqPathExpressions`를 통해 `ignoreDifferences` 목록으로 등록해 SSA 드리프트 오탐을 방지한다.

### D. 동기화 시점 멱등 변경 Job (Sync Hooks)
ArgoCD sync 시점에 실행되는 일회성 Job들은 생성된 자격증명을 사용해 백엔드 상태를 변경한다:
- `db-roles-setup` ([`gitops/charts/beluga-data/templates/02c-db-roles.yaml`](../gitops/charts/beluga-data/templates/02c-db-roles.yaml)): 동기화마다 PostgreSQL에 `db-roles.sql`을 멱등하게 적용.
- `openldap-init` ([`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml)): LDAP 서비스 계정 및 그룹 시딩.
- `keycloak-clients` 및 `keycloak-users` ([`gitops/charts/beluga-platform/templates/keycloak.yaml`](../gitops/charts/beluga-platform/templates/keycloak.yaml)): Keycloak REST API로 클라이언트 시크릿 및 사용자 계정/패스워드 동기화.
- `superset-dashboard-import` ([`gitops/charts/beluga-data/templates/08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml)): 대시보드 및 데이터소스 동기화.
- `flink-sql-submit` ([`gitops/charts/beluga-data/templates/05-flink.yaml`](../gitops/charts/beluga-data/templates/05-flink.yaml)): Flink REST API (`jobs/overview`)를 사전 조회하여 동일 `pipeline.name`의 활성 잡이 있으면 제출을 건너뛰어 파이프라인 중복 생성을 방지 ([`tests/13-flink-sql-idempotent.sh`](../tests/13-flink-sql-idempotent.sh)).

---

## 3. 현재 드리프트를 탐지하는 기존 검증 체계

Beluga는 정적 사전 검증(`make validate`, CI 오프라인)과 라이브 클러스터 지속 조정(ArgoCD `selfHeal`)의 2단계 드리프트 감지 구조를 운영한다.

### 1단계: 정적 사전 드리프트 검증 (`make validate`)

| 검증 항목 | 스크립트 / 도구 | 증명 내용 및 탐지하는 드리프트 |
|---|---|---|
| **이미지 버전 불일치** | [`scripts/ci/check-version-consistency.py`](../scripts/ci/check-version-consistency.py) | `beluga-platform`과 `beluga-data` 차트를 렌더링한 후 매니페스트의 모든 이미지 태그를 스캔. [`VERSIONS.md`](../VERSIONS.md)에 선언된 버전과 불일치할 경우 실패. |
| **정책 컴파일러 Seam 드리프트** | [`tests/14-policy-compiler-seam.sh`](../tests/14-policy-compiler-seam.sh) | (1) [`policies/*.yaml`](../policies/) YAML 구문 검증.<br>(2) [`gitops/charts/beluga-platform/files/opa/trino.rego`](../gitops/charts/beluga-platform/files/opa/trino.rego) 패키지 헤더 확인.<br>(3) 형제 `beluga-manager` 체크아웃과 npm이 있으면 `policyctl`로 `policies/`를 재컴파일해 배포된 `trino.rego`와 0 diff 일치 확인. CI 밖에서 이들이 없으면 경고 후 이 단계를 건너뛰고, CI(`CI=true` / `REQUIRE_POLICY_SEAM_LIVE=1`)에서는 실패한다.<br>(4) 컴파일된 `keycloak.json`의 롤/그룹 매핑이 `openldap.yaml`의 시드 LDIF 및 init Job과 일치하는지 확인.<br>(5) 컴파일된 `roles.sql`과 [`gitops/charts/beluga-data/files/db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql)의 Generated Body가 바이트 단위로 0 diff 일치하는지 확인.<br>(6) Generated Body 내 기본 거부 원칙을 위반하는 금지 구문(`REVOKE`, `ALTER DEFAULT PRIVILEGES`) 차단.<br>(7) 규칙 변조 시 감지기가 실패하는지 자가 검증(negative self-tests) 실행. |
| **YAML 구문 무결성** | [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py) | `policies/` 및 `gitops/apps/` 디렉터리의 YAML 구문 정합성 확인. |
| **라이선스 정책 준수** | [`scripts/ci/check-license-policy.py`](../scripts/ci/check-license-policy.py) | `VERSIONS.md`의 모든 컴포넌트가 허용된 오픈소스 라이선스 정책을 준수하는지 점검. |
| **평문 식별정보 노출 차단** | [`tests/11-identity-plaintext-preflight.sh`](../tests/11-identity-plaintext-preflight.sh) | Helm 매니페스트 렌더링 결과에 평문 identity 엔드포인트(비TLS Keycloak/LDAP 등)가 노출되지 않았는지 사전 검사. |
| **TLS 인증서 인벤토리** | [`scripts/ci/check-certificate-inventory.py`](../scripts/ci/check-certificate-inventory.py) | 렌더링된 Certificate 리소스의 유효기간, 갱신 주기, DNS 이름 정합성 점검. |
| **CI 파리티 및 의존성** | [`scripts/ci/check-ci-stage-parity.py`](../scripts/ci/check-ci-stage-parity.py)<br>[`scripts/ci/check-dependency-integrity.py`](../scripts/ci/check-dependency-integrity.py) | Makefile 타깃, GitHub Actions 워크플로 단계, 문서화된 CI 단계의 일치 여부 및 고정 패키지 해시 무결성 검증. |
| **Flink DDL 멱등성** | [`tests/13-flink-sql-idempotent.sh`](../tests/13-flink-sql-idempotent.sh) | Flink SQL 파일이 안전한 멱등 DDL을 사용하는지 및 고유 `pipeline.name` 매핑 확인. |

### 2단계: 라이브 클러스터 지속 자동 조정 (ArgoCD `selfHeal`)

클러스터 런타임의 드리프트는 ArgoCD GitOps 엔진이 상시 감지하고 자동 교정한다:

1. **자동 조정 설정**: [`gitops/apps/beluga-platform.yaml`](../gitops/apps/beluga-platform.yaml) 및 [`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml)에 다음 정책이 선언되어 있다:
   ```yaml
   syncPolicy:
     automated:
       prune: true
       selfHeal: true
     syncOptions:
       - CreateNamespace=true
       - ServerSideApply=true
   ```
2. **자가 치유 (selfHeal) 동작**: `gitops/apps/`의 모든 Application은 `selfHeal: true`를 설정한다. 따라서 ArgoCD가 비교하는 필드를 Git 밖에서 바꾸면(예: 관리 대상 spec을 `kubectl edit`로 수정) 다음 조정 주기에 `OutOfSync`로 드러나고 Git 상태로 되돌려질 것으로 기대된다. 이는 설정일 뿐 검증된 동작은 아니다. `ignoreDifferences`로 제외되거나 API 서버가 기본값을 채우는 필드는 비교되지 않고, 조정은 즉시가 아니라 주기적이며, 이 저장소에는 이를 실행해 보는 테스트가 없다(이슈 #39 기준 2는 미완료).
3. **리소스 정리 (Prune)**: Git의 차트 템플릿에서 삭제된 리소스는 클러스터에서도 자동으로 삭제된다 (`prune: true`).

---

## 4. 이슈 #39 인수 기준 추적 상태

| 인수 기준 | 상태 | 구현 증적 |
|---|---|---|
| **기준 1**: Authoritative configuration sources are documented. (공식 구성 원천 문서화) | **완료 (Complete)** | 본 문서 ([`docs/configuration-sources.md`](configuration-sources.md) / [`docs/configuration-sources-ko.md`](configuration-sources-ko.md))에서 증명 및 서술. |
| **기준 2**: Material drift is detected and reported. (중대한 드리프트 탐지 및 보고) | 보류 (Pending) | 미완료; 이슈 #39 후속 작업에서 구현 예정. |
| **기준 3**: Unauthorized live changes can be distinguished from expected generated state. (정상 생성 상태와 미승인 변경 구분) | 보류 (Pending) | 미완료; 이슈 #39 후속 작업에서 구현 예정. |
| **기준 4**: Reconciliation procedure is repeatable. (재현 가능한 복구 절차 정의) | 보류 (Pending) | 미완료; 이슈 #39 후속 작업에서 구현 예정. |
| **기준 5**: Drift evidence is retained for operational review. (운영 검토용 드리프트 증적 보존) | 보류 (Pending) | 미완료; 이슈 #39 후속 작업에서 구현 예정. |
