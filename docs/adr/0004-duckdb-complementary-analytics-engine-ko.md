# ADR-0004: DuckDB를 보완적 경량 분석 엔진으로 도입

- Status: Accepted
- Date: 2026-10-07
- Supersedes: —
- Superseded by: —

Refs #61. 소유자 결정: DuckDB를 Trino **옆에** 도입한다(대체 아님). 이 ADR은 결정과 도입
계획만 기록하며 매니페스트, 코드, `VERSIONS.md`는 변경하지 않는다.

## 배경

Trino는 Iceberg 데이터 플레인의 유일한 SQL 엔진이다(`06-trino.yaml`). 공유, 동시 접속,
연합, BI 워크로드에는 적합하지만 상시 구동되는 분산 JVM 서비스다. 로컬, ad-hoc, 노트북,
CI 검증, 소규모 ETL/ELT에는 특히 작은 프로파일에서 비용이 과하다.

현재 경로의 보안 구조가 이 결정에 중요하다.

- **카탈로그**: Trino는 자체 OIDC 클라이언트로 Lakekeeper에 인증한다
  (`iceberg.rest-catalog.security=OAUTH2`, Keycloak client-credentials, scope `lakekeeper`,
  principal `service-account-trino`). Lakekeeper는 모든 카탈로그 호출을 OpenFGA로 인가한다
  (`values.yaml`의 `lakekeeper.openfga.enabled: true`, D14는 `allowall`을 옵트아웃으로만 유지).
- **스토리지**: Trino는 정적 S3 키(`trino-s3-credential`, `06-trino.yaml`의
  `s3.aws-access-key`)도 보유한다. 이 키는 보유자에게 카탈로그 인가를 우회하는 경로다.
  DuckDB는 이 패턴을 **따라 하지 않는다**.
- **네트워크**: `04b-lakehouse-network-policy.yaml`은 Lakekeeper `:8181` 인그레스를 Trino,
  Flink, APISIX, bootstrap job에만 허용한다. Airflow는 의도적으로 빠져 있다
  (`07-airflow.yaml`에 Lakekeeper 참조 없음).

## 공식 문서가 말하는 것 (2026-10-07 접근)

