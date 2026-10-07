# 외부 네트워크 의존성

[English](external-dependencies.md) | 한국어

저장소의 설치·배포·런타임 코드가 접근하는 외부 호스트를 단계별로 묶어, 이 저장소에서만 도출한 인벤토리와 CI 래칫입니다. [이슈 #36](https://github.com/dasomel/beluga/issues/36) ("Define data residency and deployment-boundary controls")의 범위를 제한한 정적 슬라이스입니다.

> [!IMPORTANT]
> **인벤토리 사실이며 승인이 아닙니다.** 여기에 나열된 호스트는 저장소 코드가 해당 단계에서 접근한다는 뜻일 뿐입니다. 포함은 승인도, 제한 프로파일 허용 목록도 아니며 어떤 데이터 등급이 어떤 경계를 벗어날 수 있는지에 대해서도 말하지 않습니다. 데이터 등급별 레지던시, 제한 프로파일 허용 목록의 내용, 라이브 클러스터 대상 사전 점검 강제, 원격 관리 정책은 #36의 열린 정책 결정이며 여기서 결정하지 않습니다. 폐쇄망 설치 프로파일이 가장 강한 경계 옵션이라는 점은 바뀌지 않습니다.

## 래칫

`python3 scripts/ci/check-external-endpoints.py`는 `make validate`에서 실행됩니다. 아래 소스에서 (호스트, 단계) 집합을 추출해 커밋된 [`scripts/ci/external-endpoints-baseline.yaml`](../scripts/ci/external-endpoints-baseline.yaml)(항목당 host, phase, reason; 이 파일이 기계가 읽는 목록)과 비교합니다.

- 기준선에 없는 **새** (호스트, 단계)는 CI를 **실패**시킵니다. 사유와 함께 기준선에 추가하는 것이 탈출구이며 diff에서 리뷰됩니다. 이는 인벤토리 사실의 기록이지 승인이 아닙니다.
- 더 이상 참조되지 않는 기준선 항목은 stale로 **실패**합니다(`image-digest-baseline.yaml`과 같은 입장). 삭제해 목록이 줄기만 하게 합니다.
- 형식이 잘못된 기준선(매핑 아님, 알 수 없는 단계, 중복, 빈 사유, 잘못된 호스트)과 이미지를 하나도 얻지 못한 렌더·스캔은 fail closed 합니다.
- 기준선의 모든 호스트는 이 문서와 [영문 문서](external-dependencies.md)에 백틱으로 나타나야 합니다.
- 음성 fixture 회귀 테스트: `tests/test_external_endpoints.py`.

`--report`는 현재의 단계, 호스트, 근거 행을 출력합니다.

### 오탐 회피 방법과 알려진 한계

URL은 `http(s)`, `ftp`, `ssh` 스킴과 `git@host:` clone 형식을 매칭하며 `user@` userinfo는 제거해 실제 호스트를 목록화합니다. 설정된 소스 루트(`scripts/`, `gitops/apps/`, `gitops/charts/`, `demo/`)가 없거나 비어 있으면 게이트가 명시적으로 실패합니다. 추출은 줄 단위로 보수적입니다. 주석 줄, 줄 끝 `#` 주석, 따옴표로 묶인 `echo`/`printf`/`log_*` 메시지는 무시하고, 내부 호스트(점 없음, `localhost`, IP, `*.svc`, `*.cluster.local`, `*.beluga.internal`)와 템플릿 호스트(`${...}`, `{{ ... }}`, 끝 점)는 건너뜁니다. 리터럴 URL이 없는 암묵적 엔드포인트는 고정 규칙을 씁니다. `pip install` / `uv pip install`은 `pypi.org` + `files.pythonhosted.org`, `apt-get install|update`는 `apt-os-mirrors`(호스트명이 아닌 예약된 자리표시자로, 게이트가 허용하는 유일한 점 없는 baseline 항목이며 실제 미러는 OS apt 소스에서 옴), `config.vm.box`는 `app.vagrantup.com`, 이름만 있거나 네임스페이스만 있는 이미지는 `docker.io`입니다.

알려진 한계:

- 호스트를 설명만 하는 heredoc·문자열 안의 URL도 일치할 수 있고, 변수로 조립한 호스트는 보이지 않습니다.
- 저장소가 설치하는 대상이 접근하는 호스트는 **여기서 도출할 수 없습니다**: `get-helm-3`와 `get.k3s.io` 스크립트 자체의 다운로드, 업스트림 매니페스트·차트(Argo CD, cert-manager, CloudNativePG, Strimzi, Cilium, MetalLB, Flink Kubernetes Operator, APISIX CRD)의 이미지와 다운로드. 이미지 레지스트리는 렌더된 차트의 이미지에서만 얻습니다.
- pip·Maven 핀은 여기서 검사하지 않으며(`check-dependency-integrity.py` 참고) 이 게이트는 호스트만 나열합니다.
- 업스트림 이미지 내부에만 있는 텔레메트리, 업데이트 확인, 외부 연동은 다루지 않습니다.
- 의도적 제외: `.github/workflows/**`(CI 전용, 플랫폼 의존성 아님), `scripts/**/*.py`, `scripts/ci`, `scripts/release`, `research/`(개발·CI 도구), 문서와 테스트.

### 라이브 관측, 저장소에서 도출 불가

한 번의 라이브 관측(2026-10-07, 실행 중인 클러스터, Argo CD `quay.io/argoproj/argocd:v3.5.0`)에서 아래 표에 없는 이미지 레지스트리가 확인되었습니다. `public.ecr.aws`가 `public.ecr.aws/docker/library/redis:8.2.3-alpine`(Argo CD redis, `argocd` 네임스페이스)을 제공합니다. 이는 `scripts/gitops/01-argocd-bootstrap.sh`가 적용하는 업스트림 Argo CD 설치 매니페스트에서 오며 이 저장소의 차트에서 오지 않으므로 추출기가 볼 수 없고, 기계 검사 기준선에는 의도적으로 **넣지 않습니다**(래칫은 저장소 소스에서 도출하며, 참조되지 않는 항목은 stale로 실패합니다). 해당 클러스터에서 보인 나머지 레지스트리(`docker.io`, `ghcr.io`, `quay.io`, `registry.k8s.io`)는 이미 표에 있으나, 그 위의 업스트림 매니페스트 이미지(Argo CD, Dex, Cilium, cert-manager, MetalLB, CloudNativePG, Strimzi, Flink operator)도 여기서 도출되지는 않습니다. 이는 단일 관측의 인벤토리 사실이며 승인이나 정책이 아니고, 포함은 승인이 아니라는 위 설명이 그대로 적용됩니다.

## 단계별 인벤토리

### 호스트 부트스트랩 및 설치 스크립트 (`host-install`)

스캔 소스: `Vagrantfile`, `Makefile`, `scripts/gitops/` 제외 `scripts/**/*.sh`

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `app.vagrantup.com` | Vagrant 박스 | `Vagrantfile:67` |
| `apt-os-mirrors` | OS 패키지(암묵 자리표시자, 호스트명 아님) | `scripts/cluster/10-dnsmasq.sh:47`<br>`scripts/cluster/10-dnsmasq.sh:48` |
| `get.k3s.io` | 설치 스크립트 | `scripts/cluster/02-k8s-init.sh:32`<br>`scripts/cluster/02-k8s-init.sh:61` |
| `helm.cilium.io` | Helm 저장소 | `scripts/cluster/03-cni-metallb.sh:20` |
| `metallb.github.io` | Helm 저장소 | `scripts/cluster/03-cni-metallb.sh:34` |
| `raw.githubusercontent.com` | GitHub raw(설치 스크립트) | `scripts/cluster/03-cni-metallb.sh:16` |

### 배포 부트스트랩(GitHub raw/릴리스 다운로드, Helm 저장소) (`deploy-bootstrap`)

스캔 소스: `scripts/gitops/**/*.sh`

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `downloads.apache.org` | Helm 저장소 | `scripts/gitops/01-argocd-bootstrap.sh:320` |
| `github.com` | GitHub 릴리스 매니페스트 | `scripts/gitops/01-argocd-bootstrap.sh:299`<br>`scripts/gitops/01-argocd-bootstrap.sh:313` |
| `raw.githubusercontent.com` | GitHub raw 매니페스트 | `scripts/gitops/01-argocd-bootstrap.sh:23`<br>`scripts/gitops/01-argocd-bootstrap.sh:306`<br>`scripts/gitops/01-argocd-bootstrap.sh:332` |

### GitOps 동기화 (`gitops-sync`)

스캔 소스: `gitops/apps/**`

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `github.com` | Git 원격(Argo CD) | `gitops/apps/app-of-apps.yaml:11`<br>`gitops/apps/beluga-data.yaml:9`<br>`gitops/apps/beluga-platform.yaml:9` |

### 파드 기동·런타임(Flink/Maven 조회, pip/PyPI) (`pod-runtime`)

스캔 소스: `gitops/charts/**`(이미지 외 URL과 pip install)

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `files.pythonhosted.org` | PyPI 파일(암묵) | `gitops/charts/beluga-data/templates/07-airflow.yaml:161`<br>`gitops/charts/beluga-data/templates/08-superset.yaml:102`<br>`gitops/charts/beluga-data/templates/13-clickstream-gen.yaml:48` |
| `pypi.org` | PyPI 인덱스(암묵) | `gitops/charts/beluga-data/templates/07-airflow.yaml:161`<br>`gitops/charts/beluga-data/templates/08-superset.yaml:102`<br>`gitops/charts/beluga-data/templates/13-clickstream-gen.yaml:48` |
| `repo1.maven.org` | Maven 아티팩트(Flink) | `gitops/charts/beluga-data/templates/05-flink-operator.yaml:47`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:100`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:92`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:95`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:98` |

### 이미지 레지스트리(렌더된 차트) (`image-registry`)

스캔 소스: 두 차트의 `helm template`(`check-image-tag-immutability.py`의 3개 조합)과 Airflow DAG `image=`

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `docker.io` | 이미지 레지스트리(이름만 쓰면 암묵) | `beluga-data/files/dags/iceberg_maintenance.py:26` (trinodb/trino:483)<br>`beluga-data/templates/01-seaweedfs.yaml:67` (curlimages/curl:8.21.0)<br>`beluga-data/templates/05-flink-operator.yaml:8` (flink:1.20.0-scala_2.12-java17)<br>`beluga-data/templates/11-openmetadata.yaml:25` (opensearchproject/opensearch:2.18.0)<br>`beluga-data/templates/11-openmetadata.yaml:87` (openmetadata/server:1.13.3)<br>`beluga-data/templates/13-clickstream-gen.yaml:39` (python:3.12-slim)<br>`beluga-data/values.yaml:12` (chrislusf/seaweedfs:4.41)<br>`beluga-data/values.yaml:77` (apache/airflow:3.3.0-python3.11)<br>`beluga-data/values.yaml:82` (apache/superset:6.1.0)<br>`beluga-platform/templates/apisix-gateway.yaml:135` (apache/apisix:3.17.0-debian)<br>`beluga-platform/templates/apisix-gateway.yaml:400` (apache/apisix-ingress-controller:1.8.0)<br>`beluga-platform/templates/opa.yaml:51` (openpolicyagent/opa:1.19.0-static)<br>`beluga-platform/templates/openfga.yaml:41` (openfga/openfga:v1.18.3) |
| `ghcr.io` | 이미지 레지스트리 | `beluga-data/templates/02-cnpg.yaml:8` (ghcr.io/cloudnative-pg/postgresql:17.6)<br>`beluga-platform/templates/openldap.yaml:131` (ghcr.io/dasomel/ldapium:nightly-4e85165) |
| `quay.io` | 이미지 레지스트리 | `beluga-data/templates/03-strimzi-kafka.yaml:135` (quay.io/debezium/connect:3.6.1.Final)<br>`beluga-data/values.yaml:51` (quay.io/lakekeeper/catalog:v0.13.1)<br>`beluga-platform/templates/keycloak.yaml:304` (quay.io/keycloak/keycloak:26.7.1) |
| `registry.k8s.io` | 이미지 레지스트리 | `beluga-platform/templates/apisix-infra.yaml:51` (registry.k8s.io/etcd:3.5.31-0) |

### 데모 이미지 빌드(차트로 배포되지 않음) (`demo-build`)

스캔 소스: `demo/**/Dockerfile*`

| 호스트 | 종류 | 근거(file:line) |
|---|---|---|
| `docker.io` | 이미지 레지스트리(암묵) | `demo/clickstream-gen/Dockerfile:2` |
| `files.pythonhosted.org` | PyPI 파일(암묵) | `demo/clickstream-gen/Dockerfile:6` |
| `pypi.org` | PyPI 인덱스(암묵) | `demo/clickstream-gen/Dockerfile:6` |

호스트는 단계에 걸쳐 공유됩니다. `raw.githubusercontent.com`과 `github.com`은 호스트 부트스트랩과 배포 부트스트랩에 모두 쓰이고, `github.com`은 Argo CD 동기화 원격이기도 하며, `pypi.org`, `files.pythonhosted.org`, `docker.io`는 파드 런타임이나 데모 빌드 시점에도 나타납니다. 줄 번호는 이 문서를 마지막으로 수정한 커밋 기준이며 게이트가 검증하지 않습니다(`--report` 실행).
