# Beluga 아키텍처 개요

Beluga는 Vagrant로 만드는 독립 k3s 클러스터 위에 데이터 플랫폼을 배포하는 개인/학습 스케일 프로젝트다. VM 4대(master-1 한 대 + worker-1~3 세 대)의 고정 토폴로지로 풀 데이터 스택을 띄우며, 호스트 RAM(32/48/64GB+)에 따라 워커 메모리와 OpenMetadata·Trino worker 활성 여부만 자동으로 달라진다. ArgoCD의 app-of-apps가 `beluga-platform`과 `beluga-data` Helm 차트를 GitOps 방식으로 배포한다. 이 문서는 독자를 위한 요약이며, 결정 배경과 상세 설계는 [플랫폼 설계서](superpowers/specs/2026-08-09-beluga-data-platform-design.md)를 참고한다.

> **개인/학습 스케일 프로젝트다.** 프로덕션 레디를 표방하지 않는다. 운영 중 확인한 한계와 주의점은 [실수 기록](mistakes-log.md)에 누적한다.

## 데이터 흐름

```text
Kafka / Debezium CDC
        → Flink
        → Iceberg lakehouse (Lakekeeper catalog + SeaweedFS S3)
        → Trino / Superset
        → Airflow orchestration
```

- **클릭스트림 데모**: Python 합성 클릭스트림 생성기가 Kafka 이벤트를 만들고, Flink SQL이 세션화·윈도우 집계 후 Iceberg 테이블에 저장한다.
- **Postgres CDC 데모**: CNPG PostgreSQL `shop`의 변경을 Debezium이 Kafka에 전달하고, Flink SQL이 upsert 미러링하여 Iceberg 주문·고객 테이블을 만든다.
- **공통 하류**: Trino는 Iceberg를 조회하고, Superset은 대시보드를 제공하며, Airflow는 컴팩션·집계 작업을 오케스트레이션한다.

## 배포와 접근 경계

Vagrant가 VM을 만들고 k3s, Cilium, MetalLB를 준비한다. 이후 `scripts/gitops/01-argocd-bootstrap.sh`가 ArgoCD와 app-of-apps 루트를 적용한다. HTTP UI와 API의 도메인 레지스트리는 `*.local.beluga.internal`이며, APISIX 게이트웨이를 통해 HTTPS 443으로 통일한다. HTTP 80은 HTTPS로 301 리다이렉트된다. 서비스별 실제 URL과 DNS 설정은 [접근 가이드](access-guide.md)를 따른다.

## 리포 구성

| 경로 | 내용 |
|------|------|
| `configs/` | 클러스터 환경 변수와 노드·도메인·리소스 기본값 |
| `demo/` | 클릭스트림 생성기와 Flink SQL 등 데모 산출물 |
| `docs/` | 설계서, 접근 가이드, 검증 문서, 실수 기록 |
| `gitops/` | ArgoCD app-of-apps와 플랫폼·데이터 Helm 차트 |
| `policies/` | 그룹·롤·리소스 권한을 선언하는 YAML |
| `scripts/` | 부트스트랩, 노드 프로비저닝, GitOps, kubeconfig·자격증명·SBOM 유틸리티 |
| `tests/` | 실제 클러스터 상태를 조회하는 E2E 검증 스크립트 |

## 버전과 상세 설계

모든 컴포넌트 버전·이미지·라이선스의 단일 원천은 [VERSIONS.md](../VERSIONS.md)다. 이 문서에는 버전 표를 중복하지 않는다. 설계 결정과 트레이드오프는 [플랫폼 설계서](superpowers/specs/2026-08-09-beluga-data-platform-design.md), 알려진 운영상 함정은 [실수 기록](mistakes-log.md)에서 확인한다.