| 주제 | 문서 내용 | 출처 |
|---|---|---|
| 카탈로그 attach | `ATTACH 'warehouse' AS x (TYPE ICEBERG, SECRET s, ENDPOINT 'url')`; 카탈로그에 attach된 테이블이 전체 기능을 제공 | [catalogs](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html), [overview](https://duckdb.org/docs/current/core_extensions/iceberg/overview) |
| 인증 | OAuth2 client credentials는 `CREATE SECRET (TYPE ICEBERG, CLIENT_ID, CLIENT_SECRET, OAUTH2_SERVER_URI[, OAUTH2_SCOPE])`; bearer는 `TOKEN`; AWS는 `sigv4` | 동일 catalogs 페이지 |
| Lakekeeper | catalogs 페이지에 위 OAuth2 secret을 쓰는 Lakekeeper 예제가 있고, Lakekeeper는 DuckDB를 지원 엔진으로 나열한다 | catalogs 페이지; [Lakekeeper docs](https://docs.lakekeeper.io/), [engines](https://docs.lakekeeper.io/docs/latest/engines/) |
| Vended credentials | DuckDB는 Polaris 예제에서 `ACCESS_DELEGATION_MODE 'vended_credentials'`를 문서화한다. Lakekeeper engines 페이지는 읽은 바로는 DuckDB의 vended credentials를 명시적으로 다루지 않으며 별도 S3 자격증명을 전제하는 것으로 보인다 | catalogs 페이지; Lakekeeper engines 페이지 |
| 스토리지 백엔드 | "DuckDB supports Iceberg REST Catalogs backed by S3, S3 Tables, and Google Cloud Storage (GCS). Support for other storage backends is not yet available." | catalogs 페이지 |
| S3 호환 | S3 secret에 `ENDPOINT`, `URL_STYLE`(`path`), `USE_SSL`; SeaweedFS는 "should also work, but not all features may be supported"로 명시 | [S3 API](https://duckdb.org/docs/current/core_extensions/httpfs/s3api) |
| 쓰기 | REST 카탈로그 attach 시 지원: INSERT/UPDATE/DELETE/MERGE, DDL, 스키마 진화, Iceberg format v2/v3. merge-on-read만(positional delete); 다른 `write.update.mode`/`write.delete.mode` 테이블은 실패; 파티션 테이블에서 일부 target-size 속성 미지원. 동시성/커밋 의미론은 상세 기술 없음 | [writing](https://duckdb.org/docs/current/core_extensions/iceberg/writing.html) |
| 직접 읽기 | 읽기 전용; version hint 또는 명시 `version` 필요; gzip 메타데이터만 | overview |
| 호환 플래그 | REST 부분 지원 카탈로그용 `STAGE_CREATE_TABLES`, `DISABLE_MULTI_TABLE_COMMIT` 등 | catalogs 페이지 |
| 라이선스 | MIT (Copyright Stichting DuckDB Foundation) | [LICENSE](https://github.com/duckdb/duckdb/blob/main/LICENSE) |
| 릴리스 | 일정은 잠정; 1.4.0부터 격 버전이 LTS(1.4.0 LTS 커뮤니티 지원 2026-11-17까지); 최신 표기 1.5.6(2026-09-28); 2.0.0 잠정 2026-10-21 | [release calendar](https://duckdb.org/release_calendar.html) |

**실험적 상태.** overview 페이지에는 읽은 바로는 iceberg 확장에 대한 실험적 경고가 없다. 경고가
없다는 것이 안정성 보장은 아니다. 문서로 확인하지 못해 PoC(작업 5) 전까지 **Beluga에서는 미검증**
으로 취급한다: (a) Beluga Keycloak 대상 Lakekeeper + OAuth2 attach, (b) SeaweedFS에서 Lakekeeper
vended credentials(SeaweedFS S3는 "not all features may be supported", 스토리지 한계 문구는
S3/S3 Tables/GCS만 명시), (c) 동시성 하의 Lakekeeper 쓰기 커밋. 2.0.0이 임박해 확장 동작이 바뀔 수
있으므로 버전을 고정한다.

## 결정

1. DuckDB를 **보완적** 임베디드 쿼리 엔진으로 도입한다. Trino는 지원되는 중앙 엔진으로 유지하며
   제거나 폐기는 없다.
2. DuckDB는 상시 서비스가 아니라 **클라이언트/잡에 임베디드**로 실행한다. DuckDB/Quack 서버
   모드는 범위 밖이며 임베디드 경로 검증 후 별도 평가한다.
3. DuckDB는 **Lakekeeper를 통해서만** Iceberg에 접근한다(`ATTACH ... TYPE iceberg`). 따라서
   Trino, Flink와 동일하게 OpenFGA가 인가한다.
4. **읽기 전용 우선.** 쓰기 한계와 동시성 동작이 증거로 확인된 뒤(작업 8) 사용 사례별로 활성화한다.
5. 워크로드 선택은 아래 표를 따른다. 애매하면 Trino.

### DuckDB vs Trino

| 워크로드 | 엔진 | 이유 |
|---|---|---|
| 단일 사용자 노트북 / ad-hoc 탐색 | DuckDB | 공유 클러스터 불필요 |
| Iceberg 데이터/스키마 계약 CI 검증 | DuckDB | 수 초 기동, Trino 워커 불필요 |
| 단일 노드에 들어가는 테이블의 Airflow 소규모 변환 | DuckDB | DAG가 Trino에 의존하지 않음 |
| Trino 워커 없는 로컬/최소 Beluga 프로파일 | DuckDB | 상시 JVM 서비스 제거 가능 |
| BI 대시보드(Superset), 다수 동시 사용자 | Trino | 동시성과 공유 거버넌스 |
| 카탈로그/소스 간 연합 쿼리 | Trino | 커넥터 |
| 단일 노드 메모리/디스크를 넘는 스캔 | Trino | 분산 실행 |
| Trino OPA 계층의 행/열 정책이 적용되는 데이터 | Trino | DuckDB는 해당 계층 밖(보안 참조) |
| 스트리밍 쓰기, 고빈도 커밋 | Flink | DuckDB 대상 아님 |

## 보안 요구사항 (규범)

1. DuckDB 클라이언트는 **자체 OIDC 클라이언트**로 인증한다(운영 형태별 별도 Keycloak
   client-credentials 클라이언트, 예: `duckdb-airflow`, `duckdb-ci`). Trino/Flink 클라이언트를
   재사용하지 않는다. 사람의 노트북 사용은 OpenFGA가 실제 사용자를 보도록 사용자 범위 토큰(bearer
   `TOKEN`)이 바람직하며 최종 선택은 Q2.
2. 인가는 Lakekeeper를 경유한 **OpenFGA**가 결정한다. 각 DuckDB principal은 기존 principal과 같은
   모델에서 명시적 **테이블 단위** 읽기 grant를 받는다. 웨어하우스/네임스페이스 단위 grant는 금지한다.
   Lakekeeper가 `select`를 하위 모든 테이블로 상속하고
   ([authorization-openfga](https://docs.lakekeeper.io/docs/latest/authorization-openfga/)),
   `lake` 네임스페이스에 PII 테이블이 있기 때문이다(`policies/resources.yaml`에서 `lake.customers`는
   `classification: pii`이며 Trino OPA가 롤별로 마스킹/거부). PII 테이블은 제외한다. `allowall` 폴백 금지.
3. DuckDB 잡, 노트북, CI에 **정적 관리자 S3 키 금지**. 스토리지 접근은 Lakekeeper가 발급한
   자격증명(vended)이어야 한다. 현재 `lake` 웨어하우스는 `"sts-enabled": false`와 정적 액세스 키로
   생성되며(`12-lakekeeper-bootstrap.yaml`), Lakekeeper 문서는 발급이 STS 기반이고 "not all S3
   compatible object stores support AssumeRole"라고 밝힌다
   ([storage](https://docs.lakekeeper.io/docs/latest/storage/)). 따라서 발급은 **현재 불가**하다.
   SeaweedFS가 범위 제한 자격증명을 발급하지 못하면(작업 1에서 결정) 공유 정적
   키로 폴백하지 않고 운영/PII 데이터에 대해 DuckDB를 보류한다(버킷 범위 키는 같은 `beluga-lake`
   버킷의 PII 파일을 Lakekeeper 인가 없이 읽을 수 있어 테이블 단위 grant를 무력화한다). 허용되는
   정적 키는 합성 데이터를 담은 **전용 비-PII 테스트 웨어하우스/버킷**으로 범위가 제한된 키뿐이며
   PoC와 CI 검증에만 쓴다. 그 외 예외는 새 ADR이 필요하다. 기존 Trino 정적 키는
   알려진 갭이며 이 ADR이 이를 넓히지 않는다.
4. 시크릿은 다른 클라이언트 시크릿과 같은 방식(`keycloak-client-secrets` 패턴, ADR-0002)으로
   전달한다. 커밋 금지, 노트북 출력 노출 금지.
5. 네트워크: DuckDB 클라이언트 파드는 `lakekeeper:8181` 인그레스(`lakekeeper-ingress`는 현재
   trino, flink, apisix, bootstrap만 명시), 토큰용 Keycloak 이그레스, `seaweedfs-s3:8333` 이그레스가
   필요하다. 클러스터 내 형태마다 명시적 허용 규칙을 두고 네임스페이스 전체를 열지 않는다.
6. DuckDB는 Trino OPA 계층(`trino.rego`) 밖에 있다. 그곳에서만 강제되는 행 필터, 열 마스킹은
   DuckDB에는 **적용되지 않는다**. 동등한 통제가 증명되기 전까지 DuckDB principal에는 그런 정책이
   없는 데이터에만 grant한다.
7. 회귀 테스트(작업 7): 미인가 principal은 카탈로그에서 거부, PII 테이블 `lake.customers`는 다른
   네임스페이스뿐 아니라 DuckDB 클라이언트에 **거부**, 읽기 전용 principal은 쓰기 불가, 클라이언트
   환경에 관리자 S3 키 없음. 실제 `lake.customers` 거부 테스트는(테이블 단위 grant가 PII를 제외하므로)
   **자격증명 발급 여부와 무관하게 필수**이며, 작업 2의 PII 테스트 테이블은 예외 PoC에서만 이를
   대체할 뿐 운영 접근의 완료 증거가 될 수 없다.

## 운영 형태

| 형태 | 1단계 | 비고 |
|---|---|---|
| 개발자 머신의 CLI / Python에서 클러스터 접근 | 2단계 | 1단계 아님: 웨어하우스 S3 엔드포인트가 클러스터 내부 DNS(`seaweedfs-s3.storage.svc.cluster.local:8333`, `12-lakekeeper-bootstrap.yaml`)라 노트북은 카탈로그에는 닿아도 데이터 파일에는 닿지 못할 수 있다. S3 엔드포인트 도달성 또는 vended 엔드포인트 오버라이드 경로를 먼저 설계해야 함 |
| CI 검증 | 예(읽기 전용), 클러스터 내부 또는 테스트 스택 | 러너가 Lakekeeper와 S3 엔드포인트 모두에 닿아야 함; 임시 클라이언트; 테스트 웨어하우스 |
| 노트북 | 2단계 | 현재 Beluga에 노트북 서비스 없음 |
| Airflow 태스크 | 2단계 | Lakekeeper 인그레스 규칙과 전용 클라이언트 필요; 자격증명 발급 증명에 의존하며 기본값으로 #70에도 의존(Q5) |
| 소규모 ETL/ELT 쓰기 | 3단계 | 작업 8 이후에만 |
| DuckDB/Quack 서버 모드 | 범위 밖 | 별도 평가 |

#70(메달리온) 의존: DuckDB가 읽거나 쓸 수 있는 레이어(예: bronze/silver 읽기, 지정된 샌드박스 또는
gold 네임스페이스에만 쓰기)는 메달리온 네임스페이스 구성이 정한다. 작업 1-7는 #70에 의존하지 않고,
작업 8과 Airflow 형태는 의존한다. 기본값: 소유자가 Q5에 "샌드박스 우선"이라 답하지 않는 한 Airflow
형태는 #70을 기다린다.

## 검토한 대안

- **아무것도 하지 않음** — 소유자 결정으로 기각. 경량 프로파일이 계속 Trino 비용을 부담한다.
- **Trino를 DuckDB로 대체** — 기각: DuckDB는 단일 프로세스 내 동시 쿼리는 지원하지만 공유 다중 사용자
  서버/BI 서비스 모델, 연합, 분산 실행이 없고 Superset과 OPA 강제 경로가 깨진다.
- **정적 S3 키로 Parquet/Iceberg 직접 읽기** — 기각: Lakekeeper/OpenFGA와 ADR-0002 자격증명
  모델을 우회한다.
- **DuckDB 서버 모드 공유 서비스** — 보류: 상시 서비스를 다시 만들고 별도 authn/authz 설계가 필요.
- **PyIceberg / Spark 로컬 모드** — 여기서는 평가하지 않음. 더 무겁거나 SQL 지향이 약하다. PoC 실패 시
  재검토.

## 결과

- 경량 프로파일과 CI가 Trino 워커 없이 분석을 실행할 수 있다.
- 문서화, 버전 고정, 테스트할 엔진이 하나 늘고 사용자가 따라야 할 결정 표가 생긴다.
- 거버넌스 적용 범위가 불균일하다: Lakekeeper/OpenFGA는 두 엔진 모두, Trino OPA 정책은 Trino만
  (보안 6).
- 구현 시점에 `VERSIONS.md`에 DuckDB와 고정된 `iceberg` 확장(MIT) 행이 필요하다. 이 PR에서는 수정하지
  않는다.
- 임박한 2.0.0에서 확장이 깨질 수 있으므로 버전 고정과 회귀 테스트가 필수다.

## 리스크

| 리스크 | 완화 |
|---|---|
| iceberg 확장 성숙도 / Lakekeeper 상호운용이 Beluga에서 미검증 | PoC 우선(작업 5), 버전 고정 |
| SeaweedFS에서 vended credentials가 동작하지 않을 수 있음 | 운영/PII 경로의 클러스터 내 형태 전에 증명, 아니면 보류(보안 3). 유일한 예외는 비-PII 테스트 버킷 키(작업 1) |
| 쓰기 한계: merge-on-read만, 다른 쓰기 모드에서 실패, 동시성 미문서화 | 읽기 전용 우선, 증거 후 쓰기 |
| 편의를 위한 원시 S3 키 우회 | 운영/PII 경로의 DuckDB 클라이언트에 S3 secret이 없음을 CI로 검사. 문서화된 비-PII 테스트 키 예외는 이 검사에서 제외되나 해당 키가 테스트 버킷으로만 범위 제한됨을 CI로 검증해야 함; 문서화 |
| 사용자가 워크로드에 잘못된 엔진 선택 | 사용자 문서의 결정 표 |
| Lakekeeper 인그레스 개방으로 공격면 확대 | 클라이언트당 규칙 하나, 기존 규칙과 동일 수준 리뷰 |

## 후속 구현 작업 (순서)

1. **스토리지 자격증명 결정(PoC의 선행 조건)**: SeaweedFS가 STS/AssumeRole을 지원해 웨어하우스에서
   `sts-enabled`를 켜고 범위 제한 자격증명을 발급할 수 있는지 확인한다. 불가하면 Q1 결정을 기록한다:
   PoC와 CI는 전용 비-PII 테스트 버킷(작업 2)으로 범위가 제한된 정적 키만 사용하고, 운영/PII 데이터는
   발급이 가능해질 때까지 보류한다. 수용 기준: 소유자 결정 기록과 증거(SeaweedFS STS 호출 결과 또는
   테스트 키의 버킷/프리픽스 제한).
2. 합성 데이터를 담은 **전용 비-PII 테스트 웨어하우스/버킷**(거부를 증명하기 위해 PII로 표시한
   `customers` 유사 테이블 포함). 수용 기준: Lakekeeper에 웨어하우스가 존재하고 버킷에 운영 데이터가 없다.
3. `duckdb-*` 테스트 principal용 **Keycloak 클라이언트 + OpenFGA grant**: 읽기 전용, **테이블 단위**,
   PII 테이블 제외. 수용 기준: grant된 테스트 테이블은 읽고 PII 테스트 테이블과 다른
   웨어하우스/네임스페이스는 Lakekeeper가 거부.
4. **네트워크 정책**(규칙은 적용 대상 파드가 있는 곳에 둔다; DuckDB 클라이언트는 `lakehouse` 밖에 있을
   수 있다): (a) `lakehouse/lakekeeper:8181` **인그레스** — `04b-lakehouse-network-policy.yaml`의
   `lakekeeper-ingress`에 DuckDB 클라이언트의 네임스페이스/파드 셀렉터 추가; (b) 클라이언트 파드
   네임스페이스에서 `iam/keycloak:8080`(토큰)으로의 **이그레스**; (c) 클라이언트 파드 네임스페이스에서
   `storage/seaweedfs-s3:8333`으로의 **이그레스**(`storage`가 적용하는 인그레스 정책이 있으면 함께).
   수용 기준: `make validate` 통과, 목록에 없는 파드의 연결은 거부.
5. **PoC attach**(작업 1-4 선행 완료): DuckDB CLI가 전용 클라이언트로 Lakekeeper에 attach해 테스트
   테이블 하나를 읽는다. 작업 1에서 발급이 증명되면 vended 자격증명, 아니면 테스트 버킷 범위 키를 사용.
   수용 기준: 같은 데이터에서 행 수가 Trino 결과와 일치; 정확한 DuckDB/확장 버전 기록.
6. **VERSIONS.md 행 + 문서**: 버전 고정, 사용자 문서(en/ko)의 결정 표와 사용 레시피.
7. **보안 회귀 테스트**: 미인가 거부, 실제 `lake.customers` PII 테이블은 **발급 여부와 무관하게** DuckDB
   클라이언트에 거부(작업 2의 PII 테스트 테이블은 예외 PoC 안에서만 대체), 읽기 전용은 쓰기 불가,
   클라이언트 환경에 관리자 S3 키 없음, 테스트 버킷 키를 쓰는 경우 해당 키가 테스트 버킷으로만 범위
   제한됨을 검증. 수용 기준: CI에서 실행.
8. **쓰기 증거**: 샌드박스 네임스페이스에 INSERT/MERGE, Trino 또는 Flink 읽기와 동시 커밋. 수용 기준:
   결과와 한계 문서화; 네임스페이스는 #70에 의존.
9. 테스트 웨어하우스 대상 DuckDB 읽기 전용 **CI 검증 잡**. 수용 기준: Trino 워커 없이 스키마 계약 검사
   통과.
10. **벤치마크**(이슈 #61 기준): 지원 프로파일에서 동일 워크로드로 DuckDB vs Trino의 CPU, 메모리, I/O,
    기동, 지연, 동시성 비교. 수용 기준: 사이징 목표를 포함한 보고서.
11. **로컬 CLI 경로 설계 후 Airflow 태스크 형태**(2단계; 소유자가 Q5에 "샌드박스 우선"이라 답하지
    않는 한 Airflow 형태는 #70을 기다린다). 수용 기준: 노트북이 문서화된 경로로 카탈로그와 데이터 파일
    모두에 도달; DAG 태스크가 자체 클라이언트로 테이블을 읽는다.
## 열린 소유자 질문

| ID | 질문 | 중요한 이유 |
|---|---|---|
| Q1 | SeaweedFS에서 STS/vended 자격증명을 지원하게 만들 수 있는가? 불가하면 DuckDB를 전용 비-PII 테스트 웨어하우스/버킷(정적 범위 제한 키)으로 한정하고 발급이 가능해질 때까지 운영/PII 데이터는 보류하는 것을 확정하는가? | 보안 3: 운영/PII 데이터는 vended 자격증명이 필요하며 그 외 예외는 새 ADR이 필요하다. |
| Q2 | 사람의 노트북/CLI 인증: 사용자 bearer 토큰(OpenFGA에 실제 사용자 반영) 대 팀 공용 클라이언트? | 감사 귀속. |
| Q3 | DuckDB가 우회하게 될 현재 Trino-OPA 행/열 정책은 무엇이며, 그래서 접근 불가인 데이터셋은? | 보안 6. |
| Q4 | 1.4 LTS(지원 2026-11-17까지)에 고정할지, 2.0.0 이후 2.x로 이동할지? | 릴리스 주기 대 확장 안정성. |
| Q5 | 기본값: Airflow 형태는 #70을 기다린다. "샌드박스 우선"이라 답하면 샌드박스 네임스페이스로 먼저 진행한다. | 2단계 범위. |
