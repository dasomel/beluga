# Beluga

[English](README.md) | 한국어

Beluga는 로컬 VM 위에 독립 Kubernetes 클러스터를 직접 구축하고, 그 위에 Kafka(+CDC) →
Flink → Iceberg 레이크하우스 → Trino/Superset → Airflow로 이어지는 데이터 플랫폼을
IaC(Vagrantfile + Helm + ArgoCD GitOps)로 배포하는 개인/학습용 프로젝트다.
바이너리를 직접 빌드하거나 벤더링하지 않는다 — 모든 컴포넌트는 배포 시점에
각자의 업스트림 레지스트리에서 그대로 받아온다.

narwhal(K8s IDP), kubemetal(Apple Silicon MLOps)과 함께 저자의 플랫폼 3부작 중
데이터 영역을 맡는다. 자세한 설계 배경은
[플랫폼 설계서](docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md)에 있다.

> **개인/학습 스케일 프로젝트다.** "프로덕션 레디"를 표방하지 않는다. 알려진 한계와
> 진행 중인 작업은 [현재 상태](#현재-상태) 섹션에 그대로 적는다.

---

## 목차

- [이게 뭔가](#이게-뭔가)
- [아키텍처 한눈에 보기](#아키텍처-한눈에-보기)
- [요구 사항](#요구-사항)
- [빠른 시작](#빠른-시작)
- [동작 확인 (검증)](#동작-확인-검증)
- [자격 증명](#자격-증명)
- [리포 구조](#리포-구조)
- [현재 상태](#현재-상태)
- [라이선스 및 제3자 고지](#라이선스-및-제3자-고지)

---

## 이게 뭔가

`vagrant up` 한 번으로 마스터 1대 + 워커 3대짜리 k3s 클러스터를 만들고, 그 위에
ArgoCD app-of-apps로 스트리밍 수집 · CDC · 스트림 처리 · Iceberg 레이크하우스 ·
분산 SQL 쿼리 · BI 대시보드 · 오케스트레이션까지 이어지는 스택을 GitOps로 배포한다.
합성 클릭스트림 이벤트 파이프라인과 Postgres CDC 파이프라인, 두 가지 데모로
엔드투엔드 동작을 증명하는 것이 목표다.

## 아키텍처 한눈에 보기

버전·이미지·라이선스의 단일 원천은 [VERSIONS.md](VERSIONS.md)다. 아래는 레이어별
요약이며, 정확한 버전은 항상 그 문서를 따른다.

| 레이어 | 컴포넌트 | 역할 |
|--------|----------|------|
| 클러스터 | k3s(v1.36 채널), Cilium, MetalLB | Kubernetes 배포판, CNI, LoadBalancer |
| 게이트웨이 | APISIX + etcd | 전 HTTP UI를 `*.local.beluga.internal:80`으로 통일 |
| GitOps | ArgoCD | app-of-apps 방식으로 전 워크로드 배포 |
| SSO/계정 | Keycloak + OpenLDAP | 인증·그룹의 단일 원천(Keycloak), 계정 저장소(OpenLDAP, WRITABLE 페더레이션) |
| 정책 | OPA + OpenFGA | Trino/Kafka 중앙 정책 엔진(OPA), Lakekeeper 인가(OpenFGA) |
| 수집 | Strimzi(Kafka, KRaft) + Debezium | 이벤트 스트리밍 + CDC 소스 |
| 스트림 처리 | Flink Kubernetes Operator | 세션화·집계, CDC upsert 미러링 |
| 카탈로그 | Lakekeeper | Iceberg REST Catalog |
| 스토리지 | SeaweedFS | S3 호환 오브젝트 스토리지 |
| DB | CloudNativePG(PostgreSQL) | CDC 소스 DB(shop) + 각 컴포넌트 메타 DB 통합 |
| 분석 | Trino | Iceberg 위 분산 SQL 쿼리 엔진 |
| BI | Superset | 대시보드 |
| 오케스트레이션 | Airflow 3(KubernetesExecutor) | 컴팩션·집계 DAG |
| 거버넌스(선택) | OpenMetadata + OpenSearch | 카탈로그·리니지 — 48GB+ 프로파일에서만 기본 켜짐 |
| 관측성 | Prometheus Stack | 메트릭 |

전부 Helm/Operator 기반이며 `gitops/charts/beluga-platform`(플랫폼 레이어)과
`gitops/charts/beluga-data`(데이터 레이어) 두 차트로 나뉘어 ArgoCD가 배포한다.

## 요구 사항

이 프로젝트는 VM 4대와 풀 데이터 스택을 통째로 띄운다 — 가벼운 데모가 아니다.

- **호스트 RAM**: 최소 32GB. `scripts/common/env.sh`가 호스트 RAM을 감지해 자동으로
  프로파일을 고른다.
  - 32GB: 기본 프로파일 (Trino coordinator 단독, OpenMetadata 꺼짐)
  - 48GB+: 워커 메모리 증설 + OpenMetadata·Trino worker 켜짐
  - 64GB+: 워커 메모리 추가 증설
- **VM 사양**: master-1(2 vCPU/4GB) + worker-1~3(4 vCPU/8~12GB, 프로파일별 상이) —
  32GB 프로파일 기준 합계 14 vCPU / 28GB
- **디스크**: VM 4대 + 컨테이너 이미지를 담을 여유 공간 (수십 GB 단위 권장)
- **하이퍼바이저**: VMware Fusion(arm64) 또는 VirtualBox(amd64) — `configs/cluster.env`의
  `VAGRANT_PROVIDER`로 선택
- **도구**: Vagrant, kubectl, helm

32GB 프로파일에서도 상시 메모리 예산이 가용치에 빠듯하게 맞춰져 있다 — 여유가 없는
호스트에서는 다른 무거운 VM/클러스터와 동시에 띄우지 않는 걸 권장한다.

## 빠른 시작

```bash
git clone <this-repo>
cd beluga

# 1. 클러스터 기동 (RAM 프로파일 자동 감지 → Vagrant VM → k3s → Cilium/MetalLB
#    → 로컬 DNS → ArgoCD GitOps 부트스트랩, 5단계)
make up
# 내부적으로 bash scripts/up.sh 를 실행한다
```

기동이 끝나면 호스트 DNS를 한 번 맞춰야 서비스 도메인이 풀린다. 두 방식 중 하나를 쓴다.

**옵션 A — macOS `/etc/resolver` (권장)**

```bash
sudo mkdir -p /etc/resolver
echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal
```

**옵션 B — `/etc/hosts` 직접 등록**

```
127.0.0.1 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal
```

> 실제 배포에서 위 도메인들은 `192.168.77.200`(MetalLB가 APISIX에 붙이는 LB IP)을
> 가리킨다. `CLAUDE.md`의 예시는 클러스터 없이 로컬에서 문서만 볼 때를 위한 placeholder다 —
> 자세한 IP·DNS 아키텍처는 [docs/access-guide.md](docs/access-guide.md)를 참고한다.

기동 후 주요 서비스:

- Trino: `https://trino.local.beluga.internal`
- Airflow: `https://airflow.local.beluga.internal`
- Superset: `https://superset.local.beluga.internal`
- Lakekeeper(Iceberg REST): `https://catalog.local.beluga.internal`
- SeaweedFS S3: `https://s3.local.beluga.internal`
- ArgoCD: `https://argocd.local.beluga.internal`
- Keycloak SSO: `https://sso.local.beluga.internal`

> 이슈 #2: 포트 80은 항상 443(HTTPS)로 301 리다이렉트되며, 인증서는 클러스터 내부 CA가
> 발급한다 — 브라우저/curl이 이 CA를 신뢰하도록 등록하거나 `curl --cacert`로 지정해야
> 한다. CA 인증서 확보 방법은 [tests/10-tls-identity-boundary.sh](tests/10-tls-identity-boundary.sh)를 참고한다.

기타 명령:

```bash
make status   # VM 및 K8s 파드 상태 확인
make test     # tests/ 검증 스크립트 전체 실행
make lint     # shellcheck + helm lint
make down     # VM 전체 삭제
```

## 동작 확인 (검증)

"렌더 통과"와 "실제로 동작"을 구분한다 — 이 리포는 실상태를 조회하는 검증 스크립트를
따로 둔다([docs/mistakes-log.md](docs/mistakes-log.md)가 바로 그 이유로 존재한다).

`bash tests/run-all.sh` (= `make test`)가 `tests/01`부터 `tests/05`까지, 그리고
`tests/07`부터 `tests/11`까지를 순서대로 실행한다(`06`은 제외 — 아래 참고).

| 스크립트 | 확인 내용 | 라이브 클러스터 필요? |
|----------|-----------|------------------------|
| `tests/01-cluster-health.sh` | K8s 노드·코어 파드 상태 | 필요 |
| `tests/02-ingest-cdc.sh` | Strimzi Kafka + Debezium CDC 파이프라인 | 필요 |
| `tests/03-stream-iceberg.sh` | Flink Operator + Lakekeeper Iceberg REST Catalog | 필요 |
| `tests/04-trino-query.sh` | Trino 쿼리 엔진 + Iceberg 커넥터 | 필요 |
| `tests/05-airflow-dag.sh` | Airflow 오케스트레이션 + Superset 서비스 | 필요 |
| `tests/07-trino-authz-live.sh` | Trino OPA default-deny 컷오버 회귀 검증 | 필요 |
| `tests/08-apisix-admin-restrict.sh` | APISIX Admin API 네트워크 제한 | 필요 |
| `tests/09-seaweedfs-authz-live.sh` | SeaweedFS S3 authz/authn 회귀 검증 | 필요 |
| `tests/10-tls-identity-boundary.sh` | SSO/identity 경계 TLS 회귀 검증 | 필요 |
| `tests/11-identity-plaintext-preflight.sh` | 렌더된 매니페스트에 평문 identity 엔드포인트가 없는지 | 불필요 — `helm template` 정적 검사만 |

`tests/06-authz-defaults.sh`(신규 테이블에 analyst 기본 권한이 새지 않는지 확인하는
권한 회귀 검증)는 `run-all.sh`에는 포함돼 있지 않고 별도로 실행하며, 여전히 라이브
클러스터가 필요하다.

## 자격 증명

**리포에는 어떤 비밀번호도 커밋돼 있지 않다.** 모든 값은 부트스트랩 시점에
`openssl rand`로 랜덤 생성되어 Kubernetes Secret(`beluga-credentials`)에 저장되고,
Helm 차트는 `--set`으로만 그 값을 주입받는다. 리포의 values 기본값은 전부
`SET-AT-BOOTSTRAP` placeholder다.

```bash
bash scripts/credentials.sh          # 서비스별 URL·계정·비밀번호 요약 출력
bash scripts/credentials.sh --raw    # key=value 형태 (스크립트/파이프용)
```

원본 Secret을 직접 조회하려면:

```bash
kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d
```

## 리포 구조

| 경로 | 내용 |
|------|------|
| `Vagrantfile` | master-1 + worker-1~3 VM 정의 |
| `Makefile` | `up`/`down`/`status`/`test`/`lint` 래퍼 |
| `VERSIONS.md` | 전 컴포넌트 버전·이미지·라이선스의 단일 원천 |
| `configs/cluster.env` | 서브넷, 노드 IP, RAM 사이징 기본값, 도메인 레지스트리 |
| `scripts/` | 부트스트랩 진입점(`up.sh`), 노드 프로비저닝(`cluster/`), GitOps 부트스트랩(`gitops/`), kubeconfig·자격증명·SBOM 유틸리티 |
| `gitops/` | ArgoCD app-of-apps 매니페스트와 `beluga-platform`/`beluga-data` Helm 차트 |
| `demo/` | 클릭스트림 생성기(Python)와 Flink SQL 파이프라인 정의. Shop DB 시드·대시보드 export 등 나머지 데모 산출물은 해당 컴포넌트의 Helm 차트 `templates/`·`files/` 안에 함께 있다 |
| `policies/` | 그룹·롤·리소스 권한을 선언하는 YAML — companion 리포(정책 컴파일러)가 이를 Keycloak·Rego·PostgreSQL DDL 세 산출물로 컴파일하는 소스 |
| `tests/` | 실상태를 조회하는 E2E 검증 스크립트 |
| `docs/` | 설계서, 실수 기록(`mistakes-log.md`), 접근 가이드(`access-guide.md`), 구현 계획서 |

## 현재 상태

이 리포를 클론하는 시점의 실제 상태를 숨기지 않는다.

- **로컬 클러스터는 현재 내려가 있다** (`vagrant status`가 4개 VM 전부 `not running`).
  최근 변경 사항 일부는 라이브 클러스터에서 재검증되지 않은 상태다.
- **핵심 데이터 플랫폼**(Kafka/CDC → Flink → Iceberg → Trino/Superset/Airflow, k3s +
  ArgoCD GitOps 부트스트랩)은 클린 인스톨 E2E까지 구현·검증이 완료된 상태다.
- **정책 컴파일러 통합이 진행 중**이다. `policies/`의 선언 YAML을 Keycloak/Rego/PostgreSQL
  산출물로 컴파일하는 컴파일러 자체(Task 1~12)는 별도 companion 리포에서 구현·리뷰가
  끝났지만, 그 산출물을 이 클러스터에 실제로 배포하고 검증하는 단계(Task 13~19 —
  Trino LDAP 그룹 프로바이더, 정책 컷오버, Superset 롤 매핑, 카탈로그 브라우징 오퍼레이션
  갭 등)는 라이브 클러스터가 필요해 아직 남아 있다.
- 알려진 한계와 결함, 그 원인·해결 과정은 [docs/mistakes-log.md](docs/mistakes-log.md)에
  계속 누적해서 기록한다 — 이 리포가 "성공만 기록"하지 않는다는 원칙이다.

## 라이선스 및 제3자 고지

이 리포 자체는 [LICENSE](LICENSE)(Apache License 2.0)를 따른다.

배포하는 각 컴포넌트가 어떤 라이선스인지는 리포에 중복 기재하지 않고
[VERSIONS.md](VERSIONS.md)의 라이선스 열을 단일 원천으로 삼는다. 이 프로젝트가
바이너리를 빌드·벤더링하지 않고 컴포넌트를 어떻게 네트워크로만 참조하는지,
카피레프트 컴포넌트를 이 방식으로 배포할 때의 경계, 그리고 라이브 클러스터
SBOM 생성 방법(`scripts/generate-sbom.sh`)은 [NOTICE](NOTICE)에 정리돼 있다.
