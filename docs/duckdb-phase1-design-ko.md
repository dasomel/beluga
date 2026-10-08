# DuckDB 1단계 상세 설계: Iceberg 경계, 라우팅, 보안 및 워크플로우

[English](duckdb-phase1-design.md) | 한국어

Refs #62 #63 #64 #65 #66 #67 #68 #69.

> **상태: 제안 (PROPOSAL). 문서 전용.**
> 이 설계 문서는 [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)에서 확정된 도입 프레임워크를 구체화하며, 기존의 어떠한 결정도 변경하지 않는다. 이 문서와 ADR-0004 간의 모든 불일치는 열린 소유자 질문으로 다룬다. 어떠한 매니페스트, 컨테이너 이미지, Helm 값, `VERSIONS.md` 행도 이 문서로 인해 수정되지 않는다.

---

## ADR-0004와의 관계 및 아키텍처 범위

[ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)는 DuckDB를 Trino를 대체하는 엔진이 아니라, Trino와 함께 병행 구동되는 **보완적 임베디드 분석 엔진**으로 채택하기로 결정했다. 1단계는 읽기 전용 CI/PoC, 로컬 CLI/노트북과 Airflow는 2단계, 쓰기는 3단계다. 단계 게이트 및 소유자 질문은 ADR-0004가 우선한다.

