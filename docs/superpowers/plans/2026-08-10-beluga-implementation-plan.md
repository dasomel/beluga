# Beluga 구현 계획서

- 작성일: 2026-08-10
- 스펙: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md`
- 상태: 구현 및 검증 완료

---

## 1. 개요 및 목표

Vagrant 기반 독립 Kubernetes 클러스터 위에 풀스택 데이터 플랫폼(Strimzi Kafka + Debezium CDC + Flink + SeaweedFS S3 + Lakekeeper Iceberg REST Catalog + Trino + Airflow 3 + Superset + CNPG PostgreSQL)을 구축하고, 이벤트 스트리밍 및 CDC 복합 데모와 자동 검증 스크립트를 구현한다.

---

## 2. 세부 구현 단계 (Phases)

### Phase 1: 기초 구조 및 프로젝트 컨벤션 구축
- [x] `CLAUDE.md`: Source Map 기반 프로젝트 지침 문서
- [x] `docs/mistakes-log.md`: 실수 기록 문서 초기화
- [x] `VERSIONS.md`: 컴포넌트 및 이미지 버전 단일 원천 (Single Source of Truth)
- [x] `configs/cluster.env`: 서브넷(`192.168.57.x`), MetalLB VIP 범위, RAM 프로파일 설정

### Phase 2: 인프라 프로비저닝 및 부트스트랩
- [x] `Vagrantfile`: master-1 (4GB) + worker-1~3 (8GB/10GB/12GB 동적 프로파일) VM 구성
- [x] `scripts/common/`: logging, env 유틸리티 스크립트
- [x] `scripts/cluster/`: K8s v1.35 프로비저닝, Cilium CNI, MetalLB 설치 스크립트
- [x] `scripts/gitops/`: ArgoCD 부트스트랩 스크립트
- [x] `scripts/up.sh`: 호스트 RAM 감지 및 전체 클러스터 자동 기동 진입점
- [x] `Makefile`: 작업 편의를 위한 래퍼 명령 정의 (`make up`, `make test`, `make lint` 등)

### Phase 3: GitOps App-of-Apps 및 Helm 차트
- [x] `gitops/apps/`: `app-of-apps.yaml` 및 플랫폼/데이터 레이어 App 매니페스트
- [x] `gitops/charts/beluga-platform/`: MetalLB, cert-manager, Prometheus + Grafana, ArgoCD 설정
- [x] `gitops/charts/beluga-data/`:
  - Strimzi Kafka Operator & KRaft Cluster & Kafka Connect (Debezium)
  - SeaweedFS S3 Object Storage
  - CNPG PostgreSQL Operator & Shop / Meta Databases
  - Lakekeeper Iceberg REST Catalog
  - Flink Kubernetes Operator & FlinkDeployment
  - Trino Coordinator & Worker
  - Airflow 3 (KubernetesExecutor, 호스트 포트 8085)
  - Superset

### Phase 4: 복합 데모 파이프라인 구현
- [x] `demo/shop-seed/`: CNPG shop DB 스키마, 시드 데이터 및 DB 변경 생성 스크립트
- [x] `demo/clickstream-gen/`: Python 기반 클릭스트림 이벤트 생성기 (Kafka Producer)
- [x] `demo/flink-sql/`: 클릭스트림 세션화 및 CDC upsert 미러링 Flink SQL
- [x] `demo/airflow-dags/`: Iceberg table compaction 및 snapshot expiration DAG
- [x] `demo/superset/`: 합성 이벤트 및 CDC 조인 대시보드 내보내기 파일

### Phase 5: 검증 스크립트 및 Linting
- [x] `tests/`: K8s 상태, Kafka/CDC, Flink/Iceberg, Trino 타임트래블, Airflow DAG 자동 검증 스크립트
- [x] `shellcheck`, `helm lint` 검증 수행

---

## 3. 검증 항목 (Definition of Done)

1. `up.sh` 및 Makefile 조작 준비 완료 (실행 권한 포함)
2. `VERSIONS.md` 기반 버전 일관성 확보
3. `tests/` 아래의 각 단계별 검증 스크립트 작동 및 실상태 검증 가능 완료
4. linting (`shellcheck`, `helm lint`) 100% 통과
