# 거버넌스 기반 소스 온보딩, 외부 연동 및 수집 정합성 검증 프레임워크 (제안)

[English](source-onboarding-and-intake.md) | 한국어

관련 이슈: #71, #75, #77, #78, #82.

> **상태: 제안 (PROPOSAL). 문서 전용.** 본 문서로 변경되는 매니페스트, DAG, 스크립트, 정책, 레지스트리 또는 `VERSIONS.md` 값은 없으며, 어떠한 커넥터나 파이프라인도 배포되지 않습니다. 저장소 관련 서술은 `origin/main` 커밋 `d424c38` 기준 `file:line` 실측에 근거합니다. 라이브 클러스터 사실은 2026-10-08 지정된 격리 kubeconfig(`/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`)로 실행한 읽기 전용 조회에 기반하며, 실측하지 못한 항목은 **라이브 미검증(not verified live)**으로 명시합니다. 외부 표준은 2026-10-08 열람한 공식 문서에 근거합니다([참고 문헌](#8-참고-문헌)). **제안(Proposed)**으로 표기된 항목은 설계 제안이며 현재 구현되어 있지 않습니다.

관련 문서:
- [`medallion-architecture-ko.md`](medallion-architecture-ko.md) (브론즈 적재, 스키마 진화 및 미결 결정 Q1–Q7)
- [`data-standards-ko.md`](data-standards-ko.md) 및 [`policies/data-standards.yaml`](../policies/data-standards.yaml) (메타데이터 기준선, 식별자 명명 규칙, 분류값 `internal` 및 `pii`)
- [`data-contract-standard-ko.md`](data-contract-standard-ko.md) (Open Data Contract Standard 기준선)
- [`data-quality-framework-ko.md`](data-quality-framework-ko.md) (품질 차원, 게이트 메커니즘)
- [`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) (리니지 전파 및 메타데이터 완전성)
- [`pii-classification-enforcement-ko.md`](pii-classification-enforcement-ko.md) (데이터 민감도 및 마스킹 규칙)
- [`data-lifecycle-policy-ko.md`](data-lifecycle-policy-ko.md) (보존 훅 및 스냅샷 만료)

---

## 1. 목적 및 이슈 매핑

본 제안은 데이터 수집 및 거버넌스와 밀접하게 연계된 5개 이슈를 단일 플랫폼 수집 아키텍처로 통합합니다:
1. **이슈 #71**: 이기종 소스 온보딩 프레임워크 (소스 등록, 브론즈 적재, 재생 가능성).
2. **이슈 #75**: 데이터베이스 스키마 발견, 프로파일링 및 리버스 엔지니어링 프레임워크 (PostgreSQL, MySQL, Oracle, MSSQL).
3. **이슈 #77**: OpenAPI 및 비관계형 소스를 위한 외부 API 커넥터 프레임워크 (인증, 페이지네이션, 레이트 리밋, 재시도).
4. **이슈 #78**: OpenAPI 기반 외부 연동 계약 및 스키마 거버넌스 (드리프트 감지, 계약 버전 관리).
5. **이슈 #82**: 거버넌스 기반 데이터 수집 제어 평면 및 소스-플랫폼 정합성 조정 (실행 라이프사이클, Iceberg 스냅샷별 레코드 건수 및 체크섬 일치).

| 이슈 | 인수 조건 (Acceptance Criterion) | 다루는 절 |
|---|---|---|
| #71 | 주요 소스 클래스별 최소 1개 소스를 문서화된 템플릿으로 온보딩 | 4.1 |
| #71 | 브론즈 데이터셋에 일관된 수집 메타데이터(`_ingest_ts`, `_source_ref` 등) 포함 | 4.1 |
| #71 | 스키마 변경 및 이상 레코드가 문서화된 격리(quarantine) 동작을 따름 | 4.1 |
| #71 | 재생 및 백필이 의도치 않은 중복 없이 결정론적으로 동작 | 4.1, 4.5 |
| #71 | 소스에서 브론즈까지 리니지 및 소유권 가시성 확보 | 4.1, 4.5 |
| #71 | 거버넌스/보안 메타데이터 누락 시 프로덕션 온보딩 사전 검사(preflight) 실패 | 4.1, 5.1 |
| #75 | 대표 RDBMS(PostgreSQL, MySQL, Oracle, MSSQL)를 문서화된 어댑터로 발견 가능 | 4.2 |
| #75 | 데이터베이스 엔진 간 일관된 표준 스키마 모델 생성 | 4.2 |
| #75 | 키, 관계, 인덱스 및 제약조건 캡처 | 4.2 |
| #75 | 무제한 전체 테이블 스캔 없이 행/열 통계를 포함한 프로파일링 보고서 생성 | 4.2 |
| #75 | 정책 모델에 따라 PII 후보를 분류하고 샘플 데이터 보호 | 4.2 |
| #75 | 두 번의 발견 실행 결과를 비교(diff)하여 스키마/프로파일 변경 감지 | 4.2 |
| #75 | 최소 권한 발견 자격증명 및 오픈소스 라이선스 준수 | 4.2 |
| #77 | OpenAPI로 기술된 대표 소스를 재사용 가능한 커넥터 패턴으로 등록 및 수집 | 4.3, 4.4 |
| #77 | 커넥터 코드 변경 없이 OAuth2 및 API 키 자격증명을 안전하게 주입하고 로테이션 | 4.3 |
| #77 | 페이지네이션, 레이트 리밋, 재시도 및 증분 추출 시연 | 4.3 |
| #77 | 원본 페이로드 및 출처 보존, HTTP 장애 관측 및 격리 처리 | 4.3 |
| #77 | 외부 제공자 의존 없이 목(mock) API를 상대로 커넥터 테스트 실행 | 4.3, 5.3 |
| #78 | OpenAPI 3.x 규격을 등록, 검증, 버전 관리하고 커넥터 계약으로 활용 | 4.4 |
| #78 | 파괴적(breaking) 변경과 비파괴적 API 변경을 자동 검사로 감지 | 4.4 |
| #78 | 선언된 계약 대비 관측된 페이로드 드리프트 보고 | 4.4 |
| #78 | OpenAPI가 없는 API는 동등한 거버넌스 스키마 경로 사용 | 4.4 |
| #82 | 대표 DB, API, 에지, 파일 플로우의 라이프사이클 및 상태 가시화 | 4.5 |
| #82 | 소스 대 플랫폼 정합성 조정이 의도적 불일치를 감지 | 4.5, 5.4 |
| #82 | 부분/중복 전송을 결정론적으로 감지하고 처리 | 4.5 |
| #82 | 재생/복구 증적 보존 | 4.5 |
| #82 | 신선도 및 SLA 위반을 카탈로그/품질 메타데이터에 노출 | 4.5 |

---

## 2. 현재 상태 (검증됨)

### 2.1 저장소 아티팩트 (코드 및 매니페스트)

현재 플랫폼은 특정 수집 컴포넌트를 구현하고 있으나, 범용적인 온보딩 및 수집 제어 평면은 부재합니다:

- **Debezium CDC 수집**:
  - Debezium Kafka Connect는 독립 Deployment `debezium-connect`(`gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:120-191`)로 배포되어 이미지 `quay.io/debezium/connect:3.6.1.Final`(`:135`)을 사용하며, 포트 8083의 Service `debezium-connect`(`:192-205`)를 엽니다.
  - 커넥터 등록 Job `debezium-register-shop`(`gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:207-275`)은 `http://debezium-connect.streaming.svc.cluster.local:8083/connectors/shop-cdc/config`(`:252-275`)에 멱등한 HTTP PUT 요청을 보내 `shop-cdc` 커넥터를 등록합니다.
  - 커넥터 설정은 `io.debezium.connector.postgresql.PostgresConnector`(`:258`), 호스트 `postgres-main-rw.database.svc.cluster.local`(`:259`), 데이터베이스 `shop`(`:263`), 토픽 접두사 `cdc.shop`(`:264`), 복제 슬롯 `beluga_shop_slot`(`:266`), 테이블 목록 `public.orders,public.customers`(`:267`)를 지정합니다.
  - 데이터베이스 암호는 Secret `postgres-admin-credential`(`:241-245`)에서 읽어 `sed`로 요청 JSON 본문에 주입합니다(`:274`).
- **Iceberg로의 스트리밍 수집 (Flink SQL)**:
  - Flink SQL 파이프라인이 CDC Kafka 토픽을 읽어 Iceberg 테이블로 직접 적재합니다(`gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`, `events_sessionization.sql:1-62`).
  - `cdc_customers.sql`에서 Flink는 `http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog`(`:10-21`)의 Lakekeeper REST 카탈로그에 연결하고, `format-version = '2'` 및 `write.upsert.enabled = 'true'`(`:50-51`) 설정으로 `lakekeeper.lake.customers`(`:42-52`)에 씁니다.
  - 수집 토픽은 `cdc.shop.public.customers`이며 포맷은 `debezium-json`(`:34-40`)입니다. 체크포인트 간격은 30초로 강제되어 있습니다(`:2`).
  - [`medallion-architecture-ko.md`](medallion-architecture-ko.md) 4절(`:98-138`)에서 확인된 바와 같이, 이 테이블들은 불변의 브론즈 원본 복사본 없이 타입 변환과 중복 제거를 거쳐 `lake` 네임스페이스로 바로 업서트됩니다.
- **Airflow 오케스트레이션**:
  - Airflow 3.3.0(`VERSIONS.md:36`)이 `KubernetesExecutor`로 구동됩니다(`gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`).
  - 네임스페이스 `orchestration`의 Airflow ServiceAccount `airflow`는 `orchestration`(`07-airflow.yaml:8-34`) 및 `analytics`(`:39-60`) 네임스페이스에서 파드에 대한 `create`, `get`, `list`, `watch`, `delete`, `patch` 권한을 갖는 Role/RoleBinding `airflow-pod-operator`를 보유합니다(`:14-16, 45-47`).
  - 현재 존재하는 유일한 DAG는 `iceberg_table_maintenance`(`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`)이며, `KubernetesPodOperator`를 통해 Trino 상에서 컴팩션과 스냅샷 만료를 실행합니다(`:24-50`). 현재 데이터 수집이나 정합성 조정 전용 DAG는 없습니다.
- **데이터 표준 및 거버넌스**:
  - [`policies/data-standards.yaml`](../policies/data-standards.yaml)은 필수 테이블 메타데이터(`owner`, `classification`, `description`, `retention`, `freshness`) 및 열 메타데이터(`description`, `classification`)를 정의합니다(`:25-28`). 허용 분류값은 `internal`과 `pii`로 제한됩니다(`:28`).
  - 스키마 발견은 정적입니다. `policies/data-standards.yaml`에 DDL 원천 파일이 나열되어 있으며(`:8-16`), `make validate` 시 `scripts/ci/check-data-standards.py`로 검증됩니다.
  - 공식 API 계약(OpenAPI 규격) 및 수집 정합성 매니페스트는 부재합니다(`docs/critical-interfaces-inventory.md:78`에서 공식 계약 아티팩트 미수립 확인).
- **메타데이터 및 거버넌스 엔진**:
  - Lakekeeper v0.13.1(`VERSIONS.md:33`)이 SeaweedFS S3를 스토리지로 하는 `lake` 웨어하우스의 Iceberg REST 카탈로그를 관리합니다(`gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:1-120`).
  - OpenMetadata 1.13.3(`VERSIONS.md:43`) 및 OpenSearch 2.18.0(`VERSIONS.md:44`)이 `gitops/charts/beluga-data/templates/11-openmetadata.yaml:1-348`에 정의되어 있습니다.

### 2.2 라이브 클러스터 상태 (2026-10-08 실측)

지정된 kubeconfig를 통해 다음 사실을 읽기 전용으로 확인했습니다:
- **활성 워크로드**:
  - `streaming` 네임스페이스: 파드 `debezium-connect-848597646b-6kcnv` 정상 실행 중(`Running`, 1/1); Job `debezium-register-shop-6jkws` 완료(`Completed`, 0/1); Flink 파드 `flink-cluster-787f4dd587-gjl4r`, `flink-cluster-taskmanager-2-1`, `flink-cluster-taskmanager-2-2` 실행 중(`Running`, 1/1); Kafka 브로커 파드 `beluga-kafka-mixed-0`, `1`, `2` 실행 중.
  - `database` 네임스페이스: 파드 `postgres-main-1` 실행 중(`Running`, 1/1); Job `shop-seed-smvcc` 완료(`Completed`).
  - `orchestration` 네임스페이스: 파드 `airflow-webserver-798bf8db59-2nzgt` 실행 중(`Running`, 1/1).
  - `lakehouse` 네임스페이스: 파드 `lakekeeper-66bbf6776c-dtpcx` 실행 중(`Running`, 1/1).
  - `governance` 네임스페이스: 파드 `openmetadata-5547c79cb5-6vm9j` 및 `opensearch-65c94b9f97-hszx2` 실행 중(`Running`, 1/1).
  - `storage` 네임스페이스: 파드 `seaweedfs-0` 실행 중(`Running`, 1/1).
- **네트워크 경계**: `04b-lakehouse-network-policy.yaml`에 의해 Lakekeeper 8181 포트 수신은 Trino, Flink, APISIX로 제한되며, Airflow는 Lakekeeper REST에 직접 접근할 수 없습니다.

---

## 3. 인수 조건 대비 격차 분석

| 식별자 | 내용 | 근본 원인 및 현재 상태 |
|---|---|---|
| G-INT-1 | 이기종 소스를 위한 통합 온보딩 템플릿 및 라이프사이클 부재 (#71) | 수집 경로가 Flink SQL 스크립트와 Debezium 등록 Job에 하드코딩되어 있습니다. 신규 소스 등록을 위한 선언적 YAML 모델이 없습니다. |
| G-INT-2 | 브론즈를 우회하여 실버 형태의 테이블로 직접 적재 (#71) | `cdc_customers.sql`과 `cdc_orders.sql`이 `lake.customers` 및 `lake.orders`로 직접 업서트합니다. 원본 CDC 엔벨로프와 수집 메타데이터가 Iceberg에 보존되지 않습니다. |
| G-INT-3 | 데이터베이스 스키마 자동 발견 및 프로파일링 부재 (#75) | 스키마가 SQL DDL에 수동 작성되어 `policies/data-standards.yaml`에 복제되어 있습니다. 라이브 DB에서 제약조건, 근사 통계, PII 감지를 수행하는 자동 리플렉션이 없습니다. |
| G-INT-4 | 최소 권한 프로파일링 역할 부재 (#75) | 현재 Debezium 등록 및 시딩 작업이 슈퍼유저 성격의 `beluga_admin`으로 연결됩니다(`03-strimzi-kafka.yaml:261`). 리소스 제한이 적용된 읽기 전용 프로파일링 전용 역할이 없습니다. |
| G-INT-5 | 외부 API 커넥터 프레임워크 부재 (#77) | 플랫폼이 PostgreSQL CDC와 내부 Kafka 클릭스트림 이벤트만 처리합니다. HTTP/REST 페이지네이션, 레이트 리밋(HTTP 429), 지수 백오프를 처리하는 런타임이 없습니다. |
| G-INT-6 | OpenAPI 계약 거버넌스 및 드리프트 감지 부재 (#78) | OpenAPI 3.x 규격이 등록·버전 관리되지 않으며 인입 페이로드와 대조되지 않습니다. 스키마 변경 시 하류 변환 작업이 조용히 중단될 위험이 있습니다. |
| G-INT-7 | 수집 제어 평면 및 소스-플랫폼 정합성 조정 부재 (#82) | 계획 레코드 대비 실제 수신 레코드를 추적하거나 소스 건수를 Iceberg 스냅샷 메타데이터(`total-records`)와 비교하는 메커니즘이 없습니다. 누락이나 중복 적재를 사전에 감지하지 못합니다. |

---

## 4. 제안 내용 (Proposed)

### 4.1 통합 소스 온보딩 프레임워크 (이슈 #71)

#### 4.1.1 지원 소스 클래스
Beluga는 5가지 표준 소스 클래스를 정의합니다:
1. **관계형 / CDC (Relational / CDC)**: Debezium Connect를 통해 Kafka 토픽으로 지속 캡처되는 RDBMS 소스(PostgreSQL, MySQL, Oracle, MSSQL) 또는 배치 JDBC 쿼리 추출 소스.
2. **외부 API (External API)**: OpenAPI 3.x로 기술된 HTTP/REST 엔드포인트, SaaS 내보내기 및 웹훅.
3. **파일 / 배치 오브젝트 스토리지 (Files / Batch)**: SeaweedFS S3 또는 외부 스토리지로 전달되는 구분자 텍스트(CSV, TSV), JSON Lines, Parquet 파일.
4. **스트리밍 메시지 버스 (Streaming)**: 외부 Kafka 토픽, MQTT 및 이벤트 스트림.
5. **비정형 및 미디어 (Unstructured & Media)**: SeaweedFS S3에 직접 저장되고 Iceberg 매니페스트 테이블로 관리되는 문서(PDF, Word), 로그 아카이브, 오디오/비디오 파일.

#### 4.1.2 선언적 소스 등록 스키마
모든 소스는 배포 전 Git의 `sources/<domain>/<source_name>.yaml` 경로에 선언적으로 등록되어야 합니다. 필수 메타데이터가 누락된 경우 CI 사전 검사에서 차단됩니다:

```yaml
# 제안: sources/shop/shop_postgres_customers.yaml
apiVersion: beluga.data/v1alpha1
kind: SourceRegistration
metadata:
  name: shop-postgres-customers
  domain: shop
spec:
  owner: data-platform
  classification: pii             # 'internal' 또는 'pii' 필수 (policies/data-standards.yaml 준수)
  sourceClass: relational-cdc     # relational-cdc | external-api | file-batch | stream | unstructured
  freshnessSLA: PT15M             # ISO-8601 기간
  retention: P365D                # ISO-8601 기간
  ingestionMode: continuous-cdc   # continuous-cdc | scheduled-batch | event-stream | webhook
  connection:
    secretRef:
      name: shop-cdc-source-credential
      namespace: streaming
  targetBronze:
    namespace: bronze_shop
    tableName: cdc_customers
    partitionBy: "day(_ingest_ts)"
  schemaContractRef: contracts/shop/customers-contract.yaml
```

#### 4.1.3 표준 브론즈 수집 계약
[`medallion-architecture-ko.md`](medallion-architecture-ko.md) 3절(`:90-93`) 및 7절(`:225-238`)에 따라, 모든 브론즈 Iceberg 테이블은 원본 페이로드를 보존하며 공통 수집 메타데이터 열을 추가해야 합니다:

| 열 이름 | Iceberg 타입 | 설명 |
|---|---|---|
| `_raw` | `STRING` | 수정되지 않은 원본 레코드 페이로드(JSON 문자열 또는 인코딩 문자열). Iceberg format-version 2의 호환성을 위해 `STRING`으로 저장(`medallion-architecture.md:92`). |
| `_ingest_ts` | `TIMESTAMP(6)` | 브론즈에 레코드가 기록된 UTC 타임스탬프. |
| `_source_system` | `STRING` | 등록된 소스 식별자(예: `shop-postgres`). |
| `_source_ref` | `STRING` | 소스 시스템 내 좌표(Kafka `topic/partition/offset`, 파일 S3 URI + SHA-256 체크섬, 또는 API 요청 ID + 커서). |
| `_batch_id` | `STRING` | 수집 제어 평면이 발급한 수집 실행 UUID. |
| `_schema_version` | `STRING` | 수집 시점의 유효 계약/스키마 버전 문자열. |

#### 4.1.4 이상 레코드 격리(Quarantine) 처리
- 브론즈 적재 중 파싱할 수 없거나 와이어 포맷 규칙을 위반한 레코드는 동일 브론즈 네임스페이스의 격리 테이블 `<bronze_table>_quarantine`으로 라우팅됩니다.
- 격리 테이블은 `_raw`, `_ingest_ts`, `_source_ref`, `_batch_id` 외에 `_error_code`, `_error_message`를 함께 보관합니다.
- 격리 레코드는 원본 데이터셋의 최고 민감도 분류(기본 `pii`)를 계승하며 분석가의 접근이 엄격히 차단됩니다(`medallion-architecture.md:84-85, 179-181`).

#### 4.1.5 결정론적 재생 및 백필
- 재생은 원천 시스템을 다시 찌르지 않고 브론즈 스냅샷에서 수행합니다(`medallion-architecture.md:218-219`).
- 하류 실버 테이블로의 백필은 비즈니스 키(`customer_id`, `order_id`)를 기준으로 결정론적 `MERGE INTO` 연산을 수행하여 중복 레코드 없이 멱등성을 보장합니다.

---

### 4.2 데이터베이스 스키마 발견, 프로파일링 및 리버스 엔지니어링 (이슈 #75)

#### 4.2.1 확장 가능한 DB 발견 엔진
Beluga는 네임스페이스 `orchestration`에서 Airflow `KubernetesPodOperator` 작업으로 구동되는 컨테이너 기반 스키마 발견 엔진을 도입합니다:
- **핵심 기술**: Python 3.12 기반 SQLAlchemy 2.0 (MIT 라이선스) 및 공식 방언 드라이버.
- **지원 어댑터**:
  - PostgreSQL: `psycopg2-binary` (예외 조항 포함 LGPL / BSD 호환) 또는 `asyncpg` (Apache-2.0).
  - MySQL / MariaDB: `PyMySQL` (MIT 라이선스).
  - Microsoft SQL Server: `pymssql` (LGPL) 또는 FreeTDS ODBC.
  - Oracle: `python-oracledb` (Apache-2.0 / Universal Permissive License).
- **라이선스/SBOM 준수**: 모든 런타임 라이브러리는 `policies/license-policy.yaml`의 허용 라이선스(Apache-2.0, MIT, BSD)를 준수해야 합니다. 카피레프트 전용(GPL) 드라이버는 프로덕션 컨테이너 빌드에서 제외됩니다.

#### 4.2.2 검사 범위 및 표준 스키마 모델
발견 엔진은 소스 카탈로그를 조회하여 다음 정보를 표준 스키마 형태로 추출합니다:
- 테이블, 뷰, 머티리얼라이즈드 뷰.
- 열 정보: 이름, 서수(ordinal), 원천 데이터 타입, 매핑된 Iceberg 표준 데이터 타입, null 허용 여부, 기본값, 문자 길이, 숫자 정밀도 및 스케일.
- 제약조건: 기본키(PK), 외래키(FK, 참조 테이블 및 열 포함), 유니크 제약, 체크 제약.
- 인덱스: 인덱스명, 대상 열 목록, 고유 인덱스 플래그.

**표준 타입 매핑 표 (제안)**:

| 원천 DB 타입 (PostgreSQL / MySQL / Oracle / MSSQL) | Beluga 표준 / Iceberg 타입 |
|---|---|
| `INT`, `INTEGER`, `SERIAL`, `NUMBER(9,0)` | `INTEGER` |
| `BIGINT`, `BIGSERIAL`, `NUMBER(18,0)` | `BIGINT` |
| `NUMERIC(p,s)`, `DECIMAL(p,s)`, `NUMBER(p,s)` | `DECIMAL(precision, scale)` |
| `VARCHAR`, `TEXT`, `CHAR`, `NVARCHAR`, `CLOB` | `STRING` |
| `BOOLEAN`, `TINYINT(1)`, `BIT` | `BOOLEAN` |
| `FLOAT`, `REAL`, `FLOAT4`, `BINARY_FLOAT` | `FLOAT` |
| `DOUBLE PRECISION`, `FLOAT8`, `BINARY_DOUBLE` | `DOUBLE` |
| `DATE` | `DATE` |
| `TIMESTAMP`, `DATETIME2`, `TIMESTAMP WITHOUT TIME ZONE` | `TIMESTAMP(6)` |
| `TIMESTAMPTZ`, `TIMESTAMP WITH TIME ZONE` | `TIMESTAMPTZ` |
| `JSON`, `JSONB` | `STRING` (Iceberg v2 표현) |
| `BYTEA`, `BLOB`, `VARBINARY` | `BINARY` |

#### 4.2.3 안전하고 제한된 프로파일링 및 리소스 제약
운영 DB에 부하를 주지 않도록 다음과 같은 제약을 강제합니다:
- **엄격한 쿼리 제한**: 100,000행을 초과하는 미파티션 테이블에 대한 전체 테이블 스캔을 금지합니다.
- **샘플링**: 통계 수집 시 `TABLESAMPLE SYSTEM (5)` (PostgreSQL) 또는 제한된 샘플링(`SELECT ... FROM (SELECT ... FROM table LIMIT 10000) sample`)을 사용합니다.
- **수집 통계**:
  - 테이블 수준: 근사 레코드 수(`pg_class.reltuples` / `information_schema`), 물리 크기.
  - 열 수준: null 비율(%), 근사 카디널리티(HyperLogLog / 샘플 `COUNT(DISTINCT)`), 최소/최대값(숫자/일시 비PII 필드 대상), 평균 문자 길이.
- **리소스 한도**: 프로파일링 파드는 Kubernetes 리소스 한도(`limits.cpu: "1000m"`, `limits.memory: "1Gi"`)와 30초 쿼리 타임아웃(`statement_timeout = '30000'`)을 엄격히 적용받습니다.

#### 4.2.4 PII 후보 감지 및 샘플 마스킹
- 발견 엔진은 열 이름, 코멘트 및 샘플 데이터를 정규식 휴리스틱(이메일, 전화번호, 주민등록번호, 신용카드 번호 등)과 대조합니다.
- 일치하는 열은 후보 메타데이터에 `classification: pii`로 자동 플래그 지정됩니다.
- **샘플 보호**: 수집된 샘플 데이터는 리포트에 기록되기 전 인메모리에서 즉시 마스킹 처리(예: `user@domain.com` → `u***@domain.com`)됩니다. 원본 PII는 발견 산출물에 절대 저장되지 않습니다.

#### 4.2.5 최소 권한 발견 계정
프로파일링은 데이터베이스 최고 관리자 계정으로 실행되지 않습니다. DB별 전용 최소 권한 역할을 생성합니다:
- PostgreSQL 예시:
  ```sql
  CREATE ROLE beluga_profiler WITH LOGIN PASSWORD '...';
  GRANT CONNECT ON DATABASE shop TO beluga_profiler;
  GRANT USAGE ON SCHEMA public TO beluga_profiler;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO beluga_profiler;
  ALTER ROLE beluga_profiler SET statement_timeout = '30s';
  ```

#### 4.2.6 발견 실행 간 드리프트 감지
각 실행 결과는 표준 JSON 아티팩트 `discovery/<source_id>/<timestamp>.json`에 저장됩니다. CI 또는 Airflow diff 작업이 연속된 스냅샷을 비교합니다:
- 비파괴적 변경 (새로운 null 허용 열 추가): 자동 계약 업데이트 후보로 등록.
- 파괴적 변경 (열 삭제, 데이터 타입 축소, 키 변경): 경보를 발령하고 파이프라인 자동 승격을 차단.

---

### 4.3 외부 API 커넥터 프레임워크 (이슈 #77)

#### 4.3.1 커넥터 구조 및 런타임
외부 API 커넥터는 네트워크와 의존성을 격리하기 위해 Airflow `KubernetesPodOperator`를 통해 컨테이너 작업으로 실행됩니다:
- **인증 핸들러**:
  - OAuth2 Client Credentials 및 Refresh Token 기반 Authorization Code.
  - OIDC / 서비스 계정 JWT.
  - API 키 (HTTP 헤더 또는 쿼리 파라미터 주입).
  - Kubernetes Secret에서 마운트한 클라이언트 인증서를 사용하는 상호 TLS(mTLS).
- **자격증명 관리**: 인증 정보는 Kubernetes Secret(`secretKeyRef`)에 보관되며 코드나 DAG 파일에 하드코딩되지 않습니다.

#### 4.3.2 데이터 추출 및 복원력 패턴
- **페이지네이션**: 커서 기반(`next_cursor`), 오프셋/리밋(`offset`, `limit`), 페이지 번호(`page`, `size`), Link 헤더(`RFC 5988`) 방식을 지원합니다.
- **레이트 리밋 및 스로틀링**: 제공자의 쿼터에 맞춘 토큰 버킷 알고리즘을 클라이언트 측에 구현합니다.
- **HTTP 429 대응**: 응답의 `Retry-After` 헤더를 준수하며, 지수 백오프와 지터를 적용하여 최대 5회 재시도합니다.
- **증분 추출**: SeaweedFS S3에 마지막 성공 워터마크(`last_extracted_updated_at` 또는 시퀀스 ID)를 상태 파일로 커밋하여 증분 수집을 보장합니다.
- **서킷 브레이커**: 연속 3회 5xx 응답 또는 인증 실패 시 작업을 즉시 중단하고 인시던트 레코드를 남깁니다.

#### 4.3.3 웹훅 수집 경로
이벤트 구동형 API의 경우:
- 외부 웹훅은 APISIX 인그레스 게이트웨이(`apisix.platform-system.svc.cluster.local`)에서 수신합니다.
- APISIX가 HMAC 서명을 검증한 후 원본 페이로드를 전용 Kafka 토픽 `webhooks.<source_domain>.<event_type>`으로 전달합니다.
- Flink SQL 또는 Airflow가 해당 토픽을 소비하여 브론즈 테이블에 적재합니다.

---

### 4.4 OpenAPI 기반 계약 및 스키마 거버넌스 (이슈 #78)

#### 4.4.1 OpenAPI 규격 등록
외부 API는 공식 규격(OpenAPI 3.0.x 또는 3.1.x)을 `contracts/apis/<source_id>/openapi.yaml`에 등록해야 합니다:
- 단일 원천: [OpenAPI Specification v3.1.0](https://spec.openapis.org/oas/v3.1.0.html) (2026-10-08 열람; Apache License 2.0).
- Beluga가 활용하는 핵심 OpenAPI 객체:
  - `paths`: 엔드포인트 URI, 경로 파라미터, 쿼리 파라미터 정의 (`oas:4.8.8`).
  - `operationId`: 수집 파이프라인 작업에 매핑되는 고유 식별자 (`oas:4.8.10`).
  - `responses`: `200 OK` 응답 페이로드 스키마 정의 (`oas:4.8.16`).
  - `components.schemas`: 엔티티 모델에 매핑되는 재사용 가능한 데이터 스키마 (`oas:4.8.7, 4.8.24`).
  - `securitySchemes`: OAuth2 플로우, API 키, HTTP 베어러 토큰 정의 (`oas:4.8.27`).

#### 4.4.2 자동 계약 드리프트 및 호환성 검사
브론즈에 적재된 페이로드 샘플과 등록된 OpenAPI 스키마를 비교하는 계약 검증기(`scripts/ci/check-api-contract-drift.py`)를 운영합니다:
- **비파괴적 변경**:
  - 응답 스키마에 새로운 선택적(필수 아님) 필드 추가.
  - 신규 엔드포인트 또는 오퍼레이션 추가.
- **파괴적 변경**:
  - 기존 응답 속성 삭제.
  - 속성 데이터 타입 변경(예: `integer` → `string` 또는 스칼라 → 배열).
  - 기존 속성 이름 변경.
- 런타임에 파괴적 드리프트가 감지된 경우:
  - 해당 배치는 `<table_name>_quarantine`으로 격리됩니다.
  - 수집 제어 평면은 상태를 `CONTRACT_DRIFT_QUARANTINED`로 기록하고 실버 승격을 차단합니다.

#### 4.4.3 비 OpenAPI 규격 대체 경로
OpenAPI 규격이 없는 레거시 인터페이스의 경우:
- [`data-contract-standard-ko.md`](data-contract-standard-ko.md)에 정의된 Open Data Contract Standard (ODCS v3.2.0) 또는 JSON Schema (draft 2020-12) 파일을 등록합니다.
- 계약 검증기는 동일한 호환성 규칙을 해당 스키마에 적용합니다.

---

### 4.5 거버넌스 기반 데이터 수집 제어 평면 및 소스-플랫폼 정합성 조정 (이슈 #82)

#### 4.5.1 수집 흐름 라이프사이클
제어 평면은 모든 소스 클래스의 데이터 전송 실행 단계를 추적합니다:
```
[계획됨 (PLANNED)] ---> [추출/수집 중 (INGESTING)] ---> [브론즈 적재 (LANDED_BRONZE)]
                                                                   |
                                                         [정합성 검증 (RECONCILING)]
                                                          /                       \
                                           (일치 OK)     /                         \  (불일치 / 드리프트)
                                                       v                           v
                                              [커밋됨 (COMMITTED)]        [격리/실패 (QUARANTINED/FAILED)]
                                                       |                           |
                                               (실버 파이프라인 트리거)       (운영자 경보 및 감사 증적 보존)
```

**수집 실행 메타데이터 기록 항목**:
- `run_id`: 수집 배치 UUIDv4.
- `source_id`: 등록된 소스 식별자.
- `target_dataset`: 대상 Iceberg 테이블(예: `bronze_shop.cdc_customers`).
- `execution_window`: 실행 윈도우 `[window_start_ts, window_end_ts]`.
- `source_metrics`: 소스 예상 레코드 수, 예상 바이트 크기, 소스 체크섬/해시.
- `platform_metrics`: 실제 적재 레코드 수, Iceberg 스냅샷 ID, 데이터 파일 수.
- `reconciliation_status`: `COMMITTED`, `QUARANTINED`, `MISMATCH_FLAGGED`.

#### 4.5.2 소스-플랫폼 정합성 조정 메커니즘
원천에서 전송된 데이터와 레이크하우스에 커밋된 데이터의 일치 여부를 검증합니다:

1. **배치 및 API 수집 정합성 검증**:
   - **소스 건수**: 실행 윈도우 동안 API 또는 DB에서 추출된 총 레코드 수.
   - **플랫폼 건수**: Lakekeeper / Trino를 통해 Iceberg 스냅샷 요약 메타데이터 조회:
     ```sql
     -- Iceberg 테이블 스냅샷 메타데이터 조회
     SELECT snapshot_id,
            summary['total-records'] AS total_records,
            summary['added-records'] AS added_records,
            summary['total-data-files'] AS total_files
     FROM iceberg.bronze_shop."cdc_customers$snapshots"
     ORDER BY committed_at DESC
     LIMIT 1;
     ```
   - **오차 계산**:
     $$\text{오차} = |\text{소스 레코드 수} - \text{Iceberg 추가 레코드 수}|$$
   - 배치 및 API 추출의 허용 오차는 엄격히 **0%**입니다. 단 1건이라도 차이가 발생하면 파이프라인이 중단됩니다.
2. **스트리밍 및 CDC 수집 정합성 검증**:
   - 지속적인 CDC(Debezium → Kafka → Flink → Iceberg)는 버퍼링과 Flink 체크포인트 간격(30초, `cdc_customers.sql:2`)으로 인해 즉각적인 건수 일치가 어렵습니다.
   - 정합성 검증은 스케줄된 윈도우(예: 매시간) 단위로 수행됩니다:
     - 소스: 원천 DB의 시퀀스 번호/LSN 또는 `updated_at <= :window_end` 레코드 건수 조회.
     - 플랫폼: Iceberg에서 `_ingest_ts <= :window_end + PT5M` 범위의 고유 기본키 건수 집계.
     - 허용 오차: 버퍼가 소진된 후에는 0건 누락을 목표로 합니다(결정 사항 OD-INT-4 참조).
3. **체크섬 및 볼륨 검증**:
   - 파일 수집(CSV/Parquet)의 경우 원천 SHA-256 해시 및 파일 크기를 SeaweedFS S3 오브젝트 ETag/체크섬 및 `_source_ref`에 기록된 값과 대조합니다.

#### 4.5.3 부분 전송 및 중복 전송 처리
- **부분 전송(Partial Transfer)**: API 추출 도중 네트워크 단절 등으로 중단된 경우 해당 수집 실행은 즉시 폐기됩니다. Flink 체크포인트 커밋 또는 Airflow 작업 배치 단위로 원자적 쓰기가 이뤄지므로 불완전한 배치는 실버로 전파되지 않습니다.
- **중복 전송(Duplicate Transfer)**: Kafka의 At-least-once 전달이나 API 재시도로 발생한 중복 레코드는 브론즈에서 실버로 변환될 때 기본키와 이벤트 타임스탬프를 기준으로 중복 제거됩니다(`medallion-architecture.md:65, 220-221`).

---

## 5. 검증 및 테스트 아이디어

### 5.1 테스트 1: 소스 온보딩 사전 검사 게이트 (정적 CI)
- **목표**: 필수 필드가 누락된 잘못된 소스 등록 파일이 병합되지 않도록 차단하는지 검증.
- **방법**: `owner`와 `classification`이 누락된 테스트 YAML에 대해 CI 검증 스크립트 실행.
- **기대 결과**: `policies/data-standards.yaml` 필수 메타데이터 누락 오류를 출력하며 0이 아닌 종료 코드로 실패.

### 5.2 테스트 2: 라이브 PostgreSQL 스키마 자동 인트로스펙션
- **목표**: 최소 권한 계정이 `shop-schema.sql`에 정의된 키, 제약조건, 타입을 정확히 읽어내는지 검증.
- **방법**: 읽기 전용 역할로 `postgres-main-rw.database.svc.cluster.local:5432/shop`을 대상으로 프로파일링 스크립트 실행.
- **기대 결과**: `customers` 테이블의 기본키 `customer_id`, 열 `name`, `email`, `city`, `created_at`을 추출하고 `email`과 `name`을 PII 후보로 분류한 JSON 스키마 산출.

### 5.3 테스트 3: 격리된 목(Mock) OpenAPI 커넥터 및 드리프트 테스트
- **목표**: 외부 네트워크 의존 없이 API 페이지네이션, 재시도, 계약 드리프트 감지 동작 확인.
- **방법**: 로컬 Python HTTP 서버로 OpenAPI 3.1.0 응답을 제공하는 목 서버 구동 후 수집 실행. 2단계에서는 필수 필드를 임의로 삭제하여 파괴적 변경 주입.
- **기대 결과**: 1단계에서는 100% 레코드 일치 완료. 2단계에서는 파괴적 드리프트를 감지하여 배치를 격리 테이블로 보내고 `CONTRACT_DRIFT_QUARANTINED` 기록.

### 5.4 테스트 4: 의도적 수집 불일치 정합성 조정 테스트
- **목표**: 소스 건수와 플랫폼 건수 불일치 시 제어 평면이 이를 감지하는지 검증.
- **방법**: 브론즈 테이블에 100건을 적재하되 매니페스트에는 105건이 전송된 것으로 조작.
- **기대 결과**: 5건의 오차를 감지하고 상태를 `MISMATCH_FLAGGED`로 전환, 감사 증적을 남기며 하류 실버 DAG 실행 차단.

---

## 6. 소유자 미결 결정 사항

| 결정 ID | 항목 | 검토된 대안 | 권고안 | 권고 근거 |
|---|---|---|---|---|
| **OD-INT-1** | 소스 등록 정보 저장소 | (A) GitOps YAML 디렉토리 (`sources/**/*.yaml`)<br>(B) DB 테이블 / OpenMetadata REST API 전용 | **대안 A: GitOps YAML 기준선** | PR 리뷰, 이력 추적 및 CI 검증을 거친 후 런타임에 OpenMetadata로 동기화하는 것이 안전함. |
| **OD-INT-2** | 프로파일링 실행 엔진 | (A) Python/SQLAlchemy 기반 Airflow `KubernetesPodOperator`<br>(B) OpenMetadata 내장 Ingestion 프레임워크 | **대안 A: Airflow Pod Operator** | 오케스트레이션을 Airflow로 단일화하고 OpenMetadata가 비활성화된 저용량 프로파일에서도 작동 가능함. |
| **OD-INT-3** | 외부 API 수집 런타임 | (A) 폴링 API용 Airflow 스케줄 배치 파드<br>(B) 전용 상시 마이크로서비스 데몬 | **대안 A: Airflow 스케줄 파드** | 유휴 메모리 점유를 최소화하고 온디맨드로 파드를 띄워 실행 후 종료할 수 있음. |
| **OD-INT-4** | CDC 정합성 오차 허용치 | (A) 버퍼 소진 후 엄격한 0% 차이<br>(B) 휴리스틱 허용치 (예: ±0.1%) | **대안 A: 버퍼 소진 후 0% 엄격 적용** | 핵심 트랜잭션 테이블(`customers`, `orders`)의 조용한 데이터 유실을 방지함. |
| **OD-INT-5** | 브론즈 원본 페이로드 저장 포맷 | (A) 문자열 (UTF-8 JSON 문자열)<br>(B) 바이너리 (압축 바이트 배열) | **대안 A: 문자열 (STRING)** | 독점 variant 타입 없이 Iceberg format-version 2와 완벽 호환됨(`medallion-architecture.md:92`). |

---

## 7. 후속 구현 과제 (단계별)

1. **과제 1: 소스 등록 스키마 및 CI 사전 검사기 개발**
   - `sources/**/*.yaml`의 필수 필드(`owner`, `classification`, `freshnessSLA`, `retention`)를 검증하는 스크립트 `scripts/ci/check-source-definitions.py` 작성.
   - *인수 테스트 아이디어*: 유효한 소스 fixture는 통과하고, `classification`이 누락된 fixture는 실패함을 확인.
2. **과제 2: 최소 권한 PostgreSQL 스키마 발견 스크립트 작성**
   - `shop` 데이터베이스에 연결하여 표준 JSON 스키마를 추출하고 PII 후보를 식별하는 컨테이너용 스크립트 구현.
   - *인수 테스트 아이디어*: `postgres-main` 대상 실행 시 `shop-schema.sql:1-48`의 테이블 정의와 일치하는 JSON 출력 확인.
3. **과제 3: OpenAPI 계약 드리프트 검증기 구현**
   - 샘플 JSON 페이로드와 OpenAPI 3.1.0 스키마를 비교하여 파괴적 변경 여부를 판정하는 도구 개발.
   - *인수 테스트 아이디어*: 속성 삭제 시 종료 코드 1과 변경 내역을 출력하는 단위 테스트 수행.
4. **과제 4: 참조 Airflow API 수집 및 정합성 조정 DAG 구축**
   - 목 API에서 데이터를 가져와 브론즈 Iceberg 테이블에 적재하고 `$snapshots` 메타데이터를 조회하여 건수 일치를 검증하는 Airflow DAG 구현.
   - *인수 테스트 아이디어*: 정상 건수에서는 성공 커밋하고, 인위적 건수 조작 시 실패 경보를 발생시킴을 확인.

---

## 8. 참고 문헌

### 8.1 외부 규격 및 표준
- [S1] OpenAPI Initiative, *OpenAPI Specification v3.1.0*, https://spec.openapis.org/oas/v3.1.0.html (2026-10-08 열람). Apache License 2.0. 열람 절: 4.8.7 Components, 4.8.8 Paths, 4.8.10 Operation, 4.8.16 Responses, 4.8.24 Schema Object, 4.8.27 Security Scheme.
- [S2] Databricks, *What is the medallion lakehouse architecture?*, https://docs.databricks.com/aws/en/lakehouse/medallion (2026-10-07 열람).
- [S3] Apache Iceberg, *Iceberg Table Spec v2*, https://iceberg.apache.org/spec/ (2026-10-07 열람).
- [S4] Open Data Contract Standard, https://github.com/bitol-io/open-data-contract-standard (2026-10-07 열람). Apache License 2.0.

### 8.2 저장소 원천 (커밋 `d424c38` 기준 실측)
- Debezium 배포 및 등록: `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:120-275`.
- Flink SQL 스트리밍 수집: `gitops/charts/beluga-data/files/flink-sql/cdc_customers.sql:1-59`, `cdc_orders.sql:1-60`.
- Airflow 오퍼레이터 및 RBAC: `gitops/charts/beluga-data/templates/07-airflow.yaml:1-60`.
- 유지보수 DAG: `gitops/charts/beluga-data/files/dags/iceberg_maintenance.py:1-53`.
- Lakekeeper 부트스트랩: `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:1-120`.
- OpenMetadata 및 OpenSearch: `gitops/charts/beluga-data/templates/11-openmetadata.yaml:1-348`.
- 거버넌스 기준선: `policies/data-standards.yaml:1-117`.
- 컴포넌트 버전: `VERSIONS.md:1-60`.
- Lakekeeper 네트워크 정책: `gitops/charts/beluga-data/templates/04b-lakehouse-network-policy.yaml:1-50`.

### 8.3 라이브 클러스터 검증 (2026-10-08 실측)
- 네임스페이스 `streaming`, `database`, `orchestration`, `lakehouse`, `governance`, `storage`, `analytics`의 파드 실행 상태를 kubeconfig `/private/tmp/claude-501/-Users-m-Documents-IdeaProjects-20-dasomel-mdp/428036c9-2f2b-4b75-b009-3cf5a1d348da/scratchpad/kubeconfig`를 통해 `kubectl get pods -A` 명령으로 확인.
- *라이브 미검증 항목*: Debezium 내부 복제 슬롯 지연 세부 수치, Oracle/MSSQL 실제 DB 연결(로컬 VM 미프로비저닝), 실제 외부 OpenAPI 엔드포인트 네트워크 도달성.