이 문서는 8개 영역에 걸친 후속 이슈(#62~#69)에 대한 구체적인 기술 설계 사양을 제공한다:
1. **[이슈 #62](#1-iceberg-호환성-매트릭스-및-안전한-쓰기-경계-이슈-62)**: Iceberg 호환성 매트릭스 및 안전한 읽기/쓰기 경계 정의.
2. **[이슈 #63](#2-쿼리-워크로드-라우팅-및-trino-폴백-정책-이슈-63)**: 단계별 최초 라우팅, fail-closed 오류 및 명시적 사용자 재제출.
3. **[이슈 #64](#3-임베디드-duckdb를-위한-통제된-자격증명-및-접근-경로-이슈-64)**: 통제된 인증, Lakekeeper OpenFGA 인가 및 시크릿 전달 패턴.
4. **[이슈 #65](#4-trinoduckdb-결과-일관성-및-벤치마크-스위트-이슈-65)**: 의미론적 동등성 검증 규칙 및 재현 가능한 벤치마크 방법론.
5. **[이슈 #66](#5-ci-airflow-및-재현-가능한-로컬-워크플로우-통합-이슈-66)**: CI, Airflow 태스크 및 개발자 워크스테이션을 위한 실행 경로.
6. **[이슈 #67](#6-엔진-수준-메트릭-및-리소스-귀속-이슈-67)**: 정형화된 실행 이벤트, 텔레메트리 발행 및 Prometheus 메트릭.
7. **[이슈 #68](#7-결과-재사용-디스크-스필-및-임시-데이터-수명주기-이슈-68)**: 임시 스크래치 파일, 디스크 스필 한도, 캐시 무효화 및 PII 격리.
8. **[이슈 #69](#8-quack-원격-프로토콜-평가-게이트-이슈-69)**: DuckDB Quack 서비스 모드 검토를 위한 엄격한 평가 게이트 기준.

### 규범적 보안 가드레일 (ADR-0004 상속)

이 문서의 모든 제안은 [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)에서 수립된 타협 불가능한 보안 요구사항을 엄격하게 준수한다:
- **독립된 OIDC 식별자**: DuckDB 클라이언트는 `service-account-trino` 또는 `service-account-flink`를 재사용하지 않고, 자체 전용 Keycloak OIDC 클라이언트 자격증명(`duckdb-ci`, `duckdb-airflow`)을 사용해 인증한다.
- **테이블 단위 grant만 허용**: Lakekeeper를 경유하는 OpenFGA grant는 반드시 명시적인 테이블 단위로 제한되어야 한다. 웨어하우스 단위나 네임스페이스 단위 grant는 Lakekeeper가 하위 모든 테이블로 `select` 권한을 상속하므로 엄격히 금지된다. 상속이 허용되면 [`policies/resources.yaml`](../policies/resources.yaml)에서 `classification: pii`로 지정된 PII 테이블(`lake.customers`)이 노출되기 때문이다.
- **정적 관리자 스토리지 자격증명 금지**: 운영 환경이나 PII 경로의 DuckDB 클라이언트에 정적 관리자 S3 액세스 키를 전달해서는 안 된다. 운영 데이터 접근에는 Lakekeeper가 발급하는 vended 자격증명이 필수다. 유일하게 허용되는 정적 키는 CI 및 PoC 검증을 위해 합성 데이터만 보관하는 전용 비-PII 테스트 버킷(`beluga-test`)으로 범위가 엄격히 제한된 키뿐이다.
- **엄격한 네트워크 격리**: Kubernetes NetworkPolicy는 기본 차단(default-deny)을 강제하며, 명시적으로 레이블이 지정된 DuckDB 클라이언트 파드에 대해서만 `lakekeeper:8181`, `keycloak:8080`, `seaweedfs-s3:8333` 통신을 허용한다.
- **읽기 전용 우선**: 쓰기 안전성과 커밋 동시성 동작이 실측 증거로 확인되기 전까지 DuckDB는 Lakekeeper 카탈로그 테이블에 대해 읽기 전용 상태를 유지한다.

---

## 1. Iceberg 호환성 매트릭스 및 안전한 쓰기 경계 (이슈 #62)

### 1.1 목적 및 수용 기준 매핑
이슈 #62는 지원되는 DuckDB 및 Apache Iceberg 호환성 매트릭스를 정의하고, 읽기 전용 워크로드와 쓰기 워크로드를 분리하며, 쓰기 적격성 기준을 수립하고, 미지원 변경에 대한 음성(negative) 테스트를 추가하며, 스냅샷 커밋 의미론을 검증하고, Trino/Flink가 변경 권한을 갖는 정식 경로로 유지됨을 확정할 것을 요구한다.

### 1.2 현재 상태 (검증됨)
- **카탈로그 구성**: Trino의 Iceberg 카탈로그는 [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)에 구성되어 있다. `lake` 웨어하우스의 Lakekeeper REST 카탈로그(`http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog`)에 연결되며, Keycloak(`http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token`) 대상 OAuth2 클라이언트 자격증명을 사용하고 정적 S3 키(`s3.aws-access-key=${ENV:TRINO_S3_ACCESS_KEY}`)를 보유한다.
- **Lakekeeper 웨어하우스**: Lakekeeper의 `lake` 웨어하우스는 [`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml)에서 `"sts-enabled": false`와 정적 자격증명으로 생성되어 버킷 `beluga-lake`를 가리킨다.
- **데이터 분류**: [`policies/resources.yaml`](../policies/resources.yaml)에서 `lake.events_enriched`와 `lake.orders`는 `classification: internal`로 지정되어 있고, `lake.customers`는 민감한 컬럼 `email`을 포함하여 `classification: pii`로 지정되어 있다.
- **공식 변경 엔진**: Flink가 스트리밍 CDC 수집을 담당하고(`14-flink-jobs.yaml`), Trino가 [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py)의 배치 컴팩션 및 유지보수 작업을 담당한다.
- **라이브 증거 범위**: 원 PR이 2026-10-08 Running 파드를 보고했다. 이번 수정은 배포/서비스 인벤토리를 읽기 전용으로 재확인했다(6.2절). 인증된 DuckDB 질의나 런타임 호환성은 재검증하지 않았다.

### 1.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB Iceberg 개요** ([`https://duckdb.org/docs/current/core_extensions/iceberg/overview`](https://duckdb.org/docs/current/core_extensions/iceberg/overview)): `iceberg_scan`을 통한 직접 테이블 읽기는 읽기 전용이며 메타데이터 버전 힌트(`version-hint.text` 또는 명시적 `version`)가 필요하다. Iceberg REST 카탈로그를 attach(`ATTACH ... TYPE iceberg`)하면 카탈로그 관리형 테이블을 전체 기능으로 접근할 수 있다.
- **DuckDB Iceberg 쓰기** ([`https://duckdb.org/docs/current/core_extensions/iceberg/writing`](https://duckdb.org/docs/current/core_extensions/iceberg/writing)): 쓰기는 attach된 REST 카탈로그를 통해서만 지원된다. 지원 작업: `CREATE TABLE`(파티셔닝: identity, year, month, day, hour, bucket, truncate), `INSERT INTO`(`BY NAME` 포함), `UPDATE`, `DELETE`, `MERGE INTO`, 스키마 진화(`ALTER TABLE ADD/DROP/RENAME/ALTER COLUMN`).
  - *문서화된 한계 1*: `UPDATE` 및 `DELETE`는 **positional delete** 파일만 작성하며 copy-on-write는 지원하지 않는다.
  - *문서화된 한계 2*: `UPDATE` 및 `DELETE`는 **merge-on-read** 의미론만 지원한다. 테이블의 `write.update.mode` 또는 `write.delete.mode`가 다른 값으로 설정되어 있으면 실행이 실패한다.
  - *문서화된 한계 3*: 파티션된 테이블에서는 `write.target-file-size-bytes` 및 `write.parquet.row-group-size-bytes` 속성을 적용할 수 없어 에러가 발생한다(각 속성에 맞는 `ignore_target_file_size_for_partitioned_tables` 또는 `ignore_row_group_size_for_partitioned_tables` 플래그를 `true`로 설정해야 무시됨).
- **DuckDB Iceberg 문제 해결** ([`https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting`](https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting)): DuckDB 1.4 LTS 공식 문서의 한계(Limitations) 절에 다음과 같이 명시되어 있다: *"Reading tables with deletes is not yet supported."* (삭제가 포함된 테이블 읽기는 아직 지원되지 않음).
- **동시성 및 커밋**: Trino/Flink의 동시 변경 작업 중에 Lakekeeper REST 카탈로그를 통한 커밋 충돌 해결 및 재시도 의미론은 **미검증(UNVERIFIED)** 상태이다 ([ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md) 기록).

### 1.4 수용 기준 대비 격차
1. Beluga에 DuckDB가 질의하거나 변경할 수 있는 Iceberg 테이블 사양을 규정하는 공식적인 버전 고정 호환성 매트릭스 문서가 없다.
2. positional delete가 포함된 테이블에 대한 DuckDB 읽기 호환성이 미검증 상태이며, DuckDB 1.4 LTS에서는 실패하는 것으로 문서화되어 있다.
3. DuckDB가 공유 운영 테이블(`lake.*`)에 변경 쿼리를 실행하지 못하도록 막는 쓰기 경계 및 검증 로직이 없다.
4. 실패하거나 중단된 DuckDB 쓰기 작업에 대한 자동 롤백 및 정리 절차가 정의되지 않았다.

### 1.5 제안 (Proposed)

<!-- D1: ADR-0004 단계를 보존해 쓰기 인가의 암묵적 확대 방지; 비용: 쓰기 도입 지연; 탈출구: 소유자 결정과 작업 8 증거. -->

| 기능 | 공식 문서 범위 | Beluga 1단계 허용 범위 |
|---|---|---|
| 카탈로그 attach 읽기, 파티션/비파티션 | 문서화됨; 고정 런타임·확장·포맷별 검증 필요 | vending 게이트 전까지 인가된 합성 비-PII 테스트 테이블만 |
| 삭제 포함 테이블 | 1.4 LTS 읽기 제한; positional delete와 Iceberg v3 deletion vector는 별개 | 정확한 고정 조합의 동등성 검증 전 fail-closed; “1.5+”만으로 지원 추론 금지 |
| 직접 경로 `iceberg_scan` | 업스트림 읽기 전용 경로 | 디버깅을 포함한 통제 데이터 접근 금지: Lakekeeper/OpenFGA 우회 |
| INSERT, UPDATE, DELETE, MERGE, DDL | 현재 쓰기 문서에 REST 카탈로그 작업과 제한 명시 | 샌드박스를 포함한 모든 쓰기 1단계 차단 |
| 스트리밍/고빈도 커밋 | DuckDB 도입 대상 아님 | Flink 변경 경로 유지 |

1단계는 읽기 전용 OpenFGA 테이블 권한과 허용된 읽기로 제한한 스토리지 자격증명을 사용한다. SQL 래퍼는 보조 방어이며 카탈로그/스토리지 인가를 대체하지 못한다. 정적 테스트 버킷 키 예외는 객체 스토어의 테이블 단위 거부를 보장하지 못하므로 합성 데이터에만 제한하고 운영 격리의 증거로 쓰지 않는다.

샌드박스/파생 쓰기는 **3단계 소유자 질문**이며 ADR 작업 8 동시성 증거와 #70이 선행한다. 네임스페이스 이름만으로 쓰기를 허용하지 않는다. 기존 [유지보수 DAG](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py)는 `optimize`와 `expire_snapshots`만 실행하며 고아 파일 제거를 수행하지 않는다. 미커밋 파일 회수, 보존 안전성, 소유권 및 동시 작성자 보호는 쓰기 활성화 전 별도 설계가 필요하다. 메타데이터 원자 커밋은 객체 자동 회수의 증거가 아니다.

### 1.6 검증 및 테스트 아이디어
- 동일 스냅샷의 합성 데이터 읽기 동등성, DuckDB·확장 정확한 버전 기록.
- positional delete와 지원되는 deletion vector를 별도 fixture로 검증; 미지원 읽기는 불완전 결과 대신 실패.
- 테스트/운영 카탈로그의 1단계 쓰기를 모두 거부하는 음성 테스트.
- 3단계 전용: copy-on-write 거부, 동시 커밋/재시도, 중단 및 안전한 고아 파일 회수 실험.

### 1.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-62-1 | 3단계에서 어떤 샌드박스/파생 쓰기를 평가할 것인가? | 1단계 쓰기는 모두 차단; #70 및 작업 8 이후 결정 | ADR-0004 우선 |
| OD-62-2 | 어떤 런타임·확장을 고정할 것인가(ADR Q4)? | 고정 버전 동등성 증거로 결정 | 1.5+ 삭제/벡터 지원 주장 없음 |

### 1.8 후속 구현 작업
1. **T-62-1**: 합성 fixture로 버전 고정 읽기 호환성 스위트 구현; 오류/미지원 결과는 CI 실패.
2. **T-62-2**: 샌드박스를 포함한 모든 1단계 쓰기 인가 음성 테스트; 3단계 쓰기 승인·회수는 보류.

---

## 2. 쿼리 워크로드 라우팅 및 Trino 폴백 정책 (이슈 #63)

### 2.1 목적 및 수용 기준 매핑
이슈 #63은 DuckDB로 충분한 경우 DuckDB를 우선하고, 중앙 거버넌스, 분산 실행, BI 동시성이 요구되는 경우 Trino로 폴백하는 결정론적 워크로드 라우팅 정책을 수립하고, 수동 재정의 및 텔레메트리 연동을 구현할 것을 요구한다.

### 2.2 현재 상태 (검증됨)
- **단일 엔진 체계**: 현재 Trino가 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)의 유일한 쿼리 엔진이며, Superset 대시보드([`08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml))와 Airflow DAG([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py))를 모두 전담한다.
- **ADR-0004 기준 매트릭스**: [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)는 워크로드 후보를 정의하나 실행 형태 표가 우선한다. 읽기 전용 CI만 1단계, CLI/노트북·Airflow는 2단계, 쓰기는 3단계다. 공유 BI, 연합/대규모 스캔 및 OPA 대상은 Trino다.

### 2.3 수용 기준 대비 격차
1. 엔진 선택을 자동화하는 프로그래밍 방식의 라우팅 레이어나 정량적 데이터 크기 임계값이 없다.
2. 수동 엔진 재정의 플래그(`BELUGA_SQL_ENGINE`)가 구현되어 있지 않다.
3. 미지원 문법, 메모리 초과, 인가 거부 발생 시의 결정론적 폴백 로직이 정의되지 않았다.
4. 폴백 카운터나 관련 메트릭이 수집되지 않는다.

### 2.4 제안 (Proposed)

<!-- D2: DuckDB 거부 시 자격증명 확대 대신 중단; 비용: 명시적 사용자 재요청; 탈출구: 사용자 본인 신원으로 별도 인가된 Trino 요청. -->

| 클래스 | 최초 경로 | 단계 / 경계 |
|---|---|---|
| 1: CI/스키마 검증 | ADR 선행 조건 후 DuckDB | 1단계 합성 비-PII 테스트 웨어하우스, 읽기 전용; 오류는 CI 실패 |
| 2: 단일 사용자 ad-hoc/CLI/노트북 | DuckDB 후보 보류 | 2단계, 엔드포인트 도달성과 사람 신원 결정 필요 |
| 3: 제한된 Airflow 변환 | DuckDB 후보 보류 | 실행 형태는 2단계, 쓰기는 3단계; #70 / ADR Q5 게이트 |
| 4: 동시 BI/Superset | Trino | 기존 인증·인가 Trino 경로 |
| 5: 분산/연합 | Trino | 기존 인가 경로; 크기 불명확 시 실행 전 Trino 선택 |
| 6: PII / OPA 행·열 정책 | Trino 전용 | DuckDB principal 테이블 권한 없음; 거부 후 폴백 금지 |

라우터는 편의 계층이다. **PII 제외의 강제 지점은 Lakekeeper/OpenFGA 테이블 권한**이며 래퍼 우회 호출자에게도 적용된다. Trino는 사용자 인증 및 OPA 인가를 별도로 수행한다. PII 분류는 접근 허가가 아니다.

실측 스캔/파티션 임계값은 없다. 후보인 5 GB 스캔 / 50개 파티션 / 4 GB 버퍼 관리자 한도는 **미검증 크기 가설**이며 프로파일 사실이나 수용 기준이 아니다. 지원 프로파일 벤치마크 후 기본값을 결정한다. DuckDB `memory_limit`는 전체 프로세스 할당을 제한하지 않으므로 파드 메모리 한도와 실측 여유가 필요하다.

#### Fail-Closed 실행 및 명시적 재제출
- DuckDB의 모든 오류는 해당 실행을 중단한다. 인가 거부, timeout, 자격증명 누락/만료, 401/403, 알 수 없는 오류, 미지원 기능 및 용량 초과 모두 **Trino 자동 제출 금지**.
- 사용자는 본인 신원과 정상 Trino 인가로 **새로운** 실행을 명시적으로 요청할 수 있다. 새 요청 ID를 이전 실패와 연결한다. 공유/확대된 서비스 자격증명, 암묵적 impersonation 및 자동 SQL 재전송은 금지한다. 사용자 신원 경로가 없으면 재제출도 차단한다.
- 엔진 override는 구현되지 않은 제안 API 입력이다. DuckDB 강제 선택도 인가·단계·자격증명 게이트를 해제하지 못한다. 클러스터 내부 Trino HTTPS 8443과 도메인 레지스트리의 사용자 게이트웨이 HTTPS 443은 구분한다.
- 정형 이벤트는 실패와 명시적 새 요청을 별도로 기록한다. 메트릭 인프라는 선행 조건이 아니다(6절).

### 2.5 검증 및 테스트 아이디어
- DuckDB 카탈로그 401/403 및 PII 권한 제외를 발생시키고 래퍼 우회를 포함해 Trino 제출 0건 확인.
- 미지원 문법, timeout 및 용량 초과에서도 자동 Trino 제출 0건 확인.
- 명시적 재제출은 사용자 본인 신원·Trino/OPA 재인가·요청 ID 연결 검증; 신원 부재/권한 거부는 fail-closed.
- 실측 기반 최초 라우팅은 실행 전에만 적용하고 인가 거부를 엔진 선택으로 바꾸지 않는다.

### 2.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-63-1 | 최초 엔진 선택의 실측 크기 기본값은? | 벤치마크 우선; 불명확하면 Trino | 프로파일 임계값 날조 금지 |
| OD-63-2 | 어떤 명시적 사용자 재요청 UI가 필요한가? | 본인 신원의 새 Trino 요청만 | 폴백을 통한 권한 상승 방지 |

### 2.7 후속 구현 작업
1. **T-63-1**: 단계별 라우팅과 자동 재시도 없음 음성 테스트; 1단계는 CI 최초 경로만.
2. **T-63-2**: 실패/명시적 재제출 이벤트 발행; 선택적 카운터는 별도 관측 설계 채택 후.

---

## 3. 임베디드 DuckDB를 위한 통제된 자격증명 및 접근 경로 (이슈 #64)

### 3.1 목적 및 수용 기준 매핑
이슈 #64는 장기 공유 스토리지 자격증명을 배포하거나 Lakekeeper/Trino 정책 경계를 우회하지 않으면서, DuckDB 클라이언트를 위한 안전하고 통제된 자격증명 및 접근 모델을 정의할 것을 요구한다.

### 3.2 현재 상태 (검증됨)
- **Trino 스토리지 키 갭**: Trino는 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)에서 정적 관리자 S3 액세스 키를 보유하고 있다. 이 키는 `beluga-lake` 버킷 전체에 접근할 수 있어 키 보유자에게 카탈로그 인가를 우회하는 경로가 된다. [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)는 이를 알려진 갭으로 명시하고 DuckDB가 이 패턴을 넓히지 않도록 규정했다.
- **Lakekeeper 부트스트랩**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml)에서 `lake` 웨어하우스는 `"sts-enabled": false`와 정적 키로 생성된다. OpenFGA 웨어하우스 할당은 `service-account-trino`와 `service-account-flink`에 전체 권한을 부여한다 ([165~172행](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml)).
- **네트워크 정책**: [`04b-lakehouse-network-policy.yaml`](../gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml)은 default-deny를 적용하며, `lakekeeper:8181` 인그레스를 Trino, Flink, APISIX, 부트스트랩 잡에만 허용한다. DuckDB 클라이언트용 인그레스 규칙은 없다.
- **분류**: `lake.customers`는 PII를 포함한다 (`policies/resources.yaml`).

### 3.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB 카탈로그 시크릿** ([`https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html`](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html)):
  - OAuth2 attach 구문:
    ```sql
    CREATE TEMPORARY SECRET lakekeeper_secret (
        TYPE ICEBERG,
        CLIENT_ID 'duckdb-client',
        CLIENT_SECRET 'password',
        OAUTH2_SCOPE 'lakekeeper',
        OAUTH2_SERVER_URI 'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token'
    );
    ATTACH 'warehouse' AS lake_catalog (
        TYPE ICEBERG,
        ENDPOINT 'http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog',
        SECRET lakekeeper_secret
    );
    ```
  - DuckDB의 SeaweedFS 문서 예시는 정적 S3 시크릿(`TYPE s3`)을 전제하며, vended 자격증명(`ACCESS_DELEGATION_MODE 'vended_credentials'`)은 Polaris 예시에만 기재되어 있다.
- **Lakekeeper 스토리지 문서** ([`https://docs.lakekeeper.io/docs/latest/storage/`](https://docs.lakekeeper.io/docs/latest/storage/)): Lakekeeper의 자격증명 발급(vending)은 AWS STS `AssumeRole`에 의존한다. 공식 문서는 *"not all S3 compatible object stores support AssumeRole"*이라고 명시한다. SeaweedFS의 STS 지원 여부는 **미검증(UNVERIFIED)** 상태이다.

### 3.4 수용 기준 대비 격차
1. SeaweedFS STS 지원이 미검증 상태이다: 검증되기 전까지 DuckDB는 `beluga-lake`에 대한 vended 자격증명을 받을 수 없다.
2. 합성 데이터 전용 비-PII 테스트 버킷(`beluga-test`) 및 테스트 웨어하우스가 부트스트랩에 존재하지 않는다.
3. `04b-lakehouse-network-policy.yaml`이 DuckDB 클라이언트 파드의 Lakekeeper `:8181` 접근을 차단한다.
4. 전용 Keycloak 클라이언트(`duckdb-ci`, `duckdb-airflow`) 및 OpenFGA 테이블 단위 grant가 생성되어 있지 않다.

### 3.5 제안 (Proposed)

#### 자격증명 게이트 및 테스트 격리

```
+-----------------------------------------------------------------------------------+
| 1단계: 테스트 및 CI 격리 (범위 제한 정적 키 예외)                                 |
|                                                                                   |
|  [DuckDB 클라이언트] ---OIDC 토큰---> [Lakekeeper:8181] (OpenFGA로 검증)          |
|         |                                      |                                  |
|  (정적 범위제한 S3 키)                   (카탈로그 메타데이터)                    |
|         |                                      |                                  |
|         v                                      v                                  |
|  [SeaweedFS: s3://beluga-test/] <--------------+ (합성 비-PII 데이터 전용)        |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
| 자격증명 게이트: 통제된 읽기 (ADR 단계 변경 아님)                               |
|                                                                                   |
|  [DuckDB 클라이언트] ---OIDC 토큰---> [Lakekeeper:8181] (OpenFGA로 검증)          |
|         |                                      |                                  |
|         | <---임시 발급 STS 토큰---------------+ (임시 테이블 범위 토큰)          |
|         |                                                                         |
|         v                                                                         |
|  [SeaweedFS: s3://beluga-lake/] (운영 내부 데이터 - PII 제외)                     |
+-----------------------------------------------------------------------------------+
```

1. **1단계 (선행 조건 후 CI / PoC)**:
   - 합성 데이터만 보관하는 전용 SeaweedFS 버킷 `beluga-test` 생성.
   - `s3://beluga-test/`를 가리키는 전용 Lakekeeper 웨어하우스 `test_warehouse` 생성.
   - `beluga-test`로만 범위가 제한된 정적 S3 자격증명 쌍 생성.
   - Keycloak 클라이언트 `duckdb-ci`를 생성하고 테스트 테이블에만 OpenFGA 테이블 단위 읽기 권한 부여(구현 시 고정 Lakekeeper 모델의 실제 연산에 매핑).
2. **자격증명 게이트 (실행 단계 승인 아님)**:
   - `beluga-lake`에 대한 운영 데이터 접근은 작업 1(SeaweedFS STS 평가)에서 SeaweedFS가 범위 제한 자격증명을 발급할 수 있음이 증명될 때까지 **보류(BLOCKED)**된다. STS가 지원되지 않으면 범위 제한 vending이 입증될 때까지 비-PII 테스트 웨어하우스로 제한한다. 다른 예외는 새 ADR이 필요하다.
3. **네트워크 정책 추가 제안 (`04b-lakehouse-network-policy.yaml`)**:
   - `lakekeeper-ingress`에 명시적 인그레스 규칙 추가:
     ```yaml
     - from:
         - namespaceSelector:
             matchLabels:
               kubernetes.io/metadata.name: analytics
           podSelector:
             matchLabels:
               app.kubernetes.io/component: duckdb-client
     ```
   - DuckDB 클라이언트 파드에 `lakekeeper` TCP 8181, `keycloak` TCP 8080, `seaweedfs-s3` TCP 8333 이그레스 허용 규칙 추가.
4. **시크릿 전달 표준**:
   - Kubernetes 환경에서 클라이언트 시크릿은 메모리 기반 볼륨(`tmpfs`)을 통해 마운트된다. DuckDB는 메모리 내 시크릿(`CREATE TEMPORARY SECRET ...`)을 생성하며, 디스크나 로그에 자격증명을 영구 기록해서는 안 된다.

### 3.6 검증 및 테스트 아이디어
- **미인가 카탈로그 거부 테스트**: 유효하지 않은 Keycloak 토큰으로 `ATTACH` 시도 시 Lakekeeper가 HTTP 401로 거부하는지 확인.
- **PII 테이블 거부 테스트 (필수 회귀)**: 유효한 `duckdb-ci` 토큰으로 `SELECT * FROM lake_catalog.lake.customers` 시도 시 Lakekeeper OpenFGA가 HTTP 403 Forbidden을 반환하는지 확인.
- **우회 방지 테스트**: `duckdb-ci`에 부여된 S3 자격증명으로 AWS CLI를 통해 `s3://beluga-lake/` 직접 접근 시도 시 `AccessDenied`가 발생하는지 확인.
- **자격증명 만료 테스트**: 5분 만료 단기 토큰을 설정하고 만료 시 DuckDB가 행(hang) 없이 정상 에러 처리하는지 확인.

### 3.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-64-1 | SeaweedFS STS가 미지원될 경우, DuckDB를 vending 입증 전까지 테스트 버킷 제한을 유지할 것인가? | **제한 확정 (운영 접근 보류)** | ADR-0004 보안 원칙 3 준수. 버킷 단위 정적 키 허용 시 OpenFGA 테이블 단위 PII 보호가 무력화됨. |
| OD-64-2 | 개발자 대화형 인증: 사용자 bearer 토큰 대 서비스 계정? | **CLI/노트북에 사용자 bearer 토큰 사용** | OpenFGA 감사 로그에 실제 사람의 신원이 기록되도록 보장. |

### 3.8 후속 구현 작업
1. **T-64-1 (STS 검증 스크립트)**: SeaweedFS 대상 STS `AssumeRole` 호환성 자동 검증 실행. 수용 기준: SeaweedFS의 자격증명 발급 지원 여부 실측 결과 문서화.
2. **T-64-2 (테스트 웨어하우스 프로비저닝)**: 부트스트랩 스크립트에서 버킷 `beluga-test` 및 웨어하우스 `test_warehouse` 생성. 수용 기준: 테스트 자격증명으로 합성 테이블 질의 성공.
3. **T-64-3 (NetworkPolicy 인그레스 반영)**: `04b-lakehouse-network-policy.yaml`에 DuckDB 클라이언트 파드 셀렉터 추가. 수용 기준: `make validate` 통과 및 실제 연결 수립.

---

## 4. Trino/DuckDB 결과 일관성 및 벤치마크 스위트 (이슈 #65)

### 4.1 목적 및 수용 기준 매핑
이슈 #65는 동일한 Iceberg 스냅샷에 대해 DuckDB와 Trino의 결과 및 리소스 소모량을 비교하는 재현 가능한 벤치마크 및 의미론적 검증 스위트를 구축하고, 허용 오차 정책을 정의하며, 수치를 위조하지 않고 방법론을 정립할 것을 요구한다.

### 4.2 현재 상태 (검증됨)
- **기준 테이블**: [`policies/resources.yaml`](../policies/resources.yaml)의 `lake.events_enriched`(내부 이벤트), `lake.orders`(내부 주문), `lake.customers`(PII 고객).
- **기존 스크립트**: `tests/`에 테스트 스크립트가 존재하지만(`04-trino-query.sh`, `tests/run-all.sh`), 두 엔진 간 자동 결과 비교기는 없다.
- **벤치마크 요건**: ADR-0004 작업 10에서 CPU, 메모리, I/O, 기동 시간, 지연 시간, 동시성 비교를 요구하고 있다.

### 4.3 수용 기준 대비 격차
1. DuckDB와 Trino 결과 간의 행 수, 스키마, null 처리, 수치 출력을 자동 비교하는 도구가 없다.
2. 부동소수점 허용 오차 정책이 정의되지 않았다.
3. 프로세스 RSS, CPU 시간, I/O를 실측하는 벤치마크 실행 하네스가 없다.
4. 벤치마크 수치를 조작하지 않고 객관적 측정 방법론을 수립해야 한다.

### 4.4 제안 (Proposed)

#### 의미론적 일관성 검증 규칙
검증 스위트는 동일한 Iceberg 스냅샷 ID를 대상으로 동등한 SQL을 실행한다:

1단계 스위트는 합성 테스트 웨어하우스의 기록된 스냅샷을 사용한다. 아래 운영 이름은 문법 예시이며 접근 허가가 아니다. 고정 버전의 time-travel 지원을 확인한다.

```sql
-- Trino 쿼리
SELECT date_trunc('day', event_time) AS day, count(*) AS cnt, sum(amount) AS total
FROM iceberg.lake.orders FOR VERSION AS OF <snapshot_id>
GROUP BY 1 ORDER BY 1;

-- DuckDB 쿼리
SELECT date_trunc('day', event_time) AS day, count(*) AS cnt, sum(amount) AS total
FROM lake_catalog.lake.orders AT (VERSION => <snapshot_id>)
GROUP BY 1 ORDER BY 1;
```

1. **스키마 및 타입 매핑**:
   - `BIGINT`, `INTEGER`, `BOOLEAN`, `VARCHAR`는 타입 클래스와 값이 완벽히 일치해야 함.
   - `TIMESTAMP` 정밀도: 실제 Iceberg 타입과 Trino 정밀도를 기록한다(Trino bare `TIMESTAMP` 기본값은 3). 마이크로초는 DuckDB `TIMESTAMP`와 매핑; 시간대/decimal/NaN/infinity는 별도 검증.
2. **부동소수점 허용 오차 정책**:
   - `DOUBLE` 및 `FLOAT` 집계 계산은 SIMD 벡터화 연산 순서 차이로 인해 엄격한 일치를 요구하지 않음.
   - 상대 오차 기준 적용:
     $$\frac{|V_{\text{duckdb}} - V_{\text{trino}}|}{\max(|V_{\text{trino}}|, 10^{-9})} \le 10^{-6}$$
3. **정렬 및 Null 의미론**:
   - `ORDER BY`가 없는 결과는 중복 개수를 보존한 multiset 비교; 집계 결과에는 기본키가 없을 수 있다.
   - `NULL` 정렬: DuckDB와 Trino 기본값은 모두 `NULLS LAST`이며 DuckDB 설정으로 변경 가능하므로 쿼리 작성 시 `NULLS LAST`를 명시하도록 표준화.

#### 재현 가능한 벤치마크 방법론 (수치 조작 금지)
- **대상 워크로드**:
  - *쿼리 클래스 A (필터/포인트)*: 파티션 컬럼 대상 고선택도 필터 (`event_date = '2026-10-01'`).
  - *쿼리 클래스 B (대량 집계)*: 1천만 행 대상 다중 컬럼 `GROUP BY` 및 `count(DISTINCT)`.
  - *쿼리 클래스 C (조인)*: 2개 테이블 해시 조인 (`orders`와 `events_enriched`).
  - *쿼리 클래스 D (윈도우 함수)*: `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY event_time)`.
- **수집 메트릭**:
  1. *콜드 스타트 지연 (ms)*: 프로세스 기동부터 첫 번째 결과 배치 수신까지의 시간.
  2. *쿼리 실행 시간 (ms)*: 쿼리 실행의 벽시계(wall-clock) 경과 시간.
  3. *최대 메모리 (RSS MiB)*: DuckDB는 실행마다 새 자식 프로세스의 OS별 `ru_maxrss` 단위로 측정하고 Trino는 전체 파드 프로세스/컨테이너 RSS를 측정한다. JVM heap과 RSS 직접 비교 금지.
  4. *CPU 소모량 (User + System ms)*: 프로세스가 소모한 CPU 시간.
  5. *스토리지 I/O 읽기 (MiB)*: HTTP/S3 게이트웨이를 통해 가져온 총 바이트 수.
- **보고 표준**: 하드웨어 프로파일, OS 커널, 엔진별 정확한 커밋 해시를 포함한 JSON 아티팩트로 출력하여 `docs/benchmarks/`에 보관.

### 4.5 검증 및 테스트 아이디어
- **자동화된 회귀 스위트**: 테스트 웨어하우스 스냅샷을 대상으로 `tests/duckdb-trino-parity.py`를 실행하여 diff가 0임을 검증.
- **인위적 결함 주입**: 테스트 브랜치에서 의도적인 문법 차이나 타입 불일치를 주입하여 하네스가 이를 감지하고 fail-closed로 실패하는지 확인.

### 4.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-65-1 | 비즈니스 리포팅을 위한 부동소수점 상대 허용 오차는? | **$10^{-6}$ 상대 오차** | 후보 오차이며 decimal/금융 정확 비교와 0 근처/NaN/infinity는 별도 소유자 규칙 필요. |
| OD-65-2 | 버전 관리되는 벤치마크 출력 JSON을 어디에 보관할 것인가? | **저장소 내 `docs/benchmarks/`** | 플랫폼 릴리스별 성능 변화를 GitOps로 추적 가능. |

### 4.7 후속 구현 작업
1. **T-65-1 (동등성 하네스)**: Python 기반 비교 CLI `tests/duckdb-trino-parity.py` 구현. 수용 기준: 합성 데이터셋 대상 쿼리 클래스 A~D 통과.
2. **T-65-2 (벤치마크 하네스)**: RSS, CPU, I/O를 실측하는 러너 스크립트 작성. 수용 기준: 유효한 스키마 준수 요약 JSON 생성.

---

## 5. CI, Airflow 및 재현 가능한 로컬 워크플로우 통합 (이슈 #66)

### 5.1 목적 및 수용 기준 매핑
이슈 #66은 고정된 런타임, 재사용 가능한 연결 유틸리티, 영구 운영 자격증명을 노출하지 않는 수명주기 관리를 통해 CI 검증, Airflow 데이터 파이프라인, 로컬 개발자 워크플로우에 DuckDB 실행 경로를 제공할 것을 요구한다.

### 5.2 현재 상태 (검증됨)
- **Airflow DAG 위치**: DAG 파일들은 [`gitops/charts/beluga-data/files/dags/`](../gitops/charts/beluga-data/files/dags/)에 위치한다.
- **현재 Airflow 오퍼레이터**: [`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py)는 `analytics` 네임스페이스에서 `trinodb/trino:483` CLI 파드를 실행하는 `KubernetesPodOperator`를 사용한다.
- **버전 관리**: 현재 [`VERSIONS.md`](../VERSIONS.md)에 DuckDB는 포함되어 있지 않다.

### 5.3 수용 기준 대비 격차
1. `VERSIONS.md`에 DuckDB 바이너리 및 Python 라이브러리 버전이 고정되어 있지 않다.
2. 로컬 스크립트, CI, Airflow에서 공통 사용할 재사용 가능한 연결 헬퍼가 없다.
3. Airflow에 DuckDB 워크로드를 실행하기 위한 오퍼레이터 패턴이 없다.
4. 로컬 개발자 머신에서 클러스터 내부 S3 DNS(`seaweedfs-s3.storage.svc.cluster.local:8333`)를 직접 해석할 수 없다.

### 5.4 제안 (Proposed)

1단계는 **클러스터 내부 또는 테스트 스택의 읽기 전용 CI/PoC**다. attach 전 ADR 작업 1~4(스토리지 결정·범위 제한 키 증거, 합성 웨어하우스, 전용 신원/테이블 권한, 명시적 클라이언트 네트워크 규칙)를 완료한다. ADR Q4 결정 후 구현 시 정확한 런타임·확장 아티팩트/버전·이미지 digest를 고정한다. 이 제안은 `VERSIONS.md`를 변경하지 않는다. 유동적인 확장 저장소의 런타임 설치는 재현 가능한 고정이 아니다.

제안 연결 헬퍼는 임시 메모리 시크릿을 사용하고, 고정 API로 SQL 값/식별자를 안전하게 인코딩하며, 시크릿 보간/로깅을 피하고, 선택된 vending 또는 합성 테스트 범위 제한 경로를 검증해야 한다. 카탈로그 attach만으로 S3 도달성이나 읽기 전용 강제를 증명하지 못한다.

**Airflow는 2단계**다. 전용 클라이언트/네트워크 경로, 자격증명 증거와 #70이 선행하며 Q5 “sandbox first” 소유자 결정 전에는 보류한다. `BelugaDuckDBPodOperator`, 기반 이미지 및 크기는 열린 질문이며 1단계 기본 경로가 아니다. 샌드박스 쓰기는 여전히 3단계 작업 8이 필요하다.

**로컬 CLI/노트북은 2단계**다. APISIX 카탈로그/S3 호스트명만으로 메타데이터나 vended 설정의 클러스터 내부 엔드포인트를 해결하지 못한다. 엔드포인트 변환/도달성, TLS, 사용자 신원을 설계하고 노트북에서 카탈로그 및 실제 데이터 읽기를 검증해야 한다. 기본 게이트웨이/port-forward 레시피는 채택하지 않는다.

### 5.5 검증 및 테스트 아이디어
- Trino 워커 없이 합성 웨어하우스의 1단계 CI 읽기 성공; 기존 `make test-duckdb-ci` 타깃 존재 주장 없음.
- 고정 아티팩트 출처, 시크릿 처리, 스토리지 범위 거부, 읽기 전용 및 인가 음성 검증.
- 2단계 전용: Airflow 수명주기 및 로컬 머신의 카탈로그·객체 스토리지 읽기.

### 5.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-66-1 | 2단계 Airflow의 강화 이미지/오퍼레이터는? | ADR 선행 조건과 Q5 이후 | 1단계 CI 우선 |
| OD-66-2 | 사용자 신원으로 로컬 머신에서 카탈로그·데이터 모두 접근하는 경로는? | 2단계에서 설계·실측 | 게이트웨이 이름만으로 불충분 |

### 5.7 후속 구현 작업
1. **T-66-1**: ADR 선행 조건 후 고정된 1단계 CI 헬퍼; 합성 읽기와 보안 음성 검증.
2. **T-66-2**: 소유자 질문과 단계 게이트 이후 2단계 Airflow/로컬 평가; 1단계 오퍼레이터 구현 없음.

---

## 6. 엔진 수준 메트릭 및 리소스 귀속 (이슈 #67)

### 6.1 목적 및 수용 기준 매핑
이슈 #67은 DuckDB를 상시 서비스로 만들지 않으면서, DuckDB와 Trino의 엔진 선택, 실행 결과, 폴백, 리소스 소모량을 측정 가능하게 만들 것을 요구한다.

### 6.2 현재 상태 (저장소 및 라이브 증거)

`06-trino.yaml`에는 Prometheus JMX exporter 설정이 없다. 2026-10-08 읽기 전용 `kubectl get deploy,ds,sts,svc -A -o json`의 84개 리소스에서 Prometheus, Fluentbit/Vector, Pushgateway 워크로드/서비스를 찾지 못했다. `platform-system/grafana-external` Service는 존재하나 수집기·대시보드·정상 텔레메트리 파이프라인의 증거가 아니다. 이 제안의 **기존 의존성이 아니다**. 별도 외부 호스팅 시스템의 부재까지 증명하지 않는다.

### 6.3 수용 기준 대비 격차
DuckDB 귀속 이벤트 발행기·수집 경로·엔진 대시보드는 미구현이다. 원문 SQL, 리터럴, 토큰 및 쿼리 텍스트가 포함될 수 있는 원시 프로파일 JSON은 로깅하지 않는다.

### 6.4 제안 (Proposed)

<!-- D3: 설치된 수집기를 가정하지 않고 정제된 CI 아티팩트 사용; 비용: 라이브 집계 없음; 탈출구: 별도 승인된 수집기/배포 설계. -->

허용 목록 기반 JSON 이벤트를 stdout에 발행하고 정제된 CI 아티팩트를 보존한다. 필드: 요청 ID, 시각, 엔진/런타임/확장 버전, 단계/워크로드 클래스, 가명 호출자, 허용된 데이터셋 식별자, 상태, 오류 분류 및 명시적으로 연결된 재요청 ID. 정규화 해시는 리터럴을 제외하고 민감 메타데이터도 검토한다. 오류 메시지에 SQL/시크릿을 복사하지 않는다.

경과 시간·CPU·RSS·스필·읽기 바이트는 실측값만 기록하고 미측정은 `null`로 둔다. 예시는 벤치마크 결과가 아니다. DuckDB JSON 프로파일은 파싱·정제 후 발행한다. 단일 프로세스 RSS와 JVM heap은 다르며, 분산 Trino CPU/RSS/I/O에는 코디네이터와 전체 워커를 포함한다. OS별 단위·방법을 기록한다.

Prometheus 카운터, Pushgateway, Fluentbit/Vector 및 Grafana 패널은 배포·보존·접근·카디널리티·정리 결정이 필요한 향후 선택적 제안이다. Airflow 발행은 2단계다. 어느 것도 설치되거나 채택된 1단계 의존성이 아니다.

### 6.5 검증 및 테스트 아이디어
- 스키마/미측정값 검증; SQL·자격증명 포함 오류/프로파일을 주입하고 유출 없음 확인.
- 인가 거부/timeout/용량 실패에 실패 이벤트 1건, 자동 Trino 재요청 0건 확인.
- 수집기/대시보드 통합 검증은 별도 배포 이후.

### 6.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-67-1 | 정제된 CI 아티팩트 이후 수집기/보존 정책은? | stdout + CI 아티팩트 우선; 배포는 별도 | 기존 수집 파이프라인 가정 금지 |

### 6.7 후속 구현 작업
1. **T-67-1**: 개인정보/스키마 테스트를 포함한 허용 목록 이벤트 발행기.
2. **T-67-2**: 승인된 인프라 이후 집계/대시보드 평가; 기존 플랫폼 대시보드 주장 없음.

---

## 7. 결과 재사용, 디스크 스필 및 임시 데이터 수명주기 (이슈 #68)

### 7.1 목적 및 수용 기준 매핑
이슈 #68은 DuckDB를 통제 불능의 영구 저장소로 만들거나 테넌트 간 PII를 유출하지 않으면서, DuckDB 워크로드의 안전하고 측정 가능한 결과 재사용/캐싱 및 임시 데이터 수명주기를 정의할 것을 요구한다.

### 7.2 현재 상태 (검증됨)
- **수명주기 보존 정책**: [`docs/data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md)는 스크래치, 재작성, 체크포인트를 위한 `temporary` 등급을 정의하며 자동 수명 기반 정리를 규정한다.
- **SeaweedFS Prefix**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml)은 일시적 재작성/체크포인트/스크래치 데이터용으로 `tmp/`를 지정한다.
- **스토리지 경계**: Kubernetes 워커 노드의 디스크 공간은 유한하며, 임시 파드 스토리지 상한을 두지 않으면 노드 디스크 고갈이 발생할 수 있다.

### 7.3 외부 문서 및 증거 (2026-10-08 열람)

[DuckDB 설정](https://duckdb.org/docs/current/configuration/overview)은 `memory_limit`, `temp_directory`, `max_temp_directory_size`를 문서화한다. [Kubernetes 임시 스토리지](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage)는 계측/축출을 설명하며 `emptyDir.sizeLimit`는 동기 파일시스템 quota가 아니다.

### 7.4 수용 기준 대비 격차
스필 계측, 강제 종료 정리 및 인가를 반영한 캐시 무효화는 미구현이다. 스토리지 제한·정리 성공을 주장하지 않는다.

### 7.5 제안 (Proposed)

1단계는 매번 새 메모리 DB와 실행별 비-PII 스크래치 경로를 사용하며 **실행/사용자 간 결과 재사용은 없다**. PII 테이블은 읽기 전에 OpenFGA가 거부하며 `COPY`/스필 및 래퍼 우회에도 적용한다. “PII 메모리만 사용”은 거부의 예외가 아니다.

메모리/스필 후보 한도는 실측과 OD-68-1 결정이 필요하다. DuckDB 버퍼/스필 설정, 파드 메모리/ephemeral-storage requests 및 limits, `emptyDir.sizeLimit`를 함께 적용하고 프로세스/스토리지 여유를 둔다. kubelet 축출은 비동기이며 계측/노드 지원에 의존한다. 10 GiB가 모든 노드 고갈을 방지한다고 보장하지 않는다.

정상 종료는 프로세스 파일을 정리할 수 있다. `SIGKILL`은 셸 trap을 실행하지 못하며 같은 파드의 컨테이너 재시작은 `emptyDir`를 보존한다. supervisor/기동 시 정리 또는 제한된 janitor를 설계하고 파드 삭제 정리는 별도 검증한다. Airflow 훅과 태스크 간 재사용은 2단계 소유자 질문이다.

향후 재사용 키에는 **모든 원천** 테이블 UUID/스냅샷, 쿼리/매개변수 신원, 엔진+확장 버전, 테넌트/principal 및 인가 맥락/버전이 필요하다. 조회/반환 전 현재 권한을 재검증하고 스냅샷이 같아도 권한 회수 시 접근을 차단한다. 구현된 무효화 없이 즉시 무효화를 보장하지 않는다.

### 7.6 검증 및 테스트 아이디어
- 합성 데이터 스필을 강제하고 엔진 한도·파드 계측을 실측.
- `SIGKILL`, 동일 파드 재시작, 파드 삭제를 구분해 정리 검증; 버려진 디렉터리 증가 없음 확인.
- 래퍼 없이 카탈로그 인가로 PII 읽기와 `COPY` 거부.
- 향후 재사용 채택 시 사용자 격리, 권한 회수 및 다중 테이블 스냅샷 변경 검증.

### 7.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-68-1 | 안전한 실측 프로세스/스필/파드 한도는? | 크기·계측 검증 우선 | hard quota·즉시 축출 주장 없음 |
| OD-68-2 | 2단계 DAG 태스크가 중간 결과를 재사용할 것인가? | 보류; 1단계는 새 실행만 | 신원·권한 회수·정리 증거 필요 |

### 7.8 후속 구현 작업
1. **T-68-1**: 실행별 스크래치와 고정 런타임 스필 설정, 실제 정리 테스트.
2. **T-68-2**: 파드 계측/한도와 종료/재시작/삭제 검증; 향후 캐시는 별도 게이트.

---

## 8. Quack 원격 프로토콜 평가 게이트 (이슈 #69)

### 8.1 목적 및 수용 기준 매핑
이슈 #69는 DuckDB Quack 프로토콜을 공유 경량 쿼리/서비스 워크로드로 검토하기 전에, 임베디드 DuckDB 설계가 먼저 입증되도록 보장하는 별도의 증거 기반 평가 게이트를 정의할 것을 요구한다.

### 8.2 현재 상태 (검증됨)
- **중앙 서비스 아키텍처**: Trino가 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)에서 Beluga의 중앙 분산 쿼리 서비스로 동작하며, APISIX 인그레스 라우팅([`10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml)), Keycloak OAuth2([`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)), Lakekeeper/OpenFGA 카탈로그 인가와 연동되어 있다(Trino OPA 질의 정책과 구분).
- **ADR-0004 결정**: [ADR-0004 결정 2](adr/0004-duckdb-complementary-analytics-engine-ko.md)는 Quack을 범위 밖으로 명시했다: *"DuckDB는 상시 서비스가 아니라 클라이언트/잡에 임베디드로 실행한다. DuckDB/Quack 서버 모드는 범위 밖이며 임베디드 경로 검증 후 별도 평가한다."*

### 8.3 외부 문서 및 증거 (2026-10-08 열람)

[Quack 개요](https://duckdb.org/docs/current/quack/overview)는 활발히 개발 중인 베타 원격 프로토콜을 설명한다. [Quack 보안](https://duckdb.org/docs/current/quack/security)은 기본 토큰 인증, 허용적인 기본 인가, 교체 가능한 인증/인가 callback과 custom hook을 통한 사용자별 ACL 예제를 문서화한다. 훅 존재는 Beluga 엔터프라이즈 RBAC 통합 증거가 아니다. HTTP 노출에는 외부 TLS 종료 설계가 필요하다.

### 8.4 수용 기준 대비 격차
Beluga의 Quack 신원 전달, 테이블 정책 강제, 테넌트 격리 및 운영 증거는 없다. 업스트림 인가 훅이 없다고 주장하지 않는다.

### 8.5 제안 (Proposed)

Quack은 ADR-0004대로 **범위 밖**이다. 영구 기각을 새로 결정하거나 서비스를 허용하지 않는다. 향후 별도 평가에는 소유자 결정과 다음 증거가 필요하다:
1. 지원 워크로드의 임베디드 경로 안정성.
2. Trino 대비 공유 서비스가 필요한 실측 근거.
3. 고정 프로토콜/버전 호환성과 업그레이드 계획.
4. TLS, 호출자 신원, 파싱된 문장 인가, 테넌트 격리 및 카탈로그/스토리지 정책 강제.

근거 없는 “90일”, “CPU 50% 절감”, GA 요구나 동시 요청 수는 채택된 게이트가 아니다. 향후 결정에서 평가 기준을 선택·실측한다.

### 8.6 검증 및 테스트 아이디어
향후 평가는 인가 훅 실패, 래퍼 우회, 테넌트/세션 격리, 카탈로그/PII 거부 및 합의된 대표 동시 부하를 검증한다.

### 8.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-69-1 | 언제 Quack 별도 평가가 필요한가? | 임베디드 경로 입증 전 범위 밖 유지 | ADR 결정 2 보존 |

### 8.8 후속 구현 작업
1. **T-69-1**: 공식 프로토콜/보안 변경 추적; 이 제안에서 서비스/컴포넌트 도입 없음.

---

## 9. 종합 소유자 결정 표

절별 표가 원천이다. OD-62-1 / OD-62-2는 보류된 쓰기와 버전 고정, OD-63-1 / OD-63-2는 크기와 명시적 사용자 재제출, OD-64-1 / OD-64-2는 vending과 사람 신원, OD-65-1 / OD-65-2는 허용오차와 벤치마크 보존, OD-66-1 / OD-66-2는 2단계 실행 형태, OD-67-1은 향후 수집, OD-68-1 / OD-68-2는 실측 한도와 보류된 재사용, OD-69-1은 별도 Quack 평가다. 어느 것도 ADR 결정을 바꾸지 않는다. ADR Q1/Q4와 작업 1~4는 1단계 attach 선행 조건이며 쓰기는 3단계다.

## 10. 종합 후속 구현 작업 표

| 단계 / 작업 | 선행 조건 | 수용 증거 |
|---|---|---|
| 1단계 스토리지/신원/네트워크: T-64-1 / T-64-2 / T-64-3 | ADR 작업 1~4, 소유자 스토리지 결정 | 합성 범위 제한 키 또는 vending 증거, 전용 권한, PII 카탈로그 거부, 양성/음성 네트워크 검증 |
| 1단계 읽기/보안: T-62-1 / T-62-2 / T-63-1 / T-66-1 | 위 선행 조건, 런타임+확장 고정 | 읽기 동등성, 모든 쓰기 거부, 자동 Trino 재요청 0건 |
| 1단계 동등성/실측: T-65-1 / T-65-2 / T-63-2 / T-67-1 | 합성 fixture 및 읽을 수 있는 고정 스냅샷 | 비교 가능한 실측 결과, 정제 이벤트, 미측정 명시 |
| 1단계 스크래치: T-68-1 / T-68-2 | 고정 러너와 실측 한도 | 스필, 종료, 재시작 및 삭제 증거 |
| 2단계 Airflow/로컬: T-66-2 | vending/신원/네트워크 및 ADR Q5/#70 | 실제 Airflow 및 로컬 카탈로그·데이터 읽기 |
| 향후 집계: T-67-2 | 별도 배포 결정 | 실제 수집기/대시보드 증거 |
| 3단계 쓰기 | ADR 작업 8, #70, 소유자 범위/회수 결정 | 커밋 충돌, 중단/재시도, 안전한 고아 파일 수명주기 |
| 별도 Quack 평가: T-69-1 | 임베디드 경로 증거와 소유자 결정 | 버전별 보안/운영 증거 |

## 수정 증거 및 한계 (2026-10-08)

저장소 기준: `0526d9371cae5f895c6e38905e17624f67b09912`. 수정 근거: 기존 DAG, `tests/04-trino-query.sh`, ADR-0004 실행 형태/보안/작업 순서, 위 공식 문서. [DuckDB 정렬](https://duckdb.org/docs/current/sql/query_syntax/orderby)로 NULL 기본값, [Trino 타입](https://trino.io/docs/current/language/types.html)으로 timestamp 정밀도를 확인했다. 이전 검증된 kubeconfig의 격리 복사본으로 배포/DaemonSet/StatefulSet/Service 84개를 읽기 전용 조회했고 명명된 수집기 의존성은 없었다. 공유 `vagrant-beluga` context는 CA 검증에 실패하여 증거로 쓰지 않았으며 TLS 검증도 해제하지 않았다. 클러스터 변경, DuckDB 런타임 테스트, vending 증명 및 벤치마크는 수행하지 않았다. 위 테스트는 수용 아이디어이며 실행 결과가 아니다.
