# 거버넌스 dbt 계보 및 Silver 발행 게이트 (제안서)

[English](dbt-lineage-and-publish-gate.md) | 한국어

참조 이슈: #95 ("dbt Core를 거버넌스 SQL 변환 계층으로 채택").

> **상태: 제안(PROPOSAL). 문서 전용.** 본 문서로 변경되는 매니페스트, DAG, 스크립트, 정책, 레지스트리 또는 `VERSIONS.md` 값은 없습니다. 저장소 관련 진술은 `origin/main` 기준 검증된 `file:line`을 인용합니다. 실측되지 않은 런타임 동작은 **라이브 미검증** 또는 **고정 버전에 대한 업스트림 문서 검증 대상**으로 명시했습니다. 외부 도구 라이선스는 공식 프로젝트 약관 또는 `VERSIONS.md`를 인용합니다. **제안(Proposed)**으로 표시된 항목은 설계 제안이며 구현되지 않았습니다.

관련 문서:
- [`adr/0007-dbt-core-transformation-layer-ko.md`](adr/0007-dbt-core-transformation-layer-ko.md) (dbt Core 채택 결정 D-DBT-1 ~ D-DBT-15)
- [`transformation-and-semantic-layer-ko.md`](transformation-and-semantic-layer-ko.md) (배치 Silver/Gold 변환 프레임워크, OD-TR-1, OD-TR-6)
- [`lineage-and-metadata-quality-ko.md`](lineage-and-metadata-quality-ko.md) (계보 제어, OpenMetadata 현황, G1–G5)
- [`policies/resources.yaml`](../policies/resources.yaml) (역할 `transformers`에 대한 OPA 리소스 및 schemaGrants)
- [`dbt/README.md`](../dbt/README.md) (dbt 프로젝트 구조, 로컬 검증, 발행 게이트)

---

## 1. 목적 및 이슈 매핑

이슈 #95는 Iceberg 기반 Trino 실행 환경에 dbt Core를 도입했습니다 (`adr/0007-dbt-core-transformation-layer-ko.md:20-28`). 그러나 다음 두 가지 아키텍처 공백이 여전히 남아 있습니다:
1. **거버넌스 카탈로그 내 계보 및 문서 가시화**: 데이터 소비자가 접근할 수 있는 거버넌스 카탈로그에 dbt 변환 DAG, 모델 정의, 컬럼 설명 및 테스트 검증 상태 노출.
2. **Silver 모델 발행 게이트 (WAP)**: 현재 모델은 테스트가 실행되기 전에 `table`로 직접 실체화됩니다 (`adr/0007-dbt-core-transformation-layer-ko.md:112-132`). Silver 테스트가 실패하면 Gold는 건너뛰지만 손상된 Silver 테이블이 그대로 유지됩니다 (`dbt/README.md:68-70`).

| 공백 ID | 이슈 #95 수락 기준 | 다루는 절 |
|---|---|---|
| G-DBT-1 | dbt 모델 계보, 메타데이터 및 스키마 문서가 거버넌스 카탈로그에 노출됨 | 2.1, 4, 6.1 |
| G-DBT-2 | 사전 발행 품질 및 스키마 검증이 Silver 테이블 대체를 제어함 (WAP) | 2.2, 5, 6.2 |

---

## 2. 현재 상태 (검증됨)

### 2.1 카탈로그 및 계보 현황
- **OpenMetadata 선택적 배포**: 조건부 배포 (`gitops/charts/beluga-data/templates/11-openmetadata.yaml:28`, `{{ if (dig "openmetadata" "enabled" false .Values.AsMap) }}`); 기본 비활성화 (`gitops/charts/beluga-data/values.yaml:67-68`), `profile-full.yaml:2-3` (48GB+)에서만 활성화. 버전은 `1.13.3` (`VERSIONS.md:48`, Apache-2.0).
- **수집 워크플로우 부재**: 수집 러너, 수집 DAG 또는 동기화 작업이 전혀 없음 (`docs/lineage-and-metadata-quality-ko.md:48-51`). Lakekeeper (`VERSIONS.md:34`, Apache-2.0)가 Iceberg 메타데이터의 단일 원천이며, OpenMetadata는 데이터가 없는 파생 뷰임.
- **정적 컬럼 계보**: `scripts/lineage/sql_lineage.py:1-40`의 오프라인 파서가 커밋된 리포트 `docs/generated/column-lineage.json:1-35`를 생성하며 `scripts/ci/check-column-lineage.py`가 검증함 (`Makefile:61`). 정적 SQL만 파싱하며 dbt Jinja 모델은 추출하지 않음.
- **dbt 아티팩트**: 로컬 CI는 `target/manifest.json`, `target/catalog.json`, `target/run_results.json`을 생성함 (`dbt/README.md:16-19,51-53`). 프로덕션 DAG (`gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py:24-26`)는 임시 파드에서 `dbt build`를 실행하며 파드 종료 시 아티팩트가 폐기됨 (`:74`).

