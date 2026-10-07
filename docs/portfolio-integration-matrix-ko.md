# 포트폴리오 통합 매트릭스 (Portfolio Integration Matrix)

[English](portfolio-integration-matrix.md) | 한국어

[이슈 #99](https://github.com/dasomel/beluga/issues/99)의 첫 번째 문서 전용 슬라이스.
Beluga의 모든 역량을 소유 프로젝트에 매핑하고, 중복 구현 후보와 후보별 단일 원천(SoT)을
지정하며, 5개 프로젝트(Narwhal, KubeMetal, kube-ready-box, ldapium, nfs-quota-agent)와의
경계를 표로 정리한다.

[cross-oss-integration-contracts-ko.md](cross-oss-integration-contracts-ko.md)(각 경계의 Beluga 측
관점)를 확장하며 대체하지 않는다. 이 매트릭스의 근거 결정은
[ADR-0003](adr/0003-beluga-data-platform-plane-ko.md)(Accepted)이다.

## 출처와 규칙

- 소유권 단일 원천: OpenForge `portfolio/capability-ownership.json`
  (`openforge-capability-ownership/v1`, 2026-09-10 갱신)와 `docs/portfolio-capability-ownership.md`.
  아래 역량 id는 이 파일에서 인용했다.
- 레지스트리 규칙: 다른 프로젝트가 소유한 역량이 필요하면 재구현하지 않고
  통합/어댑터/소비자 계약 이슈를 만든다.
- 역량 분류: 이슈 #97. AI는 선택 사항(#90)이므로 어떤 행도 코어 데이터 플랫폼 경로가
  KubeMetal이나 모델 런타임에 의존하게 만들 수 없다.
- 유지되는 Seam: Beluga / beluga-manager의 OIDC, OPA, Keycloak 경계(`AGENTS.md`,
  `bash tests/14-policy-compiler-seam.sh`)는 이 슬라이스에서 변경하지 않는다.
- 근거 표기는 `path`(이 저장소) 또는 `repo:path`(형제 저장소, 읽기 전용 참조, 2026-10-02 확인).
  Narwhal 저장소는 로컬에 없어 `dasomel/narwhal` `main`을 `gh api`로 읽었다.

**상태 의미 (이슈 #99).** `supported` = 양측에 계약 표면이 있고 Beluga가 사용 중.
`partial` = 사용 중이나 불완전하거나 우회책 기반이거나 단방향. `unavailable` = 쓸 수 있는
표면이 아직 없음(*proposed*로 표시된 표면은 형제 프로젝트와 협의되지 않은 Beluga 측
기대이며, 이름은 API 약속이 아니다). `not-applicable` = 현재 Beluga 프로파일 범위 밖.

## 1. 역량 소유권 매트릭스

Beluga 열 = 이 저장소가 오늘 실제로 배포하거나 문서화한 것.

| # | Beluga 역량 | Beluga 근거 | 소유자 (레지스트리 id 또는 upstream) | Beluga 역할 | 상태 |
|---|---|---|---|---|---|
| 1 | CDC 수집, Kafka, 스트리밍 (Strimzi, Debezium, Flink) | `VERSIONS.md`, `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`, `14-flink-jobs.yaml` | beluga (`data-platform-lakehouse`), upstream Apache 프로젝트 기반 | 통합과 의미 소유 | `supported` |
| 2 | 레이크하우스 스토리지·카탈로그 (SeaweedFS S3, Lakekeeper Iceberg REST) | `01-seaweedfs.yaml`, `04-lakekeeper.yaml` | beluga (`data-platform-lakehouse`) | 소유 | `supported` |
| 3 | 쿼리·분석 (Trino, Superset), 오케스트레이션 (Airflow) | `06-trino.yaml`, `08-superset.yaml`, `07-airflow.yaml` | beluga (`data-platform-lakehouse`) | 소유 | `supported` |
| 4 | 거버넌스 카탈로그 (OpenMetadata, 48GB+ 프로파일) | `11-openmetadata.yaml`, 설계 D12 | beluga (`data-platform-lakehouse`) | 소유 | `partial` (조건부 프로파일) |
| 5 | 데이터 접근 정책 (OPA, OpenFGA)과 policy-compiler Seam | `policies/`, `tests/14-policy-compiler-seam.sh` | beluga + beluga-manager (컨트롤 서피스) | 소유 | `supported` |
| 6 | 메달리온 계층, 데이터 품질, 데이터 프로덕트, 시맨틱 레이어 (#70, #85, #86, #92) | 백로그뿐 (#97) | beluga (`data-platform-lakehouse`) | 소유 | `unavailable` |
| 7 | 관리 컨트롤 서피스 | `.openforge/status.json` (`beluga-manager` provides) | beluga-manager (`data-platform-lakehouse`의 `control_surfaces`) | 서피스가 사용 | `supported` |
| 8 | 클러스터 라이프사이클: k3s, Cilium, MetalLB, ArgoCD 부트스트랩 | `scripts/cluster/`, `scripts/gitops/01-argocd-bootstrap.sh`, `scripts/up.sh` | narwhal (`kubernetes-platform-control-plane`) | 독립 자체 부트스트랩, 아래 D1 | `not-applicable` (peer, ADR-0003 Q1) |
| 9 | ID 공급자·SSO (Keycloak) | `gitops/charts/beluga-platform/templates/keycloak.yaml`, 설계 D13 | narwhal (플랫폼 보안 범위) / upstream Keycloak | 데이터 플랫폼 realm용 자체 호스팅, 아래 D2 | `partial` |
| 10 | API 게이트웨이 (APISIX + etcd) | `apisix-gateway.yaml`, 설계 D11 | narwhal (플랫폼 범위) / upstream APISIX | 자체 호스팅, 아래 D3 | `partial` |
| 11 | 인증서 (cert-manager, 내부 CA) | `internal-ca-distribution.yaml`, `openldap.yaml` | narwhal (플랫폼 보안 범위) / upstream cert-manager | upstream 직접 사용 | `partial` |
| 12 | 메트릭·로그·트레이스 | `VERSIONS.md`에 Prometheus Stack 기재, `platform-services.yaml`에 `grafana-external` Service 껍데기만 존재, `docs/platform-asset-inventory.md`에 Prometheus/Loki/Tempo 워크로드 없음 | narwhal (관측성 범위) | 배포된 것 없음 | `unavailable` |
| 13 | PostgreSQL (CNPG)과 오브젝트 스토리지 백업 | `02-cnpg.yaml`, `scripts/ci/check-postgres-backup-config.py` | upstream CloudNativePG; 백업 설정은 beluga 소유 | 데이터 플랫폼 백업 소유 | `supported` |
| 14 | 노드 OS 이미지·준비 상태 | `Vagrantfile`, `configs/cluster.env`, `scripts/up.sh` | kube-ready-box (`node-runtime-foundation`) | 소비자 | `partial` |
| 15 | LDAP 디렉터리 데이터 플레인 | `openldap.yaml`, `VERSIONS.md` | ldapium (`directory-identity-data-plane`) | 소비자 | `partial` |
| 16 | 로컬/엣지 AI 런타임 | 없음 (저장소에 AI 없음) | kubemetal (`local-edge-ai-runtime`) | 선택적 소비자 (#90) | `unavailable` |
| 17 | 파일시스템/NFS 쿼터 집행 | 없음 (NFS·RWX 클래스 없음) | nfs-quota-agent (`filesystem-quota-enforcement`) | 잠재적 소비자 | `not-applicable` |
| 18 | 엔지니어링 표준, 포트폴리오 상태, 증거 | `.openforge/status.json`, `.github/workflows/openforge-status.yml` | openforge (`portfolio-engineering-governance`) | 소비자 | `supported` |

8행 주의: 레지스트리는 `beluga`를 `kubernetes-platform-control-plane`의 소비자로 나열하지만,
Beluga는 Narwhal을 `peer` / `not-applicable`로 기록한다(설계 D11/D13,
`.openforge/status.json`). ADR-0003 Q1 결정: Beluga는 `peer`이며 레지스트리의 소비자
항목 정정은 OpenForge의 후속 작업으로 남아 있다.

## 2. 중복 구현 후보

후보마다 단일 원천(SoT) 하나를 지정한다. "Beluga 유지"는 이 저장소에 남는 것과 이유이며,
모든 예외에는 종료(sunset) 조건이 있다.

| ID | 후보 | 중복 위치 | 지정 SoT | Beluga 유지 | 종료 조건 / 탈출구 |
|---|---|---|---|---|---|
| D1 | 클러스터 부트스트랩·GitOps 라이프사이클 | `scripts/cluster/*.sh`, `scripts/gitops/01-argocd-bootstrap.sh` 대 Narwhal 클러스터 라이프사이클 (`narwhal:README.md`: ArgoCD + Gitea app-of-apps, Cilium, MetalLB) | 일반 역량은 narwhal; Beluga 스크립트는 문서화된 독립 프로파일 예외 | 독립 Vagrant + k3s 부트스트랩 (ADR-0001) | Narwhal 호스팅 Beluga 프로파일이 승인되면 재검토 (ADR-0003 Q2) |
| D2 | ID 공급자 (Keycloak) | `keycloak.yaml` 대 Narwhal Keycloak과 그룹 계약 (`narwhal:docs/common/oidc-rbac-contract.md`: `cluster-admin`, `developer`, `viewer`, `guest`) | 데이터 플랫폼 realm과 Beluga 롤 이름(LDAP 그룹명, `AGENTS.md` Seam)은 beluga Keycloak이 SoT; Kubernetes API / ArgoCD / Portal 인가는 Narwhal 계약이 SoT | 데이터 플랫폼 realm, 롤 매퍼 | ADR-0003 Q2 결정 후에만 realm 공유 |
| D3 | API 게이트웨이 | `apisix-gateway.yaml` 대 Narwhal APISIX OIDC 게이트웨이 | `*.local.beluga.internal` 라우트는 beluga; 자체 도메인은 narwhal | 도메인 레지스트리의 라우트 집합 (`AGENTS.md`) | 계획 없음 |
| D4 | 노드 준비 | `scripts/cluster/01-node-prep.sh` (swap, `overlay`/`br_netfilter`, sysctl) 대 `kube-ready-box:docs/node-readiness-attestation.md` (cgroup v2, swap, 모듈, sysctl, containerd) | kube-ready-box | 스크립트는 멱등 안전망으로 유지 | `kube-ready-readiness/v1` 증거를 기본 소비하게 되면 중복 검사 제거 |
| D5 | LDAP 워크로드 패키징 | `openldap.yaml`의 Beluga 렌더 Deployment/Service/PVC/Job 대 `ldapium:charts/ldapium` (TLS, 백업 CronJob, 복제) | 디렉터리 라이프사이클(TLS, ACL, 복제, 백업/복구)은 ldapium; Keycloak 페더레이션 설정은 Beluga | 시드 LDIF, `openldap-init` Job, `postStart` TLS 우회 (`openldap.yaml:192-241`) | ldapium이 부트스트랩된 볼륨의 TLS를 수렴시키면 `postStart` 우회 제거; 차트 채택 대 템플릿 유지는 ADR-0003 Q4 |
| D6 | Keycloak LDAP 페더레이션 튜닝 | `keycloak-ldap-federation.yaml` 대 `ldapium:docs/changes/keycloak-federation/CHANGE.md` (`LDAP_LIMITS_DNS`, `LDAP_REFINT_NOTHING`, ppolicy 발견 H3) | 디렉터리 측 설정과 증거는 ldapium; Keycloak 측 Job은 beluga | 페더레이션 Job | Beluga의 Keycloak 26.7.1로 재검증 (ldapium 증거는 26.0.7) |
| D7 | 백업 | Beluga CNPG barman -> SeaweedFS 대 Narwhal "Velero + CNPG barman" (`narwhal:README.md`) | 데이터 플랫폼 데이터(PostgreSQL, Iceberg 데이터)는 beluga; 클러스터 수준 백업은 narwhal | `02-cnpg.yaml` 백업 설정 | 계획 없음; Beluga에 Velero 없음 |
| D8 | 관측성 스택 | `VERSIONS.md`의 Prometheus Stack 항목 대 Narwhal Prometheus/Loki/Tempo (`narwhal:docs/common/unified-observability-contract.md`, 일부 PROPOSED) | narwhal | 배포된 것 없음; VERSIONS.md 항목은 드리프트 후보 | 후속 작업에서 해소 (ADR-0003 Q5) |
| D9 | 용량/쿼터 증거 | 구현 없음; `nfs-quota-agent`는 메트릭과 PV 어노테이션 제공 | 집행과 쿼터 증거는 nfs-quota-agent | 소비자 스키마만 (3.5절 참조) | 해당 없음 |
| D10 | 로컬 AI 런타임 | 구현 없음 | kubemetal | 없음; 선택적 어댑터만 (#90) | 해당 없음 |
| D11 | 관리 UI | beluga-manager 대 Narwhal Portal | 각자 자기 플랫폼만 관리 (레지스트리: 컨트롤 서피스는 역량이 아닌 표현을 소유) | beluga-manager | 없음 |

## 3. 프로젝트 쌍별 통합 경계

열: 계약 표면, 방향(화살표 = 누가 누구에 의존), 상태, Beluga 측 근거와 형제 측 근거.
*proposed*로 표시된 표면은 형제 저장소에서 근거가 확인되지 않았다.

### 3.1 Narwhal (레지스트리: `kubernetes-platform-control-plane`, 소비자에 beluga 포함)

| 계약 표면 | 방향 | 상태 | Beluga 근거 | Narwhal 근거 |
|---|---|---|---|---|
| Beluga의 기반으로서의 클러스터 라이프사이클/GitOps | Beluga -> Narwhal | `not-applicable` | 설계서 17, 29행; `.openforge/status.json` (`peer`) | `narwhal:README.md` (클러스터 라이프사이클, GitOps) |
| OIDC `groups` 클레임 -> Kubernetes RBAC / ArgoCD / Portal | Narwhal -> Beluga (잠재) | `not-applicable` | `AGENTS.md` (롤 = LDAP 그룹명, 자체 Keycloak) | `narwhal:docs/common/oidc-rbac-contract.md` |
| 통합 관측성 신호 (메트릭, 로그, 트레이스) | Beluga -> Narwhal (proposed) | `unavailable` | 없음 | `narwhal:docs/common/unified-observability-contract.md` (현재 구현과 PROPOSED 구분) |
| 버전 관리 관리 API / 이벤트 envelope | Beluga -> Narwhal (proposed) | `unavailable` | 없음 | `narwhal:docs/common/versioned-management-api-contract.md` (정적 계약 기준선, 라이브 API 아님), `narwhal:schemas/event-envelope-1.0.schema.json` |
| AI/LLMOps 확장 경계 | 해당 없음 | `not-applicable` | `docs/cross-oss-integration-contracts-ko.md` 4절 (#90) | `narwhal:docs/common/ai-llmops-extension-contract.md` (초안, KubeMetal은 명시적으로 범위 밖) |
| 네트워크 공존 (192.168.77.x 대 192.168.56.x) | 양방향 | `supported` | 설계 D1 (`docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md:38`) | `narwhal:README.md` (Vagrant, ARM64) |
| Kubernetes 버전 정렬 | 없음 | `not-applicable` | `VERSIONS.md:14` (k3s v1.36.x) | `narwhal:README.md` (v1.35, kubeadm HA) |
| 역방향 규칙: Iceberg/Trino/Flink와 데이터 프로덕트 의미는 Narwhal로 이동하지 않음 | Narwhal은 소유하지 않음 | `supported` | `.openforge/status.json`; 레지스트리 `data-platform-lakehouse` (소유자 beluga, `consumers: []`) | `openforge:portfolio/capability-ownership.json` |

### 3.2 KubeMetal (레지스트리: `local-edge-ai-runtime`, 소비자에 beluga 포함)

| 계약 표면 | 방향 | 상태 | Beluga 근거 | KubeMetal 근거 |
|---|---|---|---|---|
| OpenAI 호환 추론 엔드포인트 (`/v1`, `/v1/models`) | Beluga -> KubeMetal | `unavailable` | 이 저장소에 AI 소비자 없음; 백로그 #73, #79, #80 | `kubemetal:docs/11-local-inference-runtime.md` (OpenAI base URL, `GET /v1/models`) |
| 런타임 헬스 프로브와 비-AI 폴백 | Beluga -> KubeMetal | `unavailable` | 없음 (폴백 경로 미정의) | `kubemetal:docs/11-local-inference-runtime.md` (`/health`, `/v1/models` 프로브) |
| Vagrant 클러스터에서 macOS 호스트 런타임으로의 도달성 | Beluga -> KubeMetal | `unavailable` | 없음 | `kubemetal:docs/11-local-inference-runtime.md` (K3s 클라이언트용 opt-in `mac-gpu-service` 브리지) |
| 호출별 출처(provenance: model, version, runtime, run id) | KubeMetal -> Beluga (proposed) | `unavailable` | `docs/cross-oss-integration-contracts-ko.md` 4절 (스케치만) | `kubemetal:evidence/local-inference/*/manifest.json` 존재; 스키마 미검증 |
| AI 대 비-AI 자원/비용 텔레메트리 | KubeMetal -> Beluga (proposed) | `unavailable` | 없음 | 확인된 것 없음 |
| AI 선택 규칙: KubeMetal 없이 코어 경로 동작 | Beluga | `supported` | 저장소 어디에도 AI 의존 없음 (`docs/cross-oss-integration-contracts-ko.md` 4절) | 해당 없음 |
| 컴퓨트 백엔드 계약 (`ComputeBackend`) | 해당 없음 | `not-applicable` | 없음 | `kubemetal:README.md` (host-mlx 기본, 나머지 실험적) |

### 3.3 kube-ready-box (레지스트리: `node-runtime-foundation`, 소비자 narwhal, beluga)

| 계약 표면 | 방향 | 상태 | Beluga 근거 | kube-ready-box 근거 |
|---|---|---|---|---|
| Vagrant 박스 `dasomel/ubuntu-26.04-xfs` | Beluga -> 박스 | `supported` | `Vagrantfile:51`, `configs/cluster.env:22`, `VERSIONS.md:15` | `kube-ready-box:README.md` (Vagrant Cloud 26.04 xfs 박스) |
| 라이선스/NOTICE 소유를 박스 저장소에 위임 | Beluga -> 박스 | `supported` | `VERSIONS.md:15` | `kube-ready-box:LICENSE`, `kube-ready-box:NOTICE` |
| opt-in 준비 상태 증거 게이트 (`ready` + `findings[]`) | 박스 -> Beluga | `partial` | `scripts/up.sh:25-45` (`KUBE_READY_BOX_EVIDENCE_FILE`, 경고만) | `kube-ready-box:docs/evidence-contracts.md` (`kube-ready-readiness/v1`), `kube-ready-box:docs/node-readiness-attestation.md` |
| Beluga 노드용 증거 기본 생성 | 박스 -> Beluga | `unavailable` | 환경변수 미설정 시 게이트는 no-op | `kube-ready-box:tools/node-readiness-attest.sh`는 부팅된 박스에서 실행; Beluga의 `vagrant up`에 연결되지 않음 |
| 박스 digest/체크섬 검증 | Beluga -> 박스 | `unavailable` | 없음 (이름으로만 참조) | `kube-ready-box:docs/node-readiness-attestation.md` (매니페스트가 박스 `info.json` digest를 묶음) |
| 노드 준비 소유권 | 박스 -> Beluga | `partial` | `scripts/cluster/01-node-prep.sh:12-34`가 박스 튜닝과 중복 | `kube-ready-box:docs/node-readiness-attestation.md` (위 D4) |
| 스토리지 프로파일 증거 (XFS, 쿼터) | 박스 -> Beluga | `unavailable` | 없음 | `kube-ready-box:docs/evidence-contracts.md` (`kube-ready-storage/v1`) |

참고: Beluga 게이트는 `ready`와 `findings[]`만 읽으며 `kube-ready-readiness/v1` 스키마가
아니다. 둘 사이의 매핑은 열린 후속 과제다.

### 3.4 ldapium (레지스트리: `directory-identity-data-plane`, 소비자 narwhal, beluga)

| 계약 표면 | 방향 | 상태 | Beluga 근거 | ldapium 근거 |
|---|---|---|---|---|
| 서버 이미지와 env 계약 (`LDAP_*`, 마운트, UID 999) | Beluga -> ldapium | `supported` | `VERSIONS.md:39`, `openldap.yaml` | `ldapium:README.md`, `ldapium:image/` |
| Keycloak LDAPS 페더레이션 (`ou=users`, WRITABLE) | Keycloak -> ldapium | `partial` | `keycloak-ldap-federation.yaml:186-191` | `ldapium:docs/changes/keycloak-federation/CHANGE.md` (48 PASS, 1 XFAIL H3; Keycloak 26.0.7, Beluga는 26.7.1) |
| 이미 부트스트랩된 볼륨에서의 TLS 수렴 | ldapium -> Beluga | `partial` | `openldap.yaml:192-241` (`postStart` `ldapmodify`) | `ldapium:docs/changes/openldap-2.6-hardening` (이 경우는 미검증) |
| 안정 릴리스 태그 | ldapium -> Beluga | `partial` | nightly 핀 + 허용목록 한 줄 (`.github/image-tag-allowlist.txt`) | `ldapium:README.md` (상태: prototype; 레지스트리 게시는 확인 필요) |
| 백업 / 복구 | ldapium -> Beluga | `unavailable` | LDAP 백업 연동 없음 | `ldapium:charts/ldapium/values.yaml` (`backup:`), `ldapium:scripts/backup.sh`, `ldapium:scripts/restore.sh` |
| 복제 / HA | ldapium -> Beluga | `not-applicable` | 단일 레플리카, 단일 프로파일 | `ldapium:docs/ha-profile.md` |
| 감사 내보내기 (pull 기반 NDJSON) | ldapium -> Beluga | `unavailable` | 없음; #35, #44 참조 | `ldapium:docs/audit-event-schema.md`, `ldapium:scripts/export-audit-log.sh` |
| Helm 차트 재사용 대 Beluga 렌더 매니페스트 | Beluga -> ldapium | `unavailable` | `openldap.yaml`은 자체 템플릿 | `ldapium:charts/ldapium` (위 D5) |
| 관리 UI (`ldapium-ui`) | ldapium -> Beluga | `unavailable` | 핀만 있고 배포 안 됨 (`VERSIONS.md:40`) | `ldapium:ui/` |

버전 참고: `VERSIONS.md:39`는 `nightly-4e85165`를 OpenLDAP 2.6.14로 기재하지만
`ldapium:README.md`는 현재 2.6.15를 안내한다. 핀된 nightly가 어느 쪽인지는 여기서 검증하지 않았다.

### 3.5 nfs-quota-agent (레지스트리: `filesystem-quota-enforcement`, 소비자 narwhal, beluga)

| 계약 표면 | 방향 | 상태 | Beluga 근거 | nfs-quota-agent 근거 |
|---|---|---|---|---|
| NFS PV 쿼터 집행 | 에이전트 -> Beluga | `not-applicable` | NFS/RWX 클래스 없음; PVC 4개뿐, k3s 기본 프로비저너 (`docs/cross-oss-integration-contracts-ko.md` 5절) | `nfs-quota-agent:README.md` (NFS PV 감시, `--provisioner-name`) |
| 파일시스템 전제조건 (NFS 서버 노드의 XFS/ext4 `prjquota`) | 노드 -> 에이전트 | `not-applicable` | `dasomel/ubuntu-26.04-xfs`는 XFS; `prjquota` 마운트 옵션은 이 저장소에 설정 없음 | `nfs-quota-agent:README.md` (Supported Filesystems) |
| 용량 증거: `:9090/metrics`의 Prometheus `nfs_quota_used_bytes{directory}`, `nfs_quota_limit_bytes` | 에이전트 -> Beluga | `unavailable` | Prometheus 워크로드 없음 (12행) | `nfs-quota-agent:README.md` (Prometheus Metrics) |
| PV 어노테이션 `nfs.io/quota-status`, `nfs.io/enforced-limit-bytes` | 에이전트 -> Beluga | `unavailable` | 없음 | `nfs-quota-agent:README.md` (PV Annotations), `nfs-quota-agent:docs/IMPLEMENTATION-STATUS.md` |
| 생산자 무관 PVC별 용량 레코드 `{namespace, claim, storage_class, used_bytes, limit_bytes, source, observed_at}` | 임의 생산자 -> Beluga (proposed) | `unavailable` | `docs/cross-oss-integration-contracts-ko.md` 5절 | 없음; 에이전트는 메트릭을 PVC가 아닌 `directory`로 키잉하므로 매핑 필요 |
| 네임스페이스 쿼터 정책 (`LimitRange`, 어노테이션) | Beluga -> 에이전트 | `not-applicable` | 저장소에 `ResourceQuota`/`LimitRange` 없음 | `nfs-quota-agent:README.md` (Namespace Quota Policy) |

## 4. 분류 집계

1절과 3절의 상태 열에서 집계했다(1-18행과 5개 경계 표).

| 상태 | 1절 (역량) | 3절 (경계 셀) | 합계 |
|---|---|---|---|
| `supported` | 7 | 6 | 13 |
| `partial` | 6 | 5 | 11 |
| `unavailable` | 3 | 17 | 20 |
| `not-applicable` | 2 | 9 | 11 |
| 합계 | 18 | 37 | 55 |

## 5. 이 슬라이스가 하지 않는 것

- 어떤 경계에도 스키마, 엔드포인트, API 이름을 정의하지 않는다. 위의 모든 *proposed* 표면은
  소유자와 협의된 계약이 먼저 필요하다.
- 매니페스트, 스크립트, 버전, `.openforge/status.json` 항목을 변경하지 않는다.
- `ldapium` 차트 채택, 관측성 배포, KubeMetal 연동을 하지 않는다.

경계별 남은 작업은 [ADR-0003](adr/0003-beluga-data-platform-plane-ko.md)의 열린 질문으로 추적한다.
