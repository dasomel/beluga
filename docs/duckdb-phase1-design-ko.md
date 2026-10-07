# DuckDB 1단계 상세 설계: Iceberg 경계, 라우팅, 보안 및 워크플로우

[English](duckdb-phase1-design.md) | 한국어

Refs #62 #63 #64 #65 #66 #67 #68 #69.

> **상태: 제안 (PROPOSAL). 문서 전용.**
> 이 설계 문서는 [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md)에서 확정된 도입 프레임워크를 구체화하며, 기존의 어떠한 결정도 변경하지 않는다. 이 문서와 ADR-0004 간의 모든 불일치는 열린 소유자 질문으로 다룬다. 어떠한 매니페스트, 컨테이너 이미지, Helm 값, `VERSIONS.md` 행도 이 문서로 인해 수정되지 않는다.

---

## ADR-0004와의 관계 및 아키텍처 범위

[ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md#L53-L63)는 DuckDB를 Trino를 대체하는 엔진이 아니라, Trino와 함께 병행 구동되는 **보완적 임베디드 분석 엔진**으로 채택하기로 결정했다. 핵심 목표는 Beluga의 중앙 집중식 거버넌스와 분산 실행 능력을 유지하면서, 경량 프로파일, 로컬 개발 환경, 임시 CI 검증에서의 리소스 오버헤드를 절감하는 것이다.

이 문서는 8개 영역에 걸친 후속 이슈(#62~#69)에 대한 구체적인 기술 설계 사양을 제공한다:
1. **[이슈 #62](#1-iceberg-호환성-매트릭스-및-안전한-쓰기-경계-이슈-62)**: Iceberg 호환성 매트릭스 및 안전한 읽기/쓰기 경계 정의.
2. **[이슈 #63](#2-쿼리-워크로드-라우팅-및-trino-폴백-정책-이슈-63)**: 워크로드 라우팅 분류, 임계값 및 결정론적 Trino 폴백 정책.
3. **[이슈 #64](#3-임베디드-duckdb를-위한-통제된-자격증명-및-접근-경로-이슈-64)**: 통제된 인증, Lakekeeper OpenFGA 인가 및 시크릿 전달 패턴.
4. **[이슈 #65](#4-trinoduckdb-결과-일관성-및-벤치마크-스위트-이슈-65)**: 의미론적 동등성 검증 규칙 및 재현 가능한 벤치마크 방법론.
5. **[이슈 #66](#5-ci-airflow-및-재현-가능한-로컬-워크플로우-통합-이슈-66)**: CI, Airflow 태스크 및 개발자 워크스테이션을 위한 실행 경로.
6. **[이슈 #67](#6-엔진-수준-메트릭-및-리소스-귀속-이슈-67)**: 정형화된 실행 이벤트, 텔레메트리 발행 및 Prometheus 메트릭.
7. **[이슈 #68](#7-결과-재사용-디스크-스필-및-임시-데이터-수명주기-이슈-68)**: 임시 스크래치 파일, 디스크 스필 한도, 캐시 무효화 및 PII 격리.
8. **[이슈 #69](#8-quack-원격-프로토콜-평가-게이트-이슈-69)**: DuckDB Quack 서비스 모드 검토를 위한 엄격한 평가 게이트 기준.

### 규범적 보안 가드레일 (ADR-0004 상속)

이 문서의 모든 제안은 [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md#L78-L114)에서 수립된 타협 불가능한 보안 요구사항을 엄격하게 준수한다:
- **독립된 OIDC 식별자**: DuckDB 클라이언트는 `service-account-trino` 또는 `service-account-flink`를 재사용하지 않고, 자체 전용 Keycloak OIDC 클라이언트 자격증명(`duckdb-ci`, `duckdb-airflow`)을 사용해 인증한다.
- **테이블 단위 grant만 허용**: Lakekeeper를 경유하는 OpenFGA grant는 반드시 명시적인 테이블 단위로 제한되어야 한다. 웨어하우스 단위나 네임스페이스 단위 grant는 Lakekeeper가 하위 모든 테이블로 `select` 권한을 상속하므로 엄격히 금지된다. 상속이 허용되면 [`policies/resources.yaml`](../policies/resources.yaml#L16-L23)에서 `classification: pii`로 지정된 PII 테이블(`lake.customers`)이 노출되기 때문이다.
- **정적 관리자 스토리지 자격증명 금지**: 운영 환경이나 PII 경로의 DuckDB 클라이언트에 정적 관리자 S3 액세스 키를 전달해서는 안 된다. 운영 데이터 접근에는 Lakekeeper가 발급하는 vended 자격증명이 필수다. 유일하게 허용되는 정적 키는 CI 및 PoC 검증을 위해 합성 데이터만 보관하는 전용 비-PII 테스트 버킷(`beluga-test`)으로 범위가 엄격히 제한된 키뿐이다.
- **엄격한 네트워크 격리**: Kubernetes NetworkPolicy는 기본 차단(default-deny)을 강제하며, 명시적으로 레이블이 지정된 DuckDB 클라이언트 파드에 대해서만 `lakekeeper:8181`, `keycloak:8080`, `seaweedfs-s3:8333` 통신을 허용한다.
- **읽기 전용 우선**: 쓰기 안전성과 커밋 동시성 동작이 실측 증거로 확인되기 전까지 DuckDB는 Lakekeeper 카탈로그 테이블에 대해 읽기 전용 상태를 유지한다.

---

## 1. Iceberg 호환성 매트릭스 및 안전한 쓰기 경계 (이슈 #62)

### 1.1 목적 및 수용 기준 매핑
이슈 #62는 지원되는 DuckDB 및 Apache Iceberg 호환성 매트릭스를 정의하고, 읽기 전용 워크로드와 쓰기 워크로드를 분리하며, 쓰기 적격성 기준을 수립하고, 미지원 변경에 대한 음성(negative) 테스트를 추가하며, 스냅샷 커밋 의미론을 검증하고, Trino/Flink가 변경 권한을 갖는 정식 경로로 유지됨을 확정할 것을 요구한다.

### 1.2 현재 상태 (검증됨)
- **카탈로그 구성**: Trino의 Iceberg 카탈로그는 [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml#L7-L28)에 구성되어 있다. `lake` 웨어하우스의 Lakekeeper REST 카탈로그(`http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog`)에 연결되며, Keycloak(`http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token`) 대상 OAuth2 클라이언트 자격증명을 사용하고 정적 S3 키(`s3.aws-access-key=${ENV:TRINO_S3_ACCESS_KEY}`)를 보유한다.
- **Lakekeeper 웨어하우스**: Lakekeeper의 `lake` 웨어하우스는 [`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L137-L138)에서 `"sts-enabled": false`와 정적 자격증명으로 생성되어 버킷 `beluga-lake`를 가리킨다.
- **데이터 분류**: [`policies/resources.yaml`](../policies/resources.yaml#L1-L23)에서 `lake.events_enriched`와 `lake.orders`는 `classification: internal`로 지정되어 있고, `lake.customers`는 민감한 컬럼 `email`을 포함하여 `classification: pii`로 지정되어 있다.
- **공식 변경 엔진**: Flink가 스트리밍 CDC 수집을 담당하고(`14-flink-jobs.yaml`), Trino가 [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L24-L52)의 배치 컴팩션 및 유지보수 작업을 담당한다.
- **라이브 클러스터 상태**: Lakekeeper 파드 `lakehouse/lakekeeper-66bbf6776c-dtpcx`가 Running 상태이며, Trino 코디네이터 `analytics/trino-coordinator-76cf9f6b9-rkksm` 및 워커 `analytics/trino-worker-5d75dd75b-g95l4`가 Running 상태이다 (2026-10-08 라이브 실측).

### 1.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB Iceberg 개요** ([`https://duckdb.org/docs/current/core_extensions/iceberg/overview`](https://duckdb.org/docs/current/core_extensions/iceberg/overview)): `iceberg_scan`을 통한 직접 테이블 읽기는 읽기 전용이며 메타데이터 버전 힌트(`version-hint.text` 또는 명시적 `version`)가 필요하다. Iceberg REST 카탈로그를 attach(`ATTACH ... TYPE iceberg`)하면 카탈로그 관리형 테이블을 전체 기능으로 접근할 수 있다.
- **DuckDB Iceberg 쓰기** ([`https://duckdb.org/docs/current/core_extensions/iceberg/writing`](https://duckdb.org/docs/current/core_extensions/iceberg/writing)): 쓰기는 attach된 REST 카탈로그를 통해서만 지원된다. 지원 작업: `CREATE TABLE`(파티셔닝: identity, year, month, day, hour, bucket, truncate), `INSERT INTO`(`BY NAME` 포함), `UPDATE`, `DELETE`, `MERGE INTO`, 스키마 진화(`ALTER TABLE ADD/DROP/RENAME/ALTER COLUMN`).
  - *문서화된 한계 1*: `UPDATE` 및 `DELETE`는 **positional delete** 파일만 작성하며 copy-on-write는 지원하지 않는다.
  - *문서화된 한계 2*: `UPDATE` 및 `DELETE`는 **merge-on-read** 의미론만 지원한다. 테이블의 `write.update.mode` 또는 `write.delete.mode`가 다른 값으로 설정되어 있으면 실행이 실패한다.
  - *문서화된 한계 3*: 파티션된 테이블에서는 `write.target-file-size-bytes` 및 `write.parquet.row-group-size-bytes` 속성을 적용할 수 없어 에러가 발생한다(`ignore_target_file_size_for_partitioned_tables`를 `true`로 설정해야 무시됨).
- **DuckDB Iceberg 문제 해결** ([`https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting`](https://duckdb.org/docs/lts/core_extensions/iceberg/troubleshooting)): DuckDB 1.4 LTS 공식 문서의 한계(Limitations) 절에 다음과 같이 명시되어 있다: *"Reading tables with deletes is not yet supported."* (삭제가 포함된 테이블 읽기는 아직 지원되지 않음).
- **동시성 및 커밋**: Trino/Flink의 동시 변경 작업 중에 Lakekeeper REST 카탈로그를 통한 커밋 충돌 해결 및 재시도 의미론은 **미검증(UNVERIFIED)** 상태이다 ([ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md#L46-L51) 기록).

### 1.4 수용 기준 대비 격차
1. Beluga에 DuckDB가 질의하거나 변경할 수 있는 Iceberg 테이블 사양을 규정하는 공식적인 버전 고정 호환성 매트릭스 문서가 없다.
2. positional delete가 포함된 테이블에 대한 DuckDB 읽기 호환성이 미검증 상태이며, DuckDB 1.4 LTS에서는 실패하는 것으로 문서화되어 있다.
3. DuckDB가 공유 운영 테이블(`lake.*`)에 변경 쿼리를 실행하지 못하도록 막는 쓰기 경계 및 검증 로직이 없다.
4. 실패하거나 중단된 DuckDB 쓰기 작업에 대한 자동 롤백 및 정리 절차가 정의되지 않았다.

### 1.5 제안 (Proposed)

#### 제안된 호환성 매트릭스 (DuckDB Iceberg 확장)

| 워크로드 / 테이블 기능 | DuckDB 지원 상태 | 공식 권한 엔진 | Beluga 정책 |
|---|---|---|---|
| 비파티션 / 파티션 테이블 읽기 | 지원됨 (v1, v2) | DuckDB / Trino | 인가된 테이블에 허용 |
| Append-only 테이블 읽기 (`lake.events_enriched`) | 지원됨 | DuckDB / Trino | 인가된 테이블에 허용 |
| 직접 경로 읽기 (`iceberg_scan`) | 읽기 전용 | Trino / DuckDB | 디버깅 전용으로 제한 (Lakekeeper 인가 우회 방지) |
| 삭제가 포함된 테이블 읽기 | **조건부** (1.4 LTS에서 불가) | Trino | **1.4 LTS에서 차단**, 1.5+ 버전 검증 시까지 보류 |
| `INSERT INTO` append 쓰기 | REST 카탈로그 경유 지원 | Trino / Flink | 전용 샌드박스/파생 네임스페이스에만 **제한적 허용** |
| `UPDATE` / `DELETE` 변경 | merge-on-read만 (positional) | Trino | **운영 테이블 금지**, 샌드박스에서만 허용 |
| Copy-on-write 테이블 변경 | **미지원** | Trino | **금지** (fail-closed) |
| `MERGE INTO` (Upsert) | REST 카탈로그 경유 지원 | Trino / Flink | **운영 테이블 금지**, 샌드박스에서만 허용 |
| 스키마 진화 (`ALTER TABLE`) | REST 카탈로그 경유 지원 | Trino | **DuckDB 금지**, DDL은 마이그레이션 잡 전용 |
| 스트리밍 고빈도 커밋 | 부적합 | Flink | Flink 전용 |

#### 안전한 쓰기 경계
- **운영 데이터 불변성 보장**: DuckDB 클라이언트는 `lake` 웨어하우스 및 모든 운영 네임스페이스(`raw`, `curated`, `lake`)에 대해 쓰기 권한(`modify`, `create`)이 엄격히 차단된다.
- **샌드박스 경계**: DuckDB의 쓰기는 격리된 `sandbox` 네임스페이스 또는 사용자 전용 스크래치 테이블에만 허용된다 ([이슈 #70](medallion-architecture-ko.md) 연계).
- **롤백 및 가비지 컬렉션**: DuckDB는 Iceberg REST 카탈로그 API를 통해 원자적으로 커밋하므로, 중단된 쓰기 작업은 객체 스토리지에 고아(orphaned) Parquet 파일을 남긴다. 이러한 고아 파일은 Airflow 유지보수 DAG([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L38-L50))의 주기적 스냅샷 만료 및 파일 정리 작업을 통해 회수된다.

### 1.6 검증 및 테스트 아이디어
- **읽기 동등성 테스트**: 동일한 Iceberg 스냅샷에 대해 DuckDB와 Trino로 `lake.orders`의 `SELECT count(*), sum(amount)`를 동시 실행하고 결과 차이가 0임을 검증.
- **삭제 읽기 음성 테스트**: 테스트 웨어하우스에 positional delete가 포함된 Iceberg 테이블을 생성하고, DuckDB 1.4 LTS 및 1.5+ 환경에서 읽기를 수행하여 실패/성공 여부를 실측.
- **쓰기 차단 음성 테스트**: DuckDB 클라이언트에서 `lake.events_enriched`에 `UPDATE`를 시도하여 Lakekeeper/OpenFGA에서 HTTP 403으로 거부됨을 확인.
- **Copy-on-Write 거부 테스트**: `write.update.mode='copy-on-write'`로 설정된 Iceberg 테이블에 `UPDATE`를 시도하여 DuckDB가 메타데이터 손상 없이 명시적 에러를 반환하는지 검증.

### 1.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-62-1 | DuckDB 쓰기를 샌드박스 네임스페이스로 영구 제한할 것인가, 골드 레이어에도 허용할 것인가? | **샌드박스 네임스페이스로 영구 제한** | Flink 및 Trino 컴팩션과의 잠재적 Iceberg 커밋 충돌 방지. |
| OD-62-2 | DuckDB를 1.4 LTS로 고정할 것인가, delete-vector 읽기를 위해 1.5.x/2.0.x로 올릴 것인가? | **초기에는 1.4 LTS 고정, CI에서 1.5+ 카나리 검증** | 안정성을 확보하면서 격리된 CI 파이프라인에서 삭제 벡터 호환성을 검증. |

### 1.8 후속 구현 작업
1. **T-62-1 (CI 호환성 스위트)**: 파티션, 정렬, 삭제 벡터가 포함된 합성 Iceberg 테이블을 질의하는 자동 CI 테스트 구축. 수용 기준: 삭제가 포함된 테이블에서 DuckDB가 부정확한 결과를 낼 경우 fail-closed로 실패.
2. **T-62-2 (쓰기 승인 필터)**: 대상 테이블이 `sandbox.*`에 속하지 않는 모든 쓰기 쿼리를 거부하는 클라이언트 래퍼 검증 로직 구현. 수용 기준: `lake.*` 대상 쓰기 시도가 단위 테스트에서 즉시 차단됨.

---

## 2. 쿼리 워크로드 라우팅 및 Trino 폴백 정책 (이슈 #63)

### 2.1 목적 및 수용 기준 매핑
이슈 #63은 DuckDB로 충분한 경우 DuckDB를 우선하고, 중앙 거버넌스, 분산 실행, BI 동시성이 요구되는 경우 Trino로 폴백하는 결정론적 워크로드 라우팅 정책을 수립하고, 수동 재정의 및 텔레메트리 연동을 구현할 것을 요구한다.

### 2.2 현재 상태 (검증됨)
- **단일 엔진 체계**: 현재 Trino가 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)의 유일한 쿼리 엔진이며, Superset 대시보드([`08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml))와 Airflow DAG([`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py))를 모두 전담한다.
- **ADR-0004 기준 매트릭스**: [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md#L64-L77)는 기본 규칙을 정의한다: 단일 사용자 노트북, CI 검증, 소규모 Airflow 변환은 DuckDB; 공유 BI, 연합 쿼리, 대규모 스캔, OPA 정책 대상 데이터는 Trino.

### 2.3 수용 기준 대비 격차
1. 엔진 선택을 자동화하는 프로그래밍 방식의 라우팅 레이어나 정량적 데이터 크기 임계값이 없다.
2. 수동 엔진 재정의 플래그(`BELUGA_SQL_ENGINE`)가 구현되어 있지 않다.
3. 미지원 문법, 메모리 초과, 인가 거부 발생 시의 결정론적 폴백 로직이 정의되지 않았다.
4. 폴백 카운터나 관련 메트릭이 수집되지 않는다.

### 2.4 제안 (Proposed)

#### 워크로드 분류 및 라우팅 규칙

```
                         수신된 SQL 쿼리 / 잡
                                   |
         +-------------------------+-------------------------+
         |                                                   |
쿼리가 PII 데이터셋에 접근하는가?              동시 접속이 발생하는 대시보드(Superset)
또는 OPA 행/열 마스킹 정책이 필요한가?         또는 공유 BI 워크로드인가?
         | 예                                                | 예
         v                                                   v
    [TRINO 전용]                                        [TRINO 전용]
         | 아니오                                            | 아니오
         +-------------------------+-------------------------+
                                   |
              CI 계약 검증, 로컬 ad-hoc 분석, 또는
              단일 파티션 소규모 ETL (< 5 GB)인가?
                                   |
                       +-----------+-----------+
                       | 예                    | 아니오
                       v                       v
                 [DUCKDB 우선]            [TRINO 전용]
                       |
             실행 에러 / 스필 한도 초과 / 미지원 문법 발생?
                       | 예
                       v
               [TRINO로 폴백] (텔레메트리 이벤트 기록)
```

| 워크로드 클래스 | 기본 엔진 | 선택 기준 | Trino 폴백 허용 여부 |
|---|---|---|---|
| **클래스 1: CI 및 스키마 검증** | **DuckDB** | 일회용 러너, 비-PII 테스트 웨어하우스, 스캔 < 1 GB | 불가 (실패 시 CI 즉시 중단) |
| **클래스 2: 단일 사용자 Ad-Hoc** | **DuckDB** | 비-PII 내부 데이터셋 대상 개발자 대화형 질의 | 허용 (문법 또는 용량 초과 시) |
| **클래스 3: 제한된 파이프라인 태스크** | **DuckDB** | 단일 파티션 대상 Airflow 변환, 스캔 < 5 GB | 허용 (메모리 한도 초과 시) |
| **클래스 4: 동시성 BI / Superset** | **Trino** | Superset 대시보드, 다수 분석가 동시 접속 | 해당 없음 (Trino 기본) |
| **클래스 5: 분산 및 연합 쿼리** | **Trino** | 스캔 > 5 GB, 이기종 조인 (Postgres + Iceberg) | 해당 없음 (Trino 기본) |
| **클래스 6: PII / 통제 정책 데이터** | **Trino** | `lake.customers` 또는 `trino.rego` 정책 대상 | **엄격히 금지** (DuckDB 경로 원천 차단) |

#### 정량적 라우팅 임계값 (제안)
- **스캔 데이터 상한**: DuckDB의 비압축 스캔 용량 상한을 5 GB로 제안. 5 GB 초과 예상 쿼리는 Trino로 라우팅.
- **파티션 상한**: 단일 DuckDB 쿼리가 스캔할 수 있는 최대 파티션 수를 50개로 제한.
- **메모리 한도**: DuckDB 프로세스 메모리를 4 GB로 제한 (`SET max_memory = '4GB'`).

#### 결정론적 폴백 사양
- **트리거 조건**: DuckDB 실행 중 다음 예외 발생 시 폴백 수행:
  1. `UNSUPPORTED_SYNTAX`: 분산 grouping sets 등 파서 또는 확장 미지원 문법 에러.
  2. `CAPACITY_LIMIT`: 메모리 및 스필 할당량 초과.
  3. `AUTH_UNSUPPORTED`: 테이블 권한 부재로 Lakekeeper 카탈로그가 거부.
- **결정론적 조치**: 클라이언트 래퍼가 예외를 포착하고, 정형화된 폴백 경고를 기록하며, Prometheus 카운터 `beluga_query_fallback_total`을 증가시킨 후, 동일 SQL을 HTTPS 포트 8443을 통해 Trino로 재전송.
- **수동 재정의**: 애플리케이션 및 CLI 스크립트에서 환경 변수 `BELUGA_SQL_ENGINE=duckdb`(DuckDB 강제, 폴백 없음) 또는 `BELUGA_SQL_ENGINE=trino`(Trino 강제) 지정 가능.

### 2.5 검증 및 테스트 아이디어
- **임계값 라우팅 테스트**: 10 GB 합성 데이터셋을 스캔하는 쿼리를 제출하여 라우터가 자동으로 Trino를 선택하는지 검증.
- **문법 폴백 테스트**: Trino 전용 함수를 포함한 쿼리를 라우터에 전달하여 Trino로 정상 폴백되고 텔레메트리가 기록되는지 확인.
- **PII 가드레일 테스트**: `SELECT * FROM lake.customers` 제출 시 라우터가 DuckDB를 무조건 거부하고 Trino를 강제하는지 확인.

### 2.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-63-1 | Trino 라우팅을 트리거할 기본 스캔 임계값은? | **제안: 5 GB 스캔 상한** | Beluga 프로파일의 일반적인 단일 노드 컨테이너 메모리 제한(4~8 GB)과 부합. |
| OD-63-2 | 배치 파이프라인 잡에서 조용한 폴백을 허용할 것인가? | **배치/CI는 즉시 실패, 대화형만 폴백** | 배치 ETL에서 조용히 폴백하면 성능 저하와 예기치 않은 비용이 은폐됨. |

### 2.7 후속 구현 작업
1. **T-63-1 (라우팅 라이브러리)**: 라우팅 매트릭스 및 수동 재정의 스위치를 구현한 Python 모듈 `beluga_router` 개발. 수용 기준: 6개 워크로드 클래스 전체에서 올바른 엔진 선택 검증.
2. **T-63-2 (폴백 메트릭 연동)**: 라우터 예외를 Prometheus 카운터에 연결. 수용 기준: 모의 실패 시 `beluga_query_fallback_total` 증가 확인.

---

## 3. 임베디드 DuckDB를 위한 통제된 자격증명 및 접근 경로 (이슈 #64)

### 3.1 목적 및 수용 기준 매핑
이슈 #64는 장기 공유 스토리지 자격증명을 배포하거나 Lakekeeper/Trino 정책 경계를 우회하지 않으면서, DuckDB 클라이언트를 위한 안전하고 통제된 자격증명 및 접근 모델을 정의할 것을 요구한다.

### 3.2 현재 상태 (검증됨)
- **Trino 스토리지 키 갭**: Trino는 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml#L26-L27)에서 정적 관리자 S3 액세스 키를 보유하고 있다. 이 키는 `beluga-lake` 버킷 전체에 접근할 수 있어 키 보유자에게 카탈로그 인가를 우회하는 경로가 된다. [ADR-0004](adr/0004-duckdb-complementary-analytics-engine-ko.md#L97-L100)는 이를 알려진 갭으로 명시하고 DuckDB가 이 패턴을 넓히지 않도록 규정했다.
- **Lakekeeper 부트스트랩**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L137)에서 `lake` 웨어하우스는 `"sts-enabled": false`와 정적 키로 생성된다. OpenFGA 웨어하우스 할당은 `service-account-trino`와 `service-account-flink`에 전체 권한을 부여한다 ([165~172행](gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L165-L172)).
- **네트워크 정책**: [`04b-lakehouse-network-policy.yaml`](../gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml#L57-L97)은 default-deny를 적용하며, `lakekeeper:8181` 인그레스를 Trino, Flink, APISIX, 부트스트랩 잡에만 허용한다. DuckDB 클라이언트용 인그레스 규칙은 없다.
- **분류**: `lake.customers`는 PII를 포함한다 (`policies/resources.yaml#L17`).

### 3.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB 카탈로그 시크릿** ([`https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html`](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html)):
  - OAuth2 attach 구문:
    ```sql
    CREATE SECRET lakekeeper_secret (
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

#### 2단계 접근 아키텍처

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
| 2단계: 통제된 운영 경로 (자격증명 발급 검증 게이트)                               |
|                                                                                   |
|  [DuckDB 클라이언트] ---OIDC 토큰---> [Lakekeeper:8181] (OpenFGA로 검증)          |
|         |                                      |                                  |
|         | <---임시 발급 STS 토큰---------------+ (임시 테이블 범위 토큰)          |
|         |                                                                         |
|         v                                                                         |
|  [SeaweedFS: s3://beluga-lake/] (운영 내부 데이터 - PII 제외)                     |
+-----------------------------------------------------------------------------------+
```

1. **1단계 (즉시 / CI / PoC)**:
   - 합성 데이터만 보관하는 전용 SeaweedFS 버킷 `beluga-test` 생성.
   - `s3://beluga-test/`를 가리키는 전용 Lakekeeper 웨어하우스 `test_warehouse` 생성.
   - `beluga-test`로만 범위가 제한된 정적 S3 자격증명 쌍 생성.
   - Keycloak 클라이언트 `duckdb-ci`를 생성하고 테스트 테이블에 대해서만 OpenFGA 테이블 단위 `select` 권한 부여.
2. **2단계 (운영 게이트)**:
   - `beluga-lake`에 대한 운영 데이터 접근은 작업 1(SeaweedFS STS 평가)에서 SeaweedFS가 범위 제한 자격증명을 발급할 수 있음이 증명될 때까지 **보류(BLOCKED)**된다. STS가 지원되지 않으면 DuckDB는 비-PII 테스트 웨어하우스로 영구 제한된다.
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
| OD-64-1 | SeaweedFS STS가 미지원될 경우, DuckDB를 테스트 버킷으로 영구 제한함을 확정하는가? | **제한 확정 (운영 접근 보류)** | ADR-0004 보안 원칙 3 준수. 버킷 단위 정적 키 허용 시 OpenFGA 테이블 단위 PII 보호가 무력화됨. |
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
- **기준 테이블**: [`policies/resources.yaml`](../policies/resources.yaml#L1-L23)의 `lake.events_enriched`(내부 이벤트), `lake.orders`(내부 주문), `lake.customers`(PII 고객).
- **기존 스크립트**: `tests/`에 테스트 스크립트가 존재하지만(`06-trino-query.sh`, `tests/run-all.sh`), 두 엔진 간 자동 결과 비교기는 없다.
- **벤치마크 요건**: ADR-0004 작업 10에서 CPU, 메모리, I/O, 기동 시간, 지연 시간, 동시성 비교를 요구하고 있다.

### 4.3 수용 기준 대비 격차
1. DuckDB와 Trino 결과 간의 행 수, 스키마, null 처리, 수치 출력을 자동 비교하는 도구가 없다.
2. 부동소수점 허용 오차 정책이 정의되지 않았다.
3. 프로세스 RSS, CPU 시간, I/O를 실측하는 벤치마크 실행 하네스가 없다.
4. 벤치마크 수치를 조작하지 않고 객관적 측정 방법론을 수립해야 한다.

### 4.4 제안 (Proposed)

#### 의미론적 일관성 검증 규칙
검증 스위트는 동일한 Iceberg 스냅샷 ID를 대상으로 동등한 SQL을 실행한다:

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
   - `TIMESTAMP` 정밀도: Trino 기본 `TIMESTAMP(6)`은 DuckDB 마이크로초 `TIMESTAMP`와 매핑.
2. **부동소수점 허용 오차 정책**:
   - `DOUBLE` 및 `FLOAT` 집계 계산은 SIMD 벡터화 연산 순서 차이로 인해 엄격한 일치를 요구하지 않음.
   - 상대 오차 기준 적용:
     $$\frac{|V_{\text{duckdb}} - V_{\text{trino}}|}{\max(|V_{\text{trino}}|, 10^{-9})} \le 10^{-6}$$
3. **정렬 및 Null 의미론**:
   - 명시적 `ORDER BY`가 없는 쿼리는 비교 하네스에서 기본키 기준으로 사전 정렬 후 행 단위 diff 수행.
   - `NULL` 정렬: DuckDB ASC 기본값은 `NULLS FIRST`, Trino는 `NULLS LAST`이므로 쿼리 작성 시 `NULLS LAST`를 명시하도록 표준화.

#### 재현 가능한 벤치마크 방법론 (수치 조작 금지)
- **대상 워크로드**:
  - *쿼리 클래스 A (필터/포인트)*: 파티션 컬럼 대상 고선택도 필터 (`event_date = '2026-10-01'`).
  - *쿼리 클래스 B (대량 집계)*: 1천만 행 대상 다중 컬럼 `GROUP BY` 및 `count(DISTINCT)`.
  - *쿼리 클래스 C (조인)*: 2개 테이블 해시 조인 (`orders`와 `events_enriched`).
  - *쿼리 클래스 D (윈도우 함수)*: `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY event_time)`.
- **수집 메트릭**:
  1. *콜드 스타트 지연 (ms)*: 프로세스 기동부터 첫 번째 결과 배치 수신까지의 시간.
  2. *쿼리 실행 시간 (ms)*: 쿼리 실행의 벽시계(wall-clock) 경과 시간.
  3. *최대 메모리 (RSS MiB)*: DuckDB는 `getrusage(RUSAGE_CHILDREN).ru_maxrss`, Trino는 JVM JMX 메모리 빈 측정.
  4. *CPU 소모량 (User + System ms)*: 프로세스가 소모한 CPU 시간.
  5. *스토리지 I/O 읽기 (MiB)*: HTTP/S3 게이트웨이를 통해 가져온 총 바이트 수.
- **보고 표준**: 하드웨어 프로파일, OS 커널, 엔진별 정확한 커밋 해시를 포함한 JSON 아티팩트로 출력하여 `docs/benchmarks/`에 보관.

### 4.5 검증 및 테스트 아이디어
- **자동화된 회귀 스위트**: 테스트 웨어하우스 스냅샷을 대상으로 `tests/duckdb-trino-parity.py`를 실행하여 diff가 0임을 검증.
- **인위적 결함 주입**: 테스트 브랜치에서 의도적인 문법 차이나 타입 불일치를 주입하여 하네스가 이를 감지하고 fail-closed로 실패하는지 확인.

### 4.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-65-1 | 비즈니스 리포팅을 위한 부동소수점 상대 허용 오차는? | **$10^{-6}$ 상대 오차** | 컴파일러 최적화 차이를 수용하면서 실질적인 수치 왜곡을 방지. |
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
- **현재 Airflow 오퍼레이터**: [`iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py#L24-L52)는 `analytics` 네임스페이스에서 `trinodb/trino:483` CLI 파드를 실행하는 `KubernetesPodOperator`를 사용한다.
- **버전 관리**: 현재 [`VERSIONS.md`](../VERSIONS.md)에 DuckDB는 포함되어 있지 않다.

### 5.3 수용 기준 대비 격차
1. `VERSIONS.md`에 DuckDB 바이너리 및 Python 라이브러리 버전이 고정되어 있지 않다.
2. 로컬 스크립트, CI, Airflow에서 공통 사용할 재사용 가능한 연결 헬퍼가 없다.
3. Airflow에 DuckDB 워크로드를 실행하기 위한 오퍼레이터 패턴이 없다.
4. 로컬 개발자 머신에서 클러스터 내부 S3 DNS(`seaweedfs-s3.storage.svc.cluster.local:8333`)를 직접 해석할 수 없다.

### 5.4 제안 (Proposed)

#### 버전 고정 (소유자 승인 시 `VERSIONS.md` 반영 제안)
- `duckdb`: 버전 `1.4.0` (LTS, 커뮤니티 지원 2026-11-17까지) 또는 `1.4.4` / `1.5.0` (소유자 질문 Q4 결정에 따름). 라이선스: `MIT`.
- `duckdb-iceberg-extension`: DuckDB 코어 버전과 일치하는 고정 릴리스. 라이선스: `MIT`.

#### 재사용 가능한 부트스트랩 헬퍼 (`beluga_duckdb` Python 모듈)
`scripts/helpers/duckdb_client.py`에 표준 연결 유틸리티 제공:
```python
import duckdb, os

def get_duckdb_iceberg_connection(catalog_endpoint, warehouse, client_id, client_secret, token_endpoint):
    con = duckdb.connect(":memory:")
    con.execute("INSTALL iceberg; LOAD iceberg;")
    con.execute(f"""
        CREATE TEMPORARY SECRET lakekeeper_auth (
            TYPE ICEBERG,
            CLIENT_ID '{client_id}',
            CLIENT_SECRET '{client_secret}',
            OAUTH2_SERVER_URI '{token_endpoint}',
            OAUTH2_SCOPE 'lakekeeper'
        );
    """)
    con.execute(f"""
        ATTACH '{warehouse}' AS lake (
            TYPE ICEBERG,
            ENDPOINT '{catalog_endpoint}',
            SECRET lakekeeper_auth
        );
    """)
    return con
```

#### CI 검증 워크플로우 통합
- 전용 CI 잡 추가 (`.github/workflows/duckdb-validation.yml` 및 `make validate-duckdb`):
  - 로컬 테스트 Parquet/Iceberg 메타데이터 픽스처를 대상으로 프로세스 내 DuckDB 실행.
  - Trino JVM 워커 기동 없이 5초 이내에 데이터 계약 스키마 검증 완료.

#### Airflow 태스크 통합 패턴
- `analytics` 네임스페이스에서 경량 Python 컨테이너를 실행하는 `BelugaDuckDBPodOperator` 구현:
  - `keycloak-duckdb-secrets`로부터 Keycloak 클라이언트 자격증명 마운트.
  - 5 GB로 제한된 `emptyDir` 스크래치 볼륨 구성.
  - 리소스 제한 강제 (`requests: memory: 512Mi, cpu: 250m`; `limits: memory: 2Gi, cpu: 1000m`).

#### 로컬 개발자 워크플로우 접근 경로
- 로컬 개발자 머신은 클러스터 내부 DNS에 도달할 수 없다.
- *제안된 로컬 접근 경로*: 로컬 `/etc/hosts` 항목(`catalog.local.beluga.internal:443`, `s3.local.beluga.internal:443`)을 사용하여 APISIX 게이트웨이를 경유하고, TLS 종료 및 사용자 범위 bearer 토큰을 사용해 접근.

### 5.5 검증 및 테스트 아이디어
- **독립형 CI 테스트**: 깨끗한 워크스페이스에서 `make test-duckdb-ci`를 실행하여 Trino 파드 없이 Iceberg 메타데이터 계약 검사가 성공하는지 확인.
- **Airflow DAG 파싱 테스트**: `tests/`에 `test_duckdb_dag_render.py`를 추가하여 문법 에러 없이 DAG가 파싱 및 렌더링되는지 확인.

### 5.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-66-1 | Airflow 파드에서 DuckDB를 실행할 기본 베이스 이미지는? | **`python:3.12-slim` + 휠 고정** | 이미지 풀 시간 단축 및 컨테이너 공격 표면 최소화. |
| OD-66-2 | 로컬 CLI 접근에 게이트웨이 HTTPS를 쓸 것인가, port-forward를 쓸 것인가? | **게이트웨이 HTTPS (`*.local.beluga.internal`)** | Beluga의 도메인 레지스트리 규약 준수 및 TLS 인증서 강제. |

### 5.7 후속 구현 작업
1. **T-66-1 (연결 헬퍼)**: `scripts/helpers/duckdb_client.py` 구현. 수용 기준: 단위 테스트에서 시크릿 생성 및 연결 파라미터 유효성 확인.
2. **T-66-2 (Airflow 오퍼레이터)**: `gitops/charts/beluga-data/files/dags/operators/`에 `BelugaDuckDBPodOperator` 구현. 수용 기준: 로컬 개발 스택에서 테스트 DAG 정상 실행.

---

## 6. 엔진 수준 메트릭 및 리소스 귀속 (이슈 #67)

### 6.1 목적 및 수용 기준 매핑
이슈 #67은 DuckDB를 상시 서비스로 만들지 않으면서, DuckDB와 Trino의 엔진 선택, 실행 결과, 폴백, 리소스 소모량을 측정 가능하게 만들 것을 요구한다.

### 6.2 현재 상태 (검증됨)
- **Trino 텔레메트리**: Trino는 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)에서 Prometheus JMX exporter를 통해 메트릭을 발행한다.
- **클러스터 모니터링**: Prometheus가 `monitoring` / `platform-system` 네임스페이스에서 동작한다.
- **임베디드 DuckDB 갭**: DuckDB는 클라이언트 작업 내부에 임베디드로 실행되므로 전통적인 상시 `/metrics` 스크랩 엔드포인트가 기본적으로 존재하지 않는다.

### 6.3 수용 기준 대비 격차
1. 쿼리 실행을 DuckDB와 Trino로 구분해 기록하는 단일 텔레메트리 스키마가 없다.
2. 잡 단위의 DuckDB CPU 시간, 최대 RSS, 스필 용량, I/O가 모니터링되지 않는다.
3. 라우팅 결정 및 폴백 이벤트가 Prometheus에 집계되지 않는다.
4. 자격증명이나 PII 유출을 방지하기 위해 원시 SQL 쿼리가 로그에 남지 않도록 해야 한다.

### 6.4 제안 (Proposed)

#### 정형화된 실행 이벤트 스키마
모든 쿼리 실행(DuckDB 또는 Trino)은 다음 구조의 정형 JSON 로그 이벤트를 발행한다:

```json
{
  "event_id": "evt-7f8a9b2c-3d4e",
  "timestamp": "2026-10-08T00:30:00Z",
  "engine": "duckdb",
  "engine_version": "1.4.0",
  "workload_class": 2,
  "caller": "airflow-iceberg-compaction",
  "dataset": "lake.events_enriched",
  "query_hash": "a1b2c3d4e5f6...",
  "status": "SUCCESS",
  "fallback_reason": null,
  "elapsed_ms": 1420,
  "cpu_user_ms": 1150,
  "cpu_sys_ms": 120,
  "peak_rss_bytes": 536870912,
  "spill_bytes": 0,
  "bytes_scanned": 104857600,
  "rows_returned": 50000
}
```

*개인정보 보호 제약*: 원시 SQL 텍스트 및 리터럴 파라미터 값은 **절대 로깅하지 않는다**. 정규화된 `query_hash`와 대상 `dataset`만 포함한다.

#### 텔레메트리 수집 및 메트릭 연동
- **임시 작업 (CI 및 Airflow)**:
  - DuckDB 쿼리 실행 시 `PRAGMA enable_profiling = 'json';`으로 프로파일링 활성화.
  - 태스크 완료 시 실행 이벤트 스키마로 포맷팅하여 `stdout`으로 출력. Fluentbit/Vector가 로그 스트림 수집.
  - Airflow에서는 태스크 완료 시 Prometheus Pushgateway로 메트릭 전송.
- **Prometheus 메트릭 (제안)**:
  - `beluga_query_executions_total{engine="duckdb|trino", class="1..6", status="SUCCESS|FAILED|FALLBACK"}`
  - `beluga_query_fallback_total{reason="UNSUPPORTED_SYNTAX|CAPACITY_LIMIT|OPA_REQUIRED", class="1..6"}`
  - `beluga_query_execution_duration_seconds{engine="duckdb|trino", class="1..6"}`
  - `beluga_query_peak_memory_bytes{engine="duckdb|trino", class="1..6"}`

### 6.5 검증 및 테스트 아이디어
- **로그 스키마 검증 테스트**: 래퍼를 통해 DuckDB 쿼리를 실행하고 생성된 로그가 JSON 스키마를 만족하며 평문 SQL 리터럴이 없는지 확인.
- **Prometheus 수집 테스트**: 모의 폴백 쿼리를 발생시켜 Prometheus 스크랩 데이터에서 `beluga_query_fallback_total` 카운터가 증가하는지 확인.

### 6.6 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-67-1 | 표준 텔레메트리 파이프라인: stdout 로깅 대 Pushgateway? | **기본은 stdout JSON 로깅, Airflow는 Pushgateway 병행** | 기존 Fluentbit 파이프라인을 재사용하고 단순 CLI 도구에 불필요한 서버 의존성을 추가하지 않음. |

### 6.7 후속 구현 작업
1. **T-67-1 (텔레메트리 에미터)**: Python 래퍼에 `beluga_metrics` 로깅 데코레이터 구현. 수용 기준: 단위 테스트에서 스키마 준수 확인.
2. **T-67-2 (Grafana 대시보드 패널)**: 플랫폼 Grafana 대시보드에 DuckDB vs Trino 엔진 귀속 패널 추가. 수용 기준: 엔진별 쿼리 수 및 폴백 빈도 표시.

---

## 7. 결과 재사용, 디스크 스필 및 임시 데이터 수명주기 (이슈 #68)

### 7.1 목적 및 수용 기준 매핑
이슈 #68은 DuckDB를 통제 불능의 영구 저장소로 만들거나 테넌트 간 PII를 유출하지 않으면서, DuckDB 워크로드의 안전하고 측정 가능한 결과 재사용/캐싱 및 임시 데이터 수명주기를 정의할 것을 요구한다.

### 7.2 현재 상태 (검증됨)
- **수명주기 보존 정책**: [`docs/data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md#L28)는 스크래치, 재작성, 체크포인트를 위한 `temporary` 등급을 정의하며 자동 수명 기반 정리를 규정한다.
- **SeaweedFS Prefix**: [`12-lakekeeper-bootstrap.yaml`](../gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml#L5)은 일시적 재작성/체크포인트/스크래치 데이터용으로 `tmp/`를 지정한다.
- **스토리지 경계**: Kubernetes 워커 노드의 디스크 공간은 유한하며, 임시 파드 스토리지 상한을 두지 않으면 노드 디스크 고갈이 발생할 수 있다.

### 7.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB 동시성 및 스토리지** ([`https://duckdb.org/docs/current/connect/concurrency`](https://duckdb.org/docs/current/connect/concurrency)): DuckDB는 단일 프로세스 모드로 동작한다. 기본적으로 시스템 한도까지 메모리를 사용하며, 중간 데이터가 한도를 초과하면 `SET temp_directory = 'path'`로 지정된 디렉터리로 디스크 스필을 수행한다.

### 7.4 수용 기준 대비 격차
1. DuckDB 디스크 스필이나 중간 Parquet 파일에 대한 공식적인 수명주기 한도, TTL, 용량 상한이 없다.
2. Iceberg 스냅샷 ID와 연동된 캐시 무효화가 구현되지 않았다.
3. 공유 임시 파일에 PII가 잔류하지 못하도록 방지하는 보호 장치가 없다.
4. 실패하거나 중단된 작업이 호스트에 무제한 스필 파일을 남길 위험이 있다.

### 7.5 제안 (Proposed)

#### 임시 아티팩트 수명주기 정책 매트릭스

| 아티팩트 클래스 | 저장 위치 | 최대 크기 한도 (상한) | 보존 기간 / TTL | 정리 메커니즘 |
|---|---|---|---|---|
| **메모리 내 버퍼** | 프로세스 RAM (힙) | 4 GB (`max_memory`) | 쿼리 실행 시간 | 프로세스 종료 시 자동 해제 |
| **디스크 스필 파일** | 컨테이너 `/tmp/duckdb_spill/` | 파드당 10 GB | 쿼리 실행 시간 | DuckDB 엔진 자체 정리; 파드 종료 시 `emptyDir` 삭제 |
| **중간 Parquet 파일** | 컨테이너 `/tmp/scratch/<job_id>/` | 잡당 5 GB | 최대 2시간 | 컨테이너 `trap cleanup EXIT` 핸들러; Airflow 태스크 훅 |
| **영구 `.duckdb` 파일** | 공유/운영 환경 금지 | 10 GB (로컬 개발 전용) | 24시간 | 로컬 개발자 책임 / tmpfs 초기화 |

#### 캐시 격리 및 PII 경계 보호
- **공유 캐시 원천 금지**: DuckDB 스크래치 디렉터리와 스필 파일은 사용자, 테넌트, 파이프라인 DAG 간에 절대 공유되어서는 안 된다. 모든 실행은 격리된 경로를 사용해야 한다: `/tmp/scratch/${TENANT_ID}/${JOB_ID}/`.
- **PII 캐싱 절대 금지**: `pii`로 분류된 데이터셋(`lake.customers`, [`policies/resources.yaml`](../policies/resources.yaml#L17))은 **디스크 기반 캐싱이나 스필이 엄격히 금지**된다. PII가 포함된 쿼리가 메모리 내에서 완료되지 못하면 실패하거나 Trino에서 실행되어야 한다. PII의 디스크 구체화는 전면 차단된다.

#### 스냅샷 인지형 결과 재사용
- 캐시된 중간 테이블이나 Parquet 요약본은 반드시 다음 키로 캐시 키를 구성해야 한다:
  $$\text{CacheKey} = \text{SHA256}(\text{TableUUID} + \text{SnapshotID} + \text{QueryHash} + \text{EngineVersion})$$
- Lakekeeper에서 원천 테이블의 스냅샷 ID가 갱신되면, 이전 스냅샷 ID와 연관된 모든 캐시 아티팩트는 즉시 무효화된다.

#### Kubernetes 내 제한된 임시 볼륨 강제
- DuckDB를 실행하는 모든 Kubernetes 파드는 명시적인 `emptyDir` 볼륨 리소스 제약을 지정해야 한다:
  ```yaml
  volumes:
    - name: duckdb-scratch
      emptyDir:
        sizeLimit: 10Gi
  ```
- 쿼리가 10 GiB 한도를 초과하면 kubelet이 파드를 축출(evict)하여 노드 디스크 고갈을 방지한다.

### 7.6 검증 및 테스트 아이디어
- **디스크 스필 정리 테스트**: 500 MB 데이터셋을 대상으로 `SET max_memory = '64MB'`를 설정하여 강제 스필을 유도한 뒤, 쿼리 완료 시 `temp_directory`의 모든 `.tmp` 파일이 삭제되는지 확인.
- **중단 정리 테스트**: DuckDB 러너 프로세스를 `SIGKILL`로 강제 종료한 뒤, 래퍼 trap 또는 컨테이너 재기동이 스크래치 디렉터리를 깨끗이 비우는지 확인.
- **PII 구체화 거부 테스트**: `COPY (SELECT * FROM lake_catalog.lake.customers) TO '/tmp/customers.parquet'` 실행 시도 시 보안 래퍼가 이를 감지하고 거부하는지 확인.

### 7.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-68-1 | 파드 `emptyDir` 스크래치 볼륨의 스토리지 상한은? | **제안: 10 GiB 상한** | 비파티션 스필로 인해 노드 루트 파일시스템이 고갈되는 것을 방지. |
| OD-68-2 | DAG 태스크 간 중간 Parquet 재사용을 허용할 것인가? | **동일 DAG 실행(run) 내에서만 허용** | 다단계 DAG의 속도를 높이면서 실행 간 데이터 불일치를 방지. |

### 7.8 후속 구현 작업
1. **T-68-1 (스필 구성)**: 부트스트랩 연결 헬퍼에 기본 `temp_directory` 및 `max_memory` 설정. 수용 기준: 저메모리 조건에서 전용 볼륨으로 스필 발생 확인.
2. **T-68-2 (Kubernetes 볼륨 한도)**: 스크래치 마운트에 `sizeLimit: 10Gi`를 포함하도록 파드 템플릿 수정. 수용 기준: 한도 초과 파드가 안전하게 축출됨.

---

## 8. Quack 원격 프로토콜 평가 게이트 (이슈 #69)

### 8.1 목적 및 수용 기준 매핑
이슈 #69는 DuckDB Quack 프로토콜을 공유 경량 쿼리/서비스 워크로드로 검토하기 전에, 임베디드 DuckDB 설계가 먼저 입증되도록 보장하는 별도의 증거 기반 평가 게이트를 정의할 것을 요구한다.

### 8.2 현재 상태 (검증됨)
- **중앙 서비스 아키텍처**: Trino가 [`06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml)에서 Beluga의 중앙 분산 쿼리 서비스로 동작하며, APISIX 인그레스 라우팅([`10-apisix-route.yaml`](../gitops/charts/beluga-data/templates/10-apisix-route.yaml)), Keycloak OAuth2([`06-trino.yaml#L81-L85`](../gitops/charts/beluga-data/templates/06-trino.yaml#L81-L85)), OpenFGA와 연동되어 있다.
- **ADR-0004 결정**: [ADR-0004 결정 2](adr/0004-duckdb-complementary-analytics-engine-ko.md#L57-L58)는 Quack을 범위 밖으로 명시했다: *"DuckDB는 상시 서비스가 아니라 클라이언트/잡에 임베디드로 실행한다. DuckDB/Quack 서버 모드는 범위 밖이며 임베디드 경로 검증 후 별도 평가한다."*

### 8.3 외부 문서 및 증거 (2026-10-08 열람)
- **DuckDB Quack 개요** ([`https://duckdb.org/docs/current/quack/overview`](https://duckdb.org/docs/current/quack/overview)):
  - 2026년 5월 12일 릴리스.
  - *"The Quack extension turns a DuckDB instance into a server that other DuckDB instances (clients) can connect to over HTTP."* (Quack 확장은 다른 DuckDB 인스턴스가 HTTP로 연결할 수 있는 서버로 DuckDB를 전환함).
  - 업스트림 공식 경고: *"Warning: Quack is under active development and the protocol, function names, settings, and defaults are still subject to change."* (Quack은 활발히 개발 중이며 프로토콜, 함수명, 설정, 기본값이 여전히 변경될 수 있음).
- **DuckDB Quack 보안 가이드** ([`https://duckdb.org/docs/current/quack/security`](https://duckdb.org/docs/current/quack/security)):
  - 노출 모델: *"A Quack server exposes the full SQL surface of the underlying DuckDB instance, including read and write access to every table the server's session can see."* (Quack 서버는 세션이 볼 수 있는 모든 테이블의 읽기/쓰기 권한을 포함하여 기본 DuckDB 인스턴스의 전체 SQL 표면을 노출함).
  - 프로덕션 배포를 위해 외부 TLS 종료 역방향 프록시가 필수적임.
  - 기동 시 생성되는 무작위 인증 토큰에 의존하며, 엔터프라이즈 멀티 테넌트 RBAC, 행 수준 보안, 감사 신원 귀속 기능이 기본 제공되지 않음.

### 8.4 수용 기준 대비 격차
1. Quack은 활발한 베타 개발 단계에 있어 프로토콜 안정성이 확보되지 않았다.
2. 상시 구동 Quack 데몬을 도입하면 상시 인프라 오버헤드가 다시 발생하여, 임베디드 DuckDB를 도입한 핵심 이유와 모순된다.
3. Beluga 환경에서 Quack의 멀티 테넌트 보안, TLS 종료, OpenFGA 정책 통합이 전혀 검증되지 않았다.

### 8.5 제안 (Proposed)

#### 공식 평가 게이트 (Quack 검토를 위한 전제 조건)
다음 4개 게이트가 모두 통과하기 전까지 Quack은 **보류 / 범위 밖(DEFERRED / OUT OF SCOPE)** 상태를 유지한다:

```
  [게이트 Q-1: 임베디드 안정성 입증]
  임베디드 DuckDB가 프로덕션 CI 및 파이프라인에서 데이터 손상 없이 90일 이상 성공적으로 운용됨
               |
               v 통과
  [게이트 Q-2: 필요성에 대한 증거]
  공유 warm-state 또는 중앙 경량 캐시가 CPU/IO를 50% 이상 절감한다는 측정 가능한 요구사항 입증
               |
               v 통과
  [게이트 Q-3: 업스트림 프로토콜 안정화]
  업스트림 DuckDB 공식 문서에서 Quack 프로토콜이 베타를 벗어나 정식(GA) 릴리스로 확정됨
               |
               v 통과
  [게이트 Q-4: 엔터프라이즈 보안 검증]
  APISIX TLS 종료, Keycloak OIDC 인증, 테넌트 간 데이터 누출을 차단하는 세션 격리 아키텍처 검증
               |
               v 통과
  [소유자의 Quack 평가 착수 승인]
```

#### 기준 아키텍처 결정
- **Quack은 현재 Beluga 기준 아키텍처에서 기각(REJECTED)된다.**
- 임베디드 DuckDB가 유일하게 승인된 DuckDB 실행 형태이다.
- 공유 서비스 워크로드는 전적으로 Trino가 전담한다.

### 8.6 검증 및 테스트 아이디어
- 게이트 Q-1부터 Q-4가 모두 충족되는 경우, 50개 동시 ad-hoc 쿼리를 대상으로 Quack과 Trino의 동시성 벤치마크를 수행하여 메모리 누수 안정성, 크래시 격리, TLS 종료 지연 시간을 측정.

### 8.7 남은 소유자 결정
| ID | 질문 | 권고안 | 근거 |
|---|---|---|---|
| OD-69-1 | Quack이 현재 Beluga 아키텍처에서 범위 밖임을 확정하는가? | **범위 밖 확정** | 아키텍처 비대화를 방지하고 임베디드 DuckDB 검증에 집중. |

### 8.8 후속 구현 작업
1. **T-69-1 (업스트림 추적)**: 분기별 플랫폼 유지보수 리뷰 시 DuckDB Quack 릴리스 노트 모니터링. 수용 기준: 분기별 아키텍처 검토 문서에 현황 기록.

---

## 9. 종합 소유자 결정 표

| ID | 이슈 | 질문 | 권고안 | 우선순위 |
|---|---|---|---|---|
| **OD-62-1** | #62 | DuckDB 쓰기를 샌드박스 네임스페이스로 영구 제한할 것인가? | **샌드박스 전용으로 제한, 운영 `lake.*`는 읽기 전용** | P1 |
| **OD-62-2** | #62 | DuckDB를 1.4 LTS로 고정할 것인가, 1.5.x/2.0.x로 올릴 것인가? | **초기에는 1.4 LTS 고정, CI에서 1.5+ 카나리 검증** | P1 |
| **OD-63-1** | #63 | 자동 Trino 라우팅을 트리거할 기본 데이터 스캔 상한은? | **제안: 5 GB 스캔 상한** | P2 |
| **OD-63-2** | #63 | 배치 파이프라인 잡에서 조용한 Trino 폴백을 허용할 것인가? | **배치/CI는 즉시 실패, 대화형만 폴백** | P2 |
| **OD-64-1** | #64 | SeaweedFS STS가 미지원될 경우 테스트 버킷으로 영구 제한함을 확정하는가? | **제한 확정 (운영 접근 보류)** | P1 |
| **OD-64-2** | #64 | 개발자 대화형 인증: 사용자 bearer 토큰 대 서비스 계정? | **CLI/노트북에 사용자 bearer 토큰 사용** | P2 |
| **OD-65-1** | #65 | 수용 가능한 부동소수점 상대 허용 오차는? | **$10^{-6}$ 상대 오차** | P2 |
| **OD-65-2** | #65 | 버전 관리되는 벤치마크 출력 JSON을 어디에 보관할 것인가? | **저장소 내 `docs/benchmarks/`** | P3 |
| **OD-66-1** | #66 | Airflow 파드에서 DuckDB를 실행할 기본 베이스 이미지는? | **`python:3.12-slim` + 휠 고정** | P2 |
| **OD-66-2** | #66 | 로컬 CLI 접근에 게이트웨이 HTTPS를 쓸 것인가, 포트포워딩을 쓸 것인가? | **게이트웨이 HTTPS (`*.local.beluga.internal`)** | P2 |
| **OD-67-1** | #67 | 표준 텔레메트리 파이프라인: stdout 로깅 대 Pushgateway? | **기본은 stdout JSON 로깅, Airflow는 Pushgateway 병행** | P2 |
| **OD-68-1** | #68 | 파드 `emptyDir` 스크래치 볼륨의 스토리지 상한은? | **제안: 10 GiB 상한** | P2 |
| **OD-68-2** | #68 | DAG 태스크 간 중간 Parquet 재사용을 허용할 것인가? | **동일 DAG 실행(run) 내에서만 허용** | P2 |
| **OD-69-1** | #69 | Quack이 현재 Beluga 플랫폼에서 범위 밖임을 확정하는가? | **범위 밖 확정** | P1 |

---

## 10. 종합 후속 구현 작업 표

| 작업 ID | 이슈 | 설명 | 선행 조건 | 수용 테스트 아이디어 |
|---|---|---|---|---|
| **T-62-1** | #62 | 파티션 및 삭제 벡터가 포함된 합성 Iceberg 테이블을 질의하는 CI 테스트 구축. | 없음 | CI 러너가 비삭제 테이블에서 Trino와 결과 일치 확인 및 삭제 테이블에서 fail-closed 확인. |
| **T-62-2** | #62 | `lake.*` 대상 쓰기 쿼리를 거부하는 클라이언트 래퍼 검증 로직 구현. | T-62-1 | 운영 테이블 대상 `INSERT/UPDATE` 쿼리 차단 단위 테스트 통과. |
| **T-63-1** | #63 | 라우팅 규칙 및 수동 재정의 스위치를 구현한 Python 모듈 `beluga_router` 개발. | T-62-2 | 6개 워크로드 클래스 전체에서 올바른 엔진 선택 단위 테스트 통과. |
| **T-63-2** | #63 | 폴백 텔레메트리를 위한 Prometheus 클라이언트 카운터 연동. | T-63-1 | 모의 쿼리 실패 시 `beluga_query_fallback_total` 카운터 증가. |
| **T-64-1** | #64 | SeaweedFS 대상 STS `AssumeRole` 호환성 자동 검증 스크립트 실행. | 없음 | STS 지원 상태를 확인하는 프로브 스크립트 출력 문서화. |
| **T-64-2** | #64 | 부트스트랩 잡에서 버킷 `beluga-test` 및 웨어하우스 `test_warehouse` 생성. | T-64-1 | 테스트 자격증명으로 합성 테이블 질의 성공. |
| **T-64-3** | #64 | `04b-lakehouse-network-policy.yaml`에 DuckDB 클라이언트 파드 셀렉터 추가. | 없음 | `make validate` 통과 및 실제 연결 수립. |
| **T-65-1** | #65 | Python 기반 결과 비교 CLI `tests/duckdb-trino-parity.py` 구축. | T-64-2 | 합성 데이터셋 대상 쿼리 클래스 A~D 검증 통과. |
| **T-65-2** | #65 | RSS, CPU, I/O를 실측하는 벤치마크 러너 스크립트 작성. | T-65-1 | 유효한 스키마 준수 요약 JSON 생성. |
| **T-66-1** | #66 | 재사용 가능한 연결 헬퍼 `scripts/helpers/duckdb_client.py` 구현. | T-64-2 | 단위 테스트에서 시크릿 생성 및 연결 파라미터 유효성 확인. |
| **T-66-2** | #66 | Airflow 오퍼레이터 디렉터리에 `BelugaDuckDBPodOperator` 구현. | T-66-1 | 로컬 개발 스택에서 테스트 DAG 정상 실행. |
| **T-67-1** | #67 | Python 래퍼에 `beluga_metrics` 로깅 데코레이터 구현. | T-66-1 | 평문 SQL 리터럴 없이 JSON 스키마를 준수하는 로그 출력 단위 테스트 통과. |
| **T-67-2** | #67 | 플랫폼 Grafana 대시보드에 DuckDB vs Trino 엔진 귀속 패널 추가. | T-67-1 | 대시보드에 엔진별 쿼리 수 및 폴백 빈도 정상 표시. |
| **T-68-1** | #68 | 부트스트랩 연결 헬퍼에 기본 `temp_directory` 및 `max_memory` 설정. | T-66-1 | 저메모리 조건에서 전용 볼륨으로 스필 발생 확인. |
| **T-68-2** | #68 | 스크래치 마운트에 `sizeLimit: 10Gi`를 포함하도록 파드 템플릿 수정. | 없음 | 한도 초과 파드가 안전하게 축출됨. |
| **T-69-1** | #69 | 분기별 플랫폼 유지보수 리뷰 시 DuckDB Quack 릴리스 노트 모니터링. | 없음 | 분기별 아키텍처 검토 문서에 현황 기록. |