### 2.2 발행 게이트 현황
- **다운스트림 차단에 국한**: D-DBT-6 (`adr/0007-dbt-core-transformation-layer-ko.md:112-128`)은 `dbt build`를 사용하여 모델 실체화 후 테스트를 실행함. 에러 발생 시 다운스트림 Gold (`daily_revenue`)는 건너뛰지만, Silver (`silver_shop.orders`)는 이미 Iceberg에 반영됨.
- **실체화 방식**: 두 모델 모두 전체 `table` 재빌드 방식 채택 (`adr/0007-dbt-core-transformation-layer-ko.md:129-139`, D-DBT-7).
- **기존 스키마 권한**: 역할 `transformers`는 카탈로그 `iceberg` 스키마 `[silver_shop, gold_shop]`에 대해 `[CreateSchema, CreateTable, DropTable, RenameTable, SetTableProperties, InsertIntoTable, DeleteFromTable, SelectFromColumns, CreateView, DropView, CreateViewWithSelectFromColumns, ShowTables, ShowColumns, ShowCreateTable, FilterTables, FilterColumns, FilterSchemas]` 권한을 보유함 (`policies/resources.yaml:45-56`). `RenameTable`이 이미 부여되어 있음.

---

## 3. 수락 기준 대비 공백

| ID | 설명 | 저장소 내 근본 원인 |
|---|---|---|
| G-DBT-1 | dbt DAG, 문서 및 컬럼 설명이 카탈로그 사용자에게 보이지 않음 | OpenMetadata 수집 파이프라인 부재; `dbt docs` 사이트 미서빙; 파드 종료 시 dbt 아티팩트 삭제 (`dbt_shop_medallion.py:74`). |
| G-DBT-2 | 검증 전에 Silver 테이블이 직접 덮어쓰여짐 | 대상 테이블에 직접 실체화; `dbt build`는 실체화 완료 후 테스트를 수행함 (`adr/0007-dbt-core-transformation-layer-ko.md:112-125`). |

---

## 4. 공백 1 비교 옵션: 거버넌스 카탈로그 내 dbt 계보 및 문서화

### 옵션 A: OpenMetadata dbt 수집 파이프라인 구축
- **메커니즘**: `metadata-ingestion[dbt]`를 사용하여 `manifest.json`, `catalog.json`, `run_results.json`을 OpenMetadata로 수집 (*고정된 OM 1.13.3 업스트림 문서 검증 대상*).
- **아티팩트 저장소**: SeaweedFS S3에 저장 (`http://seaweedfs-s3.storage.svc.cluster.local:8333`, 버킷 `beluga-lake/dbt-artifacts/<run_id>/`, `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:78,137`).
- **신원 및 권한**: OpenMetadata 수집 봇 토큰 (`docs/lineage-and-metadata-quality-ko.md:49`), S3 읽기 자격증명, OM 엔터티 쓰기 권한 (`Table`, `Lineage`, `Tag`) 필요.
- **스케줄링**: `dbt_shop_medallion.py` DAG의 후속 태스크로 `governance` 또는 `orchestration` 네임스페이스에서 `KubernetesPodOperator` 실행.
- **종속성 및 위험**: 선행 Trino 서비스 메타데이터 수집에 대한 엄격한 종속성 (*OM 1.13.3 문서 검증 대상*). 기본 32GB 프로파일 미지원 (`values.yaml:67-68`). 메모리 및 연산 오버헤드 높음.

