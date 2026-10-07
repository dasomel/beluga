# 업스트림 아티팩트 검증 (제안)

[English](upstream-artifact-verification.md) | 한국어

이슈 #103 ("[P0][Security][Supply Chain] Fail-Closed Build Dependency and Upstream Artifact Verification") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 워크플로, 스크립트, 차트, 락 파일, `VERSIONS.md`, 정책을 변경하지 않는다.
> 저장소에 대한 모든 서술에는 이 문서를 작성한 시점의 커밋(`332b92c`)에서 읽은 `file:line` 참조가 붙는다. 라이브 상태에 대한
> 서술은 2026-10-07의 읽기 전용 `kubectl get`에서 얻은 것이며 `file:line`이 없으므로 재확인해야 한다. 외부 사실은 출처
> `[S#]`를 인용하며([출처](#출처) 참고, 접근일 2026-10-07), 공식 설명을 찾지 못한 경우 본문에 그렇게 적었다.
> **제안(Proposed)** 또는 **소유자 결정(Owner decision)** 으로 표시한 항목은 저장소에 근거가 없으며 먼저 소유자의 승인이 필요하다.

[`security-gates.md`](security-gates-ko.md)의 게이트 목록을 기반으로 한다. 이 문서는 게이트 id(G15, G16, G17, G19, G24)를
다시 서술하지 않고 인용하며, 그 문서의 결론과 모순되지 않는다(G15는 업스트림 매니페스트를 SHA-256으로 검증하지만 두 개의
설치 스크립트는 검증 없이 허용 목록에 두며, 의존성에 대한 CVE 스캔은 없다). #103에 언급된 다른 이슈(#10, #100,
#37)에 대한 자매 제안은 별도 문서이며, 이 문서는 **가져오는 대상의 목록화와 검증**, 그리고 쿨링, 이그레스, 격리, 오프라인 사용을 맡는다.

이슈가 인용한 사건(침해된 메인테이너가 빌드 중 코드를 실행하는 패키지를 게시한 사례)은 이슈 본문에서 가져온 것이며 여기서
재확인하지 않았다. 위협 모델은 서술된 그대로만 사용한다: 가져온 아티팩트는 실행 가능한, 신뢰할 수 없는 입력이다.

## 1. 현재 상태 (확인됨)

아래에서 "확인됨(Verified)"은 저장소 코드가 가져온 바이트를 **이 저장소에 기록된** SHA-256과 비교하고 불일치 시 해당 단계를
실패시킨다는 뜻이다. 기록된 해시 자체를 업스트림 서명과 대조해 검토했는지는 말해 주지 않는다.

### 1.1 가져오는 대상과 검증 여부

| # | 단계 | 아티팩트 | 가져오는 주체 | 버전 선택자 | 저장소 코드로 검증? | 근거 |
|---|---|---|---|---|---|---|
| 1 | host-install | Vagrant box `dasomel/ubuntu-26.04-xfs` | `vagrant up` | box 이름만 (파일에 box 버전이나 체크섬 없음) | **아니오(No)** | [`Vagrantfile:67`](../Vagrantfile#L67) |
| 2 | host-install | apt 패키지 `dnsmasq` | `apt-get install` | 배포판 기본값 | 저장소 코드로는 아님 (OS 패키지 관리자에 의존; 검토하지 않음) | [`10-dnsmasq.sh:47-48`](../scripts/cluster/10-dnsmasq.sh#L47-L48) |
| 3 | host-install | k3s 설치 스크립트, 그리고 그것이 내려받는 k3s 바이너리 | `curl -sfL https://get.k3s.io \| sh -` (서버 및 에이전트) | 릴리스 **채널** `v${K8S_VERSION}` (`1.36`), 움직이는 마이너 라인 | **아니오(No)** (허용 목록) | [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32), [`:61`](../scripts/cluster/02-k8s-init.sh#L61), [`check-upstream-artifacts.py:29-30`](../scripts/ci/check-upstream-artifacts.py#L29-L30) |
| 4 | host-install | Helm 설치 스크립트 (`get-helm-3`, Helm `main` 브랜치), `helm`이 없을 때만 | `curl -sfL ... \| bash` | 브랜치 `main` (가변) | **아니오(No)** (허용 목록) | [`03-cni-metallb.sh:15-17`](../scripts/cluster/03-cni-metallb.sh#L15-L17), [`check-upstream-artifacts.py:31-32`](../scripts/ci/check-upstream-artifacts.py#L31-L32) |
| 5 | host-install | Helm 차트 `cilium/cilium` | `helm repo add` + `helm upgrade --install --version 1.20.0` | 정확한 차트 버전 | **아니오(No)** (버전 고정만; 차트 다이제스트 없음, `--verify` 없음) | [`03-cni-metallb.sh:20-28`](../scripts/cluster/03-cni-metallb.sh#L20-L28) |
| 6 | host-install | Helm 차트 `metallb/metallb` | 같은 패턴, `--version 0.16.1` | 정확한 차트 버전 | **아니오(No)** (버전 고정만) | [`03-cni-metallb.sh:34-39`](../scripts/cluster/03-cni-metallb.sh#L34-L39) |
| 7-17 | deploy-bootstrap | 업스트림 매니페스트 11개: Argo CD `install.yaml` v3.5.0, cert-manager v1.21.1, CloudNativePG v1.30.0, Strimzi 1.1.0, APISIX CRD 7개 v1.8.0 | `fetch_verified` (curl, `--proto =https`, 락 대비 SHA-256, 임시 파일 후 `mv`) | URL의 정확한 태그 (브랜치 형태의 URL 세그먼트는 락 로더가 거부) | **예(Yes)**, fail-closed | [`configs/upstream-artifacts.sha256:3-13`](../configs/upstream-artifacts.sha256#L3-L13), [`verified-fetch.sh:17-42`](../scripts/common/verified-fetch.sh#L17-L42), [`01-argocd-bootstrap.sh:23`](../scripts/gitops/01-argocd-bootstrap.sh#L23), [`:299`](../scripts/gitops/01-argocd-bootstrap.sh#L299), [`:306`](../scripts/gitops/01-argocd-bootstrap.sh#L306), [`:313`](../scripts/gitops/01-argocd-bootstrap.sh#L313), [`:334`](../scripts/gitops/01-argocd-bootstrap.sh#L334) |
| 18 | deploy-bootstrap | `downloads.apache.org`의 Helm 차트 `flink-kubernetes-operator` 1.15.0 | `helm repo add` + `helm upgrade --install --version 1.15.0`, 둘 다 뒤에 `\|\| true` | 정확한 차트 버전 | **아니오(No)** (버전 고정만) | [`01-argocd-bootstrap.sh:320-326`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L326) |
| 19 | gitops-sync | 이 저장소 자체, Argo CD가 동기화 | Argo CD Applications | `targetRevision: HEAD` (자기 참조, 고정 게이트에서 의도적으로 제외) | 해당 없음 (자체 저장소) | [`gitops/apps/beluga-data.yaml:9-10`](../gitops/apps/beluga-data.yaml#L9-L10), [`check-pin-enforcement.py:5-6`](../scripts/ci/check-pin-enforcement.py#L5-L6) |
| 20-38 | image-registry | 두 차트가 선언한 **고유 컨테이너 이미지 19개** (태그만, 다이제스트 없음) | kubelet pull | 태그 | **어디에도 다이제스트 없음**; 태그 불변성은 정적으로 검사(G15)하지만 태그는 업스트림에서 다른 이미지로 다시 가리킬 수 있음 | [`platform-asset-inventory.md:104`](platform-asset-inventory.md#L104), [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml) (저장소 19개), [`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40) |
| 39-42 | pod-runtime | `repo1.maven.org`의 Flink jar 4개 (Kafka SQL connector 3.4.0-1.20, iceberg-flink-runtime 1.7.1, iceberg-aws-bundle 1.7.1, flink-shaded-hadoop-2-uber 2.8.3-10.0); **두** 곳에서 다운로드 | initContainer와 SQL 제출 잡에서 `curl` + `sha256sum -c`; 스크립트는 `set -e` / `set -eu`로 실행 | URL의 정확한 버전 | **예(Yes)**, fail-closed (해시는 차트에 기록) | [`05-flink-operator.yaml:45-56`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L45-L56), [`14-flink-jobs.yaml:84`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L84), [`:98-108`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L98-L108) |
| 43 | pod-runtime | PyPI: `authlib`, `apache-airflow-providers-cncf-kubernetes`와 그 전이 의존성 (Airflow 파드) | 컨테이너 시작 시 `pip install` | **없음** (고정 안 됨, 해시 없음) | **아니오(No)** | [`07-airflow.yaml:163`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L163) |
| 44 | pod-runtime | PyPI: `authlib`, `trino[sqlalchemy]`와 전이 의존성 (Superset init 컨테이너, UID 0으로 실행) | `uv pip install --target /pylibs` | **없음** | **아니오(No)** | [`08-superset.yaml:102`](../gitops/charts/beluga-data/templates/08-superset.yaml#L102), [`:98`](../gitops/charts/beluga-data/templates/08-superset.yaml#L98) |
| 45 | pod-runtime | PyPI: `kafka-python-ng` 2.2.2 (클릭스트림 생성기) | 컨테이너 시작 시 `pip install --target /pylibs` | 정확한 버전, **해시 없음** | **아니오(No)** (버전 고정만) | [`13-clickstream-gen.yaml:48`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L48) |
| 46 | demo-build | `python:3.12-slim` 베이스 이미지와 `kafka-python-ng==2.2.2` (차트로 배포되지 않음) | `docker build` | 태그 / 정확한 버전, 해시 없음 | **아니오(No)** | [`demo/clickstream-gen/Dockerfile:2,6`](../demo/clickstream-gen/Dockerfile#L2), [`requirements.txt`](../demo/clickstream-gen/requirements.txt) |

행 번호 20-38과 39-42는 표의 행이 아니라 아티팩트 수(이미지 19개, jar 4개)이다. 이 표의 합계: **저장소 코드가 검증하는 고유
아티팩트 15개** (매니페스트 11개 + jar 4개); **저장소 코드가 검증하지 않는 것**: 설치 스크립트 2개(k3s, Helm)와 그것이 내려받는
대상, Helm 차트 3개, 차트 이미지 19개, 런타임 `pip`/`uv` 호출 3건, Vagrant box, apt 패키지.

위의 업스트림 매니페스트와 차트가 **함께 들여오는 이미지와 다운로드는 어떤 저장소 파일에도 열거되어 있지 않다**
([`external-dependencies.md`](external-dependencies-ko.md), "Known limits"). 2026-10-07에 실행 중인 클러스터를 한 번 읽기
전용으로 관찰한 결과가 그 격차의 크기를 보여 준다: 파드 스펙의 고유 이미지 참조 39개 중 3개만 `@sha256`을 가지며(모두 Cilium,
차트 자체 기본값) 36개는 태그만 있다; 파드 스펙 이미지 하나는 `ghcr.io/apache/flink-kubernetes-operator:79d730b`(업스트림
차트가 고른 커밋 형태의 태그)인 반면 `VERSIONS.md`에는 `apache/flink-kubernetes-operator:1.15.0`이 기록되어 있다(원인은
조사하지 않았다). `public.ecr.aws/docker/library/redis:8.2.3-alpine`(Argo CD)은 라이브에는 나타나고 차트 어디에도 없다.
이는 안정적인 사실이 아니라 한 번의 관찰이다.

### 1.2 CI 및 릴리스 빌드 시점 입력

| 입력 | 상태 | 근거 |
|---|---|---|
| GitHub Actions | `uses:` 40줄(고유 action 8개) 전부 40자리 16진 SHA로 고정; grep 게이트로 검사(G16) | [`supply-chain.yml:100-112`](../.github/workflows/supply-chain.yml#L100-L112) |
| Python (CI) | `pyyaml==6.0.3`에 `--hash` 값 3개; `ci.yml`에서 `pip install --require-hashes`, `release.yml`에서 두 번; 정적 검사기가 회귀를 거부 (자체 실행 시 `Dependency integrity OK: 1 pinned requirements; 4 protected installs` 출력) | [`requirements-ci.txt`](../requirements-ci.txt), [`ci.yml:57`](../.github/workflows/ci.yml#L57), [`release.yml:93`](../.github/workflows/release.yml#L93), [`:159`](../.github/workflows/release.yml#L159), [`check-dependency-integrity.py:1-9`](../scripts/ci/check-dependency-integrity.py#L1-L9) |
| Python (리서치 레인) | 고정 및 해시된 패키지 6개, 별도 락 | [`requirements-research.txt`](../requirements-research.txt), [`research-evidence.yml:36`](../.github/workflows/research-evidence.yml#L36) |
| CI의 Helm | `azure/setup-helm`으로 `v3.16.4` (버전 고정; action의 다운로드 검증은 검토하지 않음) | [`ci.yml:29-32`](../.github/workflows/ci.yml#L29-L32) |
| Trivy | `trivy-action`(SHA 고정)으로 `v0.70.0`; Trivy의 취약점/검사 데이터베이스는 실행 시점에 가져오며 이 저장소가 고정하지 않음 | [`sast.yml:108-111`](../.github/workflows/sast.yml#L108-L111), 에어갭 페이지 [S6] |
| beluga-manager seam | 고정된 커밋 SHA로 체크아웃한 뒤 `npm ci`; 락 파일은 다른 저장소의 것이라 검토하지 않음. 두 워크플로는 **서로 다른** SHA를 고정함 ([`security-gates.md`](security-gates-ko.md) 3절 참고) | [`ci.yml:67-82`](../.github/workflows/ci.yml#L67-L82), [`release.yml:96-111`](../.github/workflows/release.yml#L96-L111) |
| Node | `node-version: '22'` (떠다니는 마이너) | [`ci.yml:75-78`](../.github/workflows/ci.yml#L75-L78) |
| 러너 이미지 | `ubuntu-latest` (떠다님) | [`ci.yml:19`](../.github/workflows/ci.yml#L19) |
| 이그레스 제어 | `step-security/harden-runner`가 모든 잡에 있으며 `egress-policy: audit` (관찰만) | [`ci.yml:24`](../.github/workflows/ci.yml#L24), [`release.yml:45`](../.github/workflows/release.yml#L45), [`:146`](../.github/workflows/release.yml#L146), [`sast.yml:31`](../.github/workflows/sast.yml#L31), [`supply-chain.yml:29`](../.github/workflows/supply-chain.yml#L29) |
| 업데이트 쿨링 | Dependabot은 `github-actions`만, 주간, `cooldown.default-days: 14`; 보안 패치는 수동 처리 (G17) | [`dependabot.yml:7-17`](../.github/dependabot.yml#L7-L17) |

### 1.3 기존 검증의 동작 방식 (이미 fail-closed인 부분)

- `verified-fetch.sh`는 누락/형식 오류/중복된 락, URL이 없는 항목, 다운로드 실패, 해시 불일치를 거부하고 임시 파일을 제거하며,
  테스트 전용 변수가 설정되지 않는 한 `https`만 허용한다
  ([`verified-fetch.sh:17-42`](../scripts/common/verified-fetch.sh#L17-L42)).
- `check-upstream-artifacts.py`는 음성 `file://` 픽스처 8개와 프로토콜 기본값 테스트로 그 동작을 다시 검사하고
  ([`check-upstream-artifacts.py:90-132`](../scripts/ci/check-upstream-artifacts.py#L90-L132)), 허용 목록에 없는 한
  `scripts/**/*.sh`의 `kubectl -f URL`과 `curl | sh|bash|kubectl`을 거부하며
  ([`:25-26`](../scripts/ci/check-upstream-artifacts.py#L25-L26), [`:54-74`](../scripts/ci/check-upstream-artifacts.py#L54-L74)),
  `main|master|HEAD|latest|stable|release-*` 세그먼트가 있는 락 URL을 거부한다
  ([`:24`](../scripts/ci/check-upstream-artifacts.py#L24), [`:44-45`](../scripts/ci/check-upstream-artifacts.py#L44-L45)).
  이 커밋에서 실행하면 `upstream artifact gate OK: 11 pinned artifacts, 2 allowlisted installer scripts`를 출력한다.
- 코드에서 비롯되는 범위 한계: 스캔은 `scripts/**/*.sh`만 다룬다
  ([`:72`](../scripts/ci/check-upstream-artifacts.py#L72)); 차트 템플릿은 보지 않으므로(Flink jar 해시와 템플릿의
  `pip install` 줄은 범위 밖), `helm repo add` 차트, 컨테이너 이미지, 워크플로도 다루지 않는다.
- 차트와 이미지 고정은 별도의 래칫(G15)이다: 셸의 Helm 설치는 정확한 `--version`이 필요하고, 이미지는 `latest`가 아닌 태그가
  필요하며, 다이제스트가 없는 저장소는 `image-digest-baseline.yaml`에 있어야 하고 그 크기는 줄어들기만 할 수 있다
  ([`check-pin-enforcement.py:3-14`](../scripts/ci/check-pin-enforcement.py#L3-L14), [`:40`](../scripts/ci/check-pin-enforcement.py#L40)).
  가변 태그 하나는 이름으로 허용된다: `ghcr.io/dasomel/ldapium:nightly-4e85165`
  ([`check-image-tag-immutability.py:108`](../scripts/ci/check-image-tag-immutability.py#L108),
  [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt)); 라이브에서 그 태그는 2026-10-07에
  `ghcr.io/dasomel/ldapium@sha256:33482e83...`로 해석되었다.
- 부트스트랩을 읽다가 발견한 fail-open 지점: 검증된 CNPG와 Strimzi 다운로드 뒤의 `kubectl apply ... || true`
  ([`01-argocd-bootstrap.sh:307`](../scripts/gitops/01-argocd-bootstrap.sh#L307), [`:315`](../scripts/gitops/01-argocd-bootstrap.sh#L315)),
  그리고 Flink 오퍼레이터 repo-add/install의 `|| true`([`:320-326`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L326)).
  다운로드는 검증되지만, 검증된 매니페스트의 apply가 실패해도 스크립트는 멈추지 않는다.

## 2. #103의 인수 기준 대비 격차

| 인수 기준 | 상태 | 이유 (1절의 행) |
|---|---|---|
| 모든 릴리스 입력이 불변이며 감사 가능하다 | **부분(Partial)** | 불변이며 기록됨: 매니페스트 11개, jar 4개, CI PyYAML, SHA 고정 actions. 불변이 아님: k3s 채널, Helm `main` 설치 스크립트, Helm 차트 3개(버전만), 이미지 19개(태그만), 런타임 pip/uv 설치 3건, Vagrant box, 러너 이미지, Node 마이너 |
| 의존성 무결성 불일치가 CI를 실패시킨다 | **부분(Partial)** | 매니페스트 불일치는 픽스처로 오프라인 테스트됨(G15). Flink jar 해시 불일치는 CI가 아니라 파드 시작 시 강제됨. jar, 차트, 이미지를 바꿔치기하는 CI 테스트는 없음 |
| 악성 패키지나 빌드 스크립트가 제한 없는 CI 이그레스를 쓸 수 없다 | **미충족(Not met)** | 모든 곳이 `egress-policy: audit`; 차단하는 것이 없음 |
| 빌드 시점 의존성 목록이 릴리스 SBOM에 포함된다 | **미충족(Not met)** | 릴리스 SBOM에는 `VERSIONS.md` 행과 렌더링된 이미지만 있음([`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10)); jar, pip 패키지, 설치 스크립트, CI 도구는 없음. #100 제안이 맡으며, 여기의 목록은 그 입력이다 |
| 출처(provenance)가 소스 -> 의존성 집합 -> 빌더 -> 아티팩트 다이제스트를 잇는다 | **미충족(Not met)** | 증명(attestation) 대상은 증거 파일의 `SHA256SUMS`([`release.yml:167-170`](../.github/workflows/release.yml#L167-L170)); 의존성 집합도, 배포된 이미지 다이제스트도 없음. #100 및 #10 제안 참고 |
| 침해된 패키지의 롤백이 재현 가능하다 | **미충족(Not met)** | 롤백은 `git revert`와 Argo CD 동기화([`RELEASING.md:39-44`](../RELEASING.md#L39-L44)); 격리 목록도, yank된 버전 절차도 없고, 태그/pip는 재현 불가 |
| 오프라인 / 에어갭 프로파일이 승인된 번들만 사용한다 | **미충족(Not met)** | 그런 프로파일이 없음; 1절의 모든 단계가 네트워크에 접근함. 증거 번들 검증은 오프라인이지만 아티팩트 확보는 아님 |
| 음성 테스트: 의존성 바꿔치기, yank된 버전, 예기치 않은 이그레스 | **부분(Partial)** | 바꿔치기는 매니페스트 헬퍼에 대해서만(픽스처 8개); yank된 버전과 이그레스는 없음 |

단일 기준에 묶이지 않는 이슈의 요구사항: "`latest` 제거/표시"는 차트에 대해 충족(Met)됨(G16, G15); "의존성 쿨링"은 Actions에만
존재함(G17); "#10, #31, #37, #100과 통합"은 여기서 게이트 id를 인용하고 소유권을 나누는 것으로 수행했다.

## 3. 제안 (모두 제안(Proposed); 소유자 승인 필요)

### 3.1 하나의 아티팩트 락, 하나의 확보 경로

- **제안(Proposed):** `configs/upstream-artifacts.sha256`을 파일로 가져오는 모든 것의 단일 락으로 취급하고, 필요할 때만 스키마를
  확장한다(예: 줄마다 이름/목적 주석). 추가 대상: Flink jar 4개(현재 해시는 두 차트 템플릿에 있어 두 곳 모두 수정해야 함),
  Cilium, MetalLB, Flink 오퍼레이터의 Helm 차트 아카이브(`.tgz`의 해시; `helm pull --version` 후 `helm install ./file.tgz`),
  그리고 `get.k3s.io` 대신 **태그된 커밋 URL**의 k3s 설치 스크립트.
- **제안(Proposed):** 허용 목록에 있는 `curl | sh` 두 줄을 불변 URL의 설치 스크립트에 대한 `fetch_verified`와 정확한 버전
  선택자로 교체한다. k3s 설치 스크립트의 정확한 버전 변수 이름과, 설치 스크립트가 내려받는 바이너리를 검증하는지는 구현 시점에
  k3s 문서로 확인해야 한다: 이 문서를 위해 읽은 에어갭 페이지는 바이너리, 이미지 tarball, 설치 스크립트를 나열하며
  **체크섬은 언급하지 않는다** [S5]. Helm: `main`의 `get-helm-3` 대신 정확한 버전의 릴리스 tarball을 내려받아 해시를 검증한다.
- **제안(Proposed):** 부트스트랩에 `|| true` 감사를 추가한다: 검증된 아티팩트 뒤의 각 `|| true`에는 서면 사유가 필요하며,
  없으면 제거한다.
- 업스트림 서명: Helm은 출처 증명(`.prov`, `helm verify`, GnuPG 서명, 차트 옆에서 제공)을 문서화하고 [S4], Maven Central은
  파일마다 `.asc` 서명을 요구하며 [S7], Argo CD는 릴리스 자산에 대한 cosign 키리스 서명과 SLSA 출처 증명을 문서화한다 [S8].
  Strimzi는 읽은 문서 페이지(1.2.0)에 아티팩트 서명, SBOM, cosign에 대한 설명이 **전혀 없다** [S9]. 제안 규칙: 검토 후 해시를
  기록하고, 업스트림이 서명을 게시하는 경우 버전을 올릴 때(락을 갱신하는 사람이) 한 번 검증하여 PR에 남긴다; CI가 매 실행마다
  서명을 검증할지는 **소유자 결정(Owner decision)** 이다(키/투명성 서비스에 대한 네트워크 접근이 필요).

### 3.2 컨테이너 이미지 (요약; 상세는 #10 제안)

차트 이미지 19개와 업스트림 매니페스트 이미지의 다이제스트 고정은 #10 문서(이미지 출처, SBOM, 취약점 정책)에서 설계한다. 여기서
가져가는 요구사항: 두 번의 렌더링 사이에 다이제스트가 바뀐 태그는 검사를 실패시켜야 하며, 래칫 `BASELINE_CEILING = 19`
([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40))가 0으로 줄이기 위한 기존 수단이다. Kubernetes는
다이제스트가 불변이고 태그는 옮길 수 있다고 문서화한다 [S1].

### 3.3 런타임 패키지 설치

파드 세 개가 시작 시 고정되지 않았거나 해시가 없는 패키지를 설치한다. pip의 해시 검사 모드는 고정된 요구사항을 요구하므로 [S2],
해시 검사 설치에는 모든 요구사항을 `==`로 고정하고 전체 클로저를 나열해야 한다. 선택지:

| 선택지 | 막는 것 | 비용 |
|---|---|---|
| A. 파드별 해시 요구사항 파일(ConfigMap)을 제공하고 `pip install --require-hashes` 실행 | PyPI에서의 바꿔치기; 고정되지 않은 전이 의존성 업그레이드 | 버전을 올릴 때마다 클로저를 재생성해야 함; 설치 후 Superset이 코어 패키지를 `rm -rf`하는 동작(SQLAlchemy 충돌)을 다시 테스트해야 함 |
| B. 패키지를 미리 넣은 파생 이미지를 빌드 | PyPI로의 런타임 이그레스 | 컴포넌트를 빌드하지 않는다는 README 서술과 모순; 레지스트리 필요(#10) |
| C. 승인된 번들에 패키지를 미러링 (오프라인 프로파일) | 런타임 이그레스 | 3.6절의 번들 프로세스 필요 |

**소유자 결정(Owner decision):** A를 먼저(가장 작은 변경), B/C는 오프라인 프로파일과 함께만. 권고: A.

### 3.4 새로 게시된 버전의 쿨링과 검토

- 기존 선례: Actions에 대한 14일 Dependabot 쿨다운([`dependabot.yml:16-17`](../.github/dependabot.yml#L16-L17)).
  GitHub는 docker, helm, maven, pip 등에 대한 `cooldown`을 문서화하며, 이는 **버전** 업데이트에만 적용되고 보안 업데이트는
  이를 우회하며, docker/helm에서는 semver별 쿨다운이 지원되지 않는다 [S3].
- **제안(Proposed):** 쿨링 규칙을 Actions에서 버전을 담는 다른 표면으로 정책으로 확장한다: 업스트림 게시 후 N일 이내에는
  `VERSIONS.md`, Helm 차트 버전, 락 항목, Flink jar 버전을 올리지 않는다. 단, 사유를 기록한 보안 수정은 예외이다. N은
  **소유자 결정(Owner decision)** 이다(공식 권고 없음; 이 저장소의 유일한 수치는 14일). Dependabot이 저장소 차트의
  `values.yaml`/`VERSIONS.md` 이미지 참조를 읽을 수 있는지는 테스트해야 하며, 이 문서는 가능하다고 주장하지 않는다.

### 3.5 CI의 이그레스 제한

harden-runner는 자동 생성되는 베이스라인을 제공하며 이를 도메인 허용 목록으로 바꿔 그 밖의 아웃바운드 트래픽을 차단할 수 있다
[S10]; 이 저장소는 관찰 모드로만 실행한다.

- **제안(Proposed):** 1단계, `audit`를 유지하고 각 잡의 엔드포인트 집합을 수집한다(잡별 harden-runner insights를 읽음); 2단계,
  `release.yml` 잡과 `ci.yml`의 `validate`를 먼저 그 목록으로 차단 정책으로 전환한다(예상 구성원: GitHub 호스트, PyPI 호스트,
  Helm/Trivy 다운로드 호스트; 실제 목록은 1단계에서 나옴); 3단계, 나머지 워크플로.
- 릴리스 잡은 재실행이 일어나도 계속 동작해야 한다([`RELEASING.md:28-34`](../RELEASING.md#L28-L34)); 차단된 엔드포인트로
  인한 실패가 게이트 실패처럼 보여서는 안 된다. **소유자 결정(Owner decision):** `release.yml`에만 차단 모드를 적용할지, 모든
  워크플로에 적용할지. 권고: 릴리스와 validate 먼저.
- 런타임 파드: G7은 대상 네임스페이스마다 기본 거부(default-deny) 이그레스를 요구한다; 3.3의 파드는 현재도 PyPI가 필요하다.
  그 이그레스 규칙이 존재하는지, 무엇을 허용하는지는 **이 문서에서 확인하지 않았으며** 구현 작업에 속한다.

### 3.6 격리, 롤백, 오프라인 번들

- **제안(Proposed) 격리 목록:** 버전 관리되는 파일(예: `policies/quarantine.yaml`; 설계만)에 아티팩트 id, 버전 또는 다이제스트,
  사유, 출처(권고 또는 yank 공지), 날짜, 이슈를 담는다. 어떤 항목이든 저장소의 이미지 참조, 락 항목, 차트 버전, 고정된 패키지와
  일치하면 검사기가 실패한다. 이로써 "yank되었거나 침해된 버전"에 테스트 가능한 음성 사례가 생긴다.
- **제안(Proposed) 롤백 절차** (문서화 작업): (1) 격리 목록에 항목 추가; (2) 버전 상향 커밋을 되돌림(기존 경로,
  [`RELEASING.md:39-44`](../RELEASING.md#L39-L44)); (3) 다시 렌더링하고, 다시 락하고, `make validate`를 다시 실행;
  (4) 영향받은 릴리스가 있으면 릴리스 노트에 기록; (5) 침해된 아티팩트가 읽었을 수 있는 자격 증명을 폐기하거나 교체(클러스터
  또는 러너 안에서 실행되었음). 재현성은 고정한 만큼만 확보된다: 런타임 pip 설치(3.3)와 태그만 있는 이미지를 먼저 막아야 하며,
  그렇지 않으면 롤백 대상을 동일하게 다시 빌드할 수 없다.
- **제안(Proposed) 오프라인 번들:** "승인된 아티팩트 집합" 디렉터리 = 락 파일과 그것이 나열한 아티팩트(매니페스트, 차트
  아카이브, jar, 설치 스크립트, 다이제스트로 내보낸 이미지, Python wheel). 검증 명령이 네트워크 없이 모든 파일을 락과 대조하며,
  기존 오프라인 증거 검증([`evidence_bundle.py:114-207`](../scripts/release/evidence_bundle.py#L114-L207))의 방식을 따른다.
  K3s는 에어갭 경로(이미지 tarball, 바이너리, 설치 스크립트, `INSTALL_K3S_SKIP_DOWNLOAD`)를 문서화하고 [S5], Trivy는 미리
  내려받은 데이터베이스로 실행하는 방법을 문서화한다 [S6]. 이 번들과 릴리스 증거 번들의 관계는 **추가적(additive)** 이다:
  증거는 무엇이 릴리스되었는지를 말하고, 아티팩트 번들은 오프라인 설치가 소비하는 것이다. 첫 단계의 범위: 매니페스트, 차트,
  jar, 설치 스크립트만; 이미지는 #10 제안이 다룬다.

## 4. 검증 및 테스트 아이디어

| 테스트 | 기대 결과 | 종류 |
|---|---|---|
| 픽스처에서 고정된 매니페스트, 차트 `.tgz`, jar를 이름이 같은 다른 파일로 교체 | 각 확보 경로가 0이 아닌 코드로 종료하고 파일을 남기지 않음 | 오프라인 픽스처 (기존 8개 사례를 확장) |
| jar 해시를 수정한 채로 차트 렌더링 | 파드 시작 전에 CI 검사가 실패 | 템플릿에 대한 새 정적 검사 |
| `scripts/` 아래 어디든 `curl | sh` 줄을 추가하거나 템플릿에 고정되지 않은 `pip install`을 추가 | CI 실패; 3.1 이후 허용 목록은 항목 0개 | 기존 검사, 범위 확장 |
| 렌더링된 이미지나 락 URL과 일치하는 격리 항목 | 항목을 지명하며 CI 실패 | 새 검사, 양성 및 음성 픽스처 |
| 차단 이그레스에서 목록에 없는 호스트에 접속하는 잡 | 잡이 실패하고 차단된 엔드포인트가 보고됨 | 임시 브랜치에서의 러너 테스트 |
| 한 바이트 변경, 파일 하나 누락, 파일 하나 추가한 오프라인 번들 검증 | 각각 실패 | 오프라인 픽스처 |
| 다이제스트 드리프트: 두 번의 렌더링 사이에 같은 태그, 다른 다이제스트 | 실패 (#10 다이제스트 락 필요) | 문서 간 |

## 5. 남은 소유자 결정 사항

| # | 결정 | 권고 |
|---|---|---|
| D1 | 태그된 설치 스크립트와 정확한 버전 선택자의 `fetch_verified`로 설치 스크립트 허용 목록 항목 2개를 제거 | 예(Yes), 첫 구현 작업 |
| D2 | 업스트림 아티팩트 서명 검증: 버전 상향 시에만, 또는 CI에서 매 실행마다 | 버전 상향 시(수동), CI는 나중에 |
| D3 | 런타임 pip: 3.3의 선택지 A, B, C | 지금은 A; B/C는 오프라인 프로파일과 함께 |
| D4 | Actions 외 버전 상향의 쿨링 기간 N | 공식 수치 없음; 기존 14일에서 시작 |
| D5 | 이그레스 차단 범위 (릴리스만, 또는 모든 워크플로) | 릴리스와 validate 먼저 |
| D6 | 검증된 apply 뒤의 `|| true`를 CNPG/Strimzi/Flink 오퍼레이터에 유지할지 | 서면 사유가 없으면 제거 |
| D7 | 오프라인 설치 프로파일을 지금 범위에 넣을지, 번들은 누가 유지할지 | #10 및 환경 프로파일 소유자와 함께 결정; D3 이전에는 시작하지 않음 |
| D8 | CI의 beluga-manager SHA를 `ci.yml`과 `release.yml`에서 하나의 값으로 고정 | 예(Yes) (`security-gates.md`에서 이미 열린 결정) |

## 6. 후속 구현 작업 (순서대로, 작게)

1. Flink jar 해시를 락 파일로 옮기고 두 차트 위치가 하나의 소스에서 읽도록 한다. *인수 기준:* 락의 해시를 수정하면 렌더링된
   두 스크립트가 모두 바뀐다; 락에 없는 jar 항목이 있으면 `make validate`가 실패한다.
2. `check-upstream-artifacts.py`를 확장하여 차트 템플릿에서 검증 단계가 없는 `curl` 다운로드와 고정되지 않은 `pip install`을
   스캔한다. *인수 기준:* 현재의 설치 3건은 고쳐질 때까지 검사를 실패시킨다; 픽스처가 통과와 실패를 모두 다룬다.
3. Helm 설치 스크립트를 해시 검증된 tarball로, k3s 설치 스크립트를 태그되고 검증된 스크립트로 교체하고,
   `UNVERIFIED_ALLOWLIST`를 비운다. *인수 기준:* `check-upstream-artifacts.py`가 `0 allowlisted installer scripts`를 보고한다.
4. Helm 차트 3개를 아카이브로 받아 해시를 검증한다. *인수 기준:* 아카이브를 바꿔치기한 픽스처가 실패한다.
5. Airflow, Superset, 클릭스트림 생성기용 해시 요구사항 파일 (D3 = A). *인수 기준:* 깨끗한 컨테이너에서 `pip install
   --require-hashes`가 성공한다; 해시를 제거하면 실패한다.
6. `policies/quarantine.yaml`과 검사기, 음성 픽스처 (3.6절).
7. `RELEASING.md`의 롤백 런북 절 (이중 언어).
8. harden-runner: 베이스라인을 수집한 뒤 `release.yml`에 차단 정책 적용 (D5). *인수 기준:* 목록에 없는 호스트에 curl하는 잡이
   임시 브랜치에서 실패한다.
9. 쿨링 정책 문구와, 테스트 PR이 동작함을 증명하는 Dependabot 에코시스템 추가 (D4).
10. 오프라인 아티팩트 번들 빌더와 검증기 (D7).

## 출처

모두 접근일 2026-10-07.

| ID | 출처 |
|---|---|
| S1 | Kubernetes, Images (다이제스트는 불변, 태그는 옮길 수 있음): https://kubernetes.io/docs/concepts/containers/images/ |
| S2 | pip, Secure installs (해시 검사 모드, 요구사항은 고정되어야 함): https://pip.pypa.io/en/stable/topics/secure-installs/ |
| S3 | GitHub, Dependabot options reference (`cooldown`): https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference |
| S4 | Helm, Provenance and Integrity: https://helm.sh/docs/topics/provenance/ |
| S5 | K3s, Air-Gap Install: https://docs.k3s.io/installation/airgap |
| S6 | Trivy, Air-gapped environment: https://trivy.dev/latest/docs/advanced/air-gap/ |
| S7 | Sonatype, Maven Central publishing requirements: https://central.sonatype.org/publish/requirements/ |
| S8 | Argo CD, Verification of Argo CD signatures / signed release assets: https://argo-cd.readthedocs.io/en/stable/operator-manual/signed-release-assets/ |
| S9 | Strimzi, Deploying and managing (1.2.0 페이지 검색; 서명/SBOM/cosign 관련 설명 없음): https://strimzi.io/docs/operators/latest/deploying.html |
| S10 | step-security/harden-runner README (차단 이그레스를 위한 베이스라인 기반 도메인 허용 목록; audit/block 정의는 https://docs.stepsecurity.io/harden-runner에 있으며 읽지 않음): https://github.com/step-security/harden-runner |