### 옵션 B: 게이트웨이/SSO 연계 `dbt docs` 정적 사이트 발행
- **메커니즘**: DAG 실행 후 `dbt docs generate`를 실행하고 정적 자산(`index.html`, `manifest.json`, `catalog.json`)을 SeaweedFS 또는 `analytics` 내 전용 nginx 파드에 배포 (라이선스: 2-clause BSD, *검증 대상*).
- **접근 통제**: APISIX 라우트 `dbt-docs.<baseDomain>`에 Keycloak OIDC 연동(`openid-connect` 플러그인)을 적용하고 `analysts`, `engineers` 그룹으로 접근 제한.
- **종속성 및 위험**: OpenMetadata에 독립적이며 모든 프로파일에서 동작함. 단, 비 dbt 자산(Kafka/Flink)과의 통합 전사 검색 UI는 제공하지 않음.

### 옵션 C: `openlineage-dbt` 기반 OpenLineage 런타임 이벤트 발행
- **메커니즘**: dbt 실행 시 OpenLineage JSON 이벤트를 HTTP 백엔드로 전송 (*dbt 1.12.6 호환성 및 라이선스 검증 대상*).
- **종속성 및 위험**: Beluga에는 배포된 OpenLineage 백엔드가 없음 (`docs/lineage-and-metadata-quality-ko.md:43,57`). Marquez 또는 전용 수집기 도입 시 클러스터 리소스 소모 및 네트워크 정책 추가 필요.

### 옵션 D: 카탈로그 수집 유예 및 정적 컬럼 계보 리포트 활용
- **메커니즘**: `scripts/lineage/sql_lineage.py`를 확장하여 dbt 컴파일 SQL 또는 `manifest.json`을 `docs/generated/column-lineage.json`에 반영.
- **종속성 및 위험**: 런타임 부하 0, CI에서 검증됨 (`make validate`). 데이터 소비자를 위한 인터랙티브 UI 및 실시간 상태 제공 불가.

---

## 5. 공백 2 비교 옵션: Silver 발행 게이트 및 후보 격리 (WAP)

### 옵션 A: Trino 기반 Iceberg 브랜치 Write-Audit-Publish (WAP)
- **메커니즘**: Silver 후보 데이터를 Iceberg 감사 브랜치 `orders$branch_<run_id>`에 작성, dbt 테스트로 브랜치 검증 후 통과 시 `main` 브랜치를 패스트포워드(`ALTER TABLE silver_shop.orders EXECUTE fast_forward(...)`), 감사 브랜치 삭제.
- **검증 필요 역량**: Trino 483 (`VERSIONS.md:37`)이 Lakekeeper REST 카탈로그 v0.13.1 (`VERSIONS.md:34`) 상에서 브랜치 쓰기 및 패스트포워드를 지원하는지 여부 (*Trino 483 업스트림 문서 검증 대상*). `dbt-trino` 1.11.0의 브랜치 실체화 기본 지원 여부 (*dbt-trino 문서 검증 대상*).
- **권한 공백**: 브랜치 프로시저 실행은 `ExecuteTableProcedure` 또는 특정 `AlterTable` 작업이 필요하나 `policies/resources.yaml:45-56`에 없으므로 OPA 컴파일러 확장이 요구됨.

### 옵션 B: `silver_shop` 내 스테이징 테이블 + 원자적 스왑 (Rename)
- **메커니즘**:
  1. Silver 후보를 `silver_shop.orders__staging`에 실체화.
  2. `orders__staging`을 대상으로 dbt 에러 수준 테스트 실행.
  3. 테스트 실패 시: `orders__staging`을 삭제; 기존 `silver_shop.orders`는 그대로 보존됨.
  4. 테스트 통과 시: 순차적 이름 변경 실행:
     `ALTER TABLE silver_shop.orders RENAME TO silver_shop.orders__backup;`
     `ALTER TABLE silver_shop.orders__staging RENAME TO silver_shop.orders;`
     `DROP TABLE silver_shop.orders__backup;`
- **권한 부합성**: `RenameTable`, `CreateTable`, `DropTable`, `InsertIntoTable`이 역할 `transformers`에 **이미 부여되어 있음** (`policies/resources.yaml:45-56`). OPA 정책 수정 불필요.
- **장애 모드 및 조회자 영향**: Trino는 단일 문장 원자적 다중 테이블 rename을 지원하지 않음. 두 번의 rename 사이에 테이블이 순간적으로 존재하지 않는 밀리초 단위 간극이 발생하여 동시 쿼리 시 일시적인 `TABLE_NOT_FOUND` 가능. 2단계 rename 실패 시 `orders__backup`을 원복하는 복구 훅 필요.

### 옵션 C: dbt `--empty` 사전 실행 및 소스 테스트
- **메커니즘**: 테이블 실체화 전 `dbt build --empty` 및 `dbt test --select source:*` 수행.
- **종속성 및 위험**: 상위 소스 스키마 위반 및 구문 오류는 사전에 차단하나, 변환 로직 자체로 인해 생성된 데이터 품질 결함은 검출하지 못함.

### 옵션 D: 현상 유지 (`dbt build` 직접 대체)
- **메커니즘**: 기존 D-DBT-6 동작 유지; Silver는 즉시 덮어써지고 테스트 실패 시 Gold만 차단됨.
- **종속성 및 위험**: 수동 복구 또는 롤백 전까지 손상된 Silver 데이터가 조회자에게 노출됨.

---

## 6. 권고안 및 트레이드오프

1. **공백 1 권고안**: 1단계로 **옵션 B (게이트웨이/SSO 연계 `dbt docs` 정적 사이트)**와 **옵션 D (정적 컬럼 계보 CI 확장)**를 채택함.
   - *근거*: OpenMetadata는 32GB 프로파일에서 비활성화되어 있으며 (`values.yaml:67-68`), 수집 러너가 부재함 (`docs/lineage-and-metadata-quality-ko.md:48-51`). `dbt docs` 서빙은 추가 부하 없이 즉시 시각적 계보와 모델 문서를 제공함. 옵션 A는 Trino 카탈로그 수집이 안정화된 후 48GB+ 프로파일용 2단계로 검토함.
2. **공백 2 권고안**: **옵션 B (스테이징 테이블 + Rename 스왑)**와 **옵션 C (소스 테스트 사전 점검)**를 병행 채택함.
   - *근거*: 이미 승인된 `RenameTable` 스키마 권한을 활용함 (`policies/resources.yaml:45-56`). OPA 컴파일러 변경 없이 Silver 데이터 오염을 차단함. Iceberg 브랜치 WAP(옵션 A)는 Trino 483 / Lakekeeper 프로시저 지원과 OPA 권한 설계가 실측된 후로 유예함.

---

## 7. 남은 소유자 결정 사항

| 결정 ID | 주제 | 고려된 옵션 | 권고안 | 근거 |
|---|---|---|---|---|
| **OD-DBTL-1** | 계보 및 문서 노출 경로 | (A) OpenMetadata dbt 수집<br>(B) APISIX/SSO 연동 `dbt docs`<br>(C) OpenLineage 런타임 백엔드<br>(D) 정적 CI 리포트 유지 | **1단계 옵션 B, 2단계 옵션 A 검토** | 옵션 B는 무거운 워크로드 추가 없이 기존 APISIX/Keycloak SSO를 통해 모든 프로파일을 즉시 지원함. |
| **OD-DBTL-2** | dbt 아티팩트 영속화 저장소 | (A) SeaweedFS S3 버킷 `beluga-lake`<br>(B) `analytics` 공유 PVC<br>(C) 파드 임시 스토리지 (폐기) | **옵션 A: SeaweedFS S3 (`beluga-lake/dbt-artifacts/`)** | 파드 라이프사이클과 분리되어 계보 수집 및 문서 서빙에 안정적으로 자산을 제공함. |
| **OD-DBTL-3** | Silver 발행 게이트 메커니즘 | (A) Iceberg 브랜치 WAP<br>(B) 스테이징 테이블 + Rename 스왑<br>(C) 소스 사전 검증만 수행<br>(D) 현상 유지 | **옵션 B 및 옵션 C 병행** | `RenameTable` 권한이 이미 확보되어 있음 (`policies/resources.yaml:45-56`). OPA 변경 없이 데이터 무결성을 보장함. |
| **OD-DBTL-4** | 테이블 스왑 시 조회자 영향 허용 여부 | (A) 밀리초 단위 이름 변경 간극 수용<br>(B) 네이티브 브랜치 WAP 실증 전까지 보류 | **옵션 A: 이름 변경 간극 수용** | 1일 1회 야간 배치 환경에서 동시성 영향이 극히 미미하며 미검증 프로시저에 의존하지 않음. |

---

## 8. 후속 구현 태스크 (순서별)

1. **태스크 1: 사전 소스 테스트 및 스테이징 Rename 매크로 구현 (공백 2)**
   - `RenameTable`을 사용하는 커스텀 dbt 실체화 또는 프리/포스트 훅 매크로 작성.
   - *검증 (정적/렌더)*: 로컬 DuckDB 픽스처 기반 `make dbt-check` 통과.
   - *검증 (라이브 클러스터)*: colima 상에서 의도적 실패 주입 시 스테이징 삭제 및 기존 Silver 유지 확인.
2. **태스크 2: Airflow DAG 내 아티팩트 S3 업로드 연동 (공백 1)**
   - `dbt_shop_medallion.py`를 업데이트하여 `manifest.json`, `catalog.json`, `run_results.json`을 `s3://beluga-lake/dbt-artifacts/`로 업로드.
   - *검증 (정적/렌더)*: DAG 문법 검증 (`scripts/ci/check-rendered-shell-syntax.py`).
   - *검증 (라이브 클러스터)*: DAG 실행 후 SeaweedFS S3에 JSON 아티팩트 저장 확인.
3. **태스크 3: 거버넌스 `dbt docs` 서비스 및 APISIX 라우트 배포 (공백 1)**
   - `analytics`에 정적 문서 서버를 배치하고 APISIX 라우트 `dbt-docs.<baseDomain>` 및 Keycloak OIDC 구성.
   - *검증 (정적/렌더)*: `helm lint gitops/charts/beluga-data`, `scripts/ci/check-gateway-sso.py`.
   - *검증 (게이트웨이/인증 라이브)*: `https://dbt-docs.local.beluga.internal` 접속 시 Keycloak 로그인 강제 확인.
4. **태스크 4: dbt 모델의 정적 컬럼 계보 추출 연동 (공백 1)**
   - `scripts/lineage/sql_lineage.py`를 확장하여 컴파일된 dbt 모델을 추출하고 `docs/generated/column-lineage.json`과 대조.
   - *검증 (정적/렌더)*: `make validate` 내 `python3 scripts/ci/check-column-lineage.py --check` 통과.

---

## 9. 원천 (Sources)

### 9.1 외부 문서 및 라이선스
- [S1] OpenMetadata, *dbt Connector Documentation*, https://docs.open-metadata.org/latest/connectors/ingestion/workflows/dbt (*고정 버전 OM 1.13.3 검증 대상*). Apache-2.0.
- [S2] Trino Software Foundation, *Iceberg Connector Procedures & Branches*, https://trino.io/docs/483/connector/iceberg.html (*Trino 483 브랜치 fast_forward 구문 검증 대상*). Apache-2.0.
- [S3] dbt-trino, *dbt-trino Adapter Documentation*, https://github.com/starburstdata/dbt-trino (*고정 버전 1.11.0 검증 대상*). Apache-2.0.
- [S4] OpenLineage, *dbt Integration*, https://openlineage.io/docs/integrations/dbt (*라이선스 및 런타임 종속성 검증 대상*). Apache-2.0 (*검증 대상*).

### 9.2 저장소 원천
- OpenMetadata 구성 및 프로파일: `gitops/charts/beluga-data/templates/11-openmetadata.yaml:28`, `gitops/values/profile-full.yaml:2-3`, `gitops/charts/beluga-data/values.yaml:67-68`.
- 컴포넌트 버전 및 라이선스: `VERSIONS.md:34,37-39,48-49`.
- dbt 의사결정 및 런타임 DAG: `docs/adr/0007-dbt-core-transformation-layer-ko.md:30-59,112-146`, `gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py:13-77`, `dbt/README.md:16-100`.
- OPA 리소스 및 스키마 권한: `policies/resources.yaml:9-17,45-56`.
- S3 SeaweedFS 엔드포인트: `gitops/charts/beluga-data/templates/12-lakekeeper-bootstrap.yaml:78,137`.
- 메타데이터 품질 및 계보 기준선: `docs/lineage-and-metadata-quality-ko.md:46-71`.
