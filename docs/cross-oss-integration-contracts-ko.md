# 교차 OSS 통합 계약 (Cross-OSS Integration Contracts)

[English](cross-oss-integration-contracts.md) | 한국어

이 문서는 [이슈 #99](https://github.com/dasomel/beluga/issues/99)에서 제기된 5개
교차 OSS 경계 — Narwhal, KubeMetal, kube-ready-box, ldapium, nfs-quota-agent —
에 대한 **Beluga 측 관점만** 기록한다. Beluga가 각 프로젝트로부터 기대하거나
이미 소비하고 있는 것만 서술하며, 해당 저장소들에 대한 변경을 요구하지 않는다.
Beluga 자체 아키텍처는 [docs/architecture.md](architecture.md)를, 아래에서
참조하는 설계 결정(D1, D5, D9, D11, D13, D15, D16, D20)의 근거는
[docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md](superpowers/specs/2026-08-09-beluga-data-platform-design.md)를
참조한다.

상태 값은 이슈 #99의 4단계 모델을 따른다: `supported`, `partial`,
`unavailable`, `not-applicable`.

## 요약

| 경계 | 분류 | 현재 상태 | 남은 실제 통합 작업 |
|---|---|---|---|
| ldapium | 완료, 문서화만 필요 | supported/partial | 없음 — 이미 소비 중인 계약을 문서로 남기기만 하면 됨 |
| kube-ready-box | 부분적, 지금 실현 가능 | partial | 유일하게 실질적인 점진적 통합 작업 존재: opt-in evidence-gate 연동 |
| Narwhal | 설계 결정으로 해소됨 | peer / not-applicable | 없음 — 통합하지 않기로 결정, D11/D13 유지 |
| KubeMetal | 순수 미래 구상, 보류 | unavailable | 이번 패스에서 없음 — 소비 지점 자체가 아직 없어 #90/#80으로 연기 |
| nfs-quota-agent | 순수 미래 구상, 기반 부재 | not-applicable | 없음 — quota를 적용할 NFS/RWX 스토리지 자체가 없음 |

**kube-ready-box가 이번 패스에서 유일하게 실질적인 점진적 통합 작업이 있는
경계다.** 나머지는 이미 사실이거나(ldapium), 명시적 설계 결정으로
해소되었거나(Narwhal), 아직 존재하지 않는 전제 조건을 기다리며 올바르게
연기된 상태다(KubeMetal의 소비 지점, nfs-quota-agent의 스토리지 기반).

## 1. ldapium ↔ Beluga — `supported`(디렉터리 데이터 플레인) / `partial`(라이프사이클)

Beluga는 `ghcr.io/dasomel/ldapium:nightly-4e85165`(VERSIONS.md:38, D20)를
LDAP 서버 이미지로 사용 중이며, `ldapium-ui:nightly-d1b7b9e`는 버전이
고정되어 있지만 아직 배포되지 않았다(VERSIONS.md:39).

Beluga가 `gitops/charts/beluga-platform/templates/openldap.yaml`에서 소유하는
것: Service(389/636), cert-manager `Certificate`(openldap-tls), PVC 2개
(openldap-data 2Gi, openldap-config 1Gi), seed-LDIF ConfigMap, Deployment 및
`securityContext`, `ldapwhoami` probe, `openldap-init` Job
(`openldap.yaml:277`).

`postStart` 훅(`openldap.yaml:192-241`)은 `cn=config`에 대해 `ldapmodify`를
멱등적으로 실행하여 TLS 설정을 적용하는데, 이는 해당 이미지가 빈 볼륨에서
최초 부트스트랩 시에만 TLS를 구워 넣기 때문이다. 이는 Beluga가 소유한
워크어라운드로, 명시적인 종료 조건을 가진다: 소비 중인 이미지가 이미
부트스트랩된 볼륨에서도 TLS 설정을 수렴시키게 되면 제거된다 — ldapium에 대한
요구가 아니라 Beluga 자체의 sunset 조건이다.

**Beluga가 오늘 소비 중인 계약(실제):**
- 환경 변수: `LDAP_ROOT_DN`, `LDAP_ORG_NAME`, `LDAP_ADMIN_DN`,
  `LDAP_ADMIN_PASSWORD`, `LDAP_TLS_ENABLED`, `LDAP_TLS_CERT_FILE`,
  `LDAP_TLS_KEY_FILE`, `LDAP_TLS_CA_FILE`, `LDAP_SEED_DIR`.
- 마운트 경로: `/var/lib/openldap/data`, `/etc/openldap/slapd.d`,
  `/var/lib/openldap/run`.
- 런타임 원칙: non-root UID/GID 999, `readOnlyRootFilesystem`.

다운스트림에서 Keycloak은 `ldaps://openldap.iam.svc.cluster.local:636`,
`usersDn=ou=users,dc=beluga,dc=internal`, `editMode=WRITABLE`로 연동한다
(`keycloak-ldap-federation.yaml:186-191`).

**갭**(저장소 내 근거 없음): 백업/복구 없음, replication/syncrepl 어디에도
없음; 버전 계약은 현재 nightly 태그 고정과
`.github/image-tag-allowlist.txt`의 CI 예외 항목 1줄뿐이다.

**이번 패스에서 지금 실현 가능한 것:**
- 위 소비 계약 표(이미 사실이며, 이 문서로 기록).
- `.openforge/status.json` relationship
  `{target: "ldapium", type: "consumes", scope: "OpenLDAP directory data plane"}`
  등록([후속 작업](#이번-패스에서-하지-않은-후속-작업) 참조).
- postStart 훅의 제거 조건을 위와 같이 명시.

**ldapium 측 작업에 의해 막혀 있는 것:** 안정적인 릴리스 태그, 백업/복구
계약, replication 계약.

## 2. kube-ready-box ↔ Beluga — `partial`

Beluga는 `dasomel/ubuntu-26.04-xfs` 박스만 소비한다(`Vagrantfile:25,27`,
`configs/cluster.env:22`). 이 저장소에는 Packer/박스 빌드 파일이 없다
(`*.pkr.hcl` 0건). `VERSIONS.md:15`는 이미 라이선스/NOTICE 소유권을
kube-ready-box 저장소로 위임하고 있으며 — 이 경계는 이미 올바르게
그어져 있다.

그러나 노드 준비(node-prep) 로직은 kube-ready-box의 영역과 겹친다:
`scripts/cluster/01-node-prep.sh:12-34`가 swap 비활성화, 커널 모듈 로딩
(`overlay`, `br_netfilter`), sysctl 설정을 직접 수행한다 — 이는 원래
박스 수준 도구가 담당할 "Kubernetes-ready 노드 기반" 영역이다.

노드 수준 preflight/readiness 도구는 없다(파일명 일치는 `tests/11-identity-plaintext-preflight.sh` 1건뿐이며 이는 SSO/TLS 정적 점검 스크립트로 박스 수준 준비성 도구와 무관하다 — 그 외 precheck/readiness/doctor/diagnos* 스크립트 이름은 0건). 박스 출처 검증도 없다(`cosign` 0건; 박스는
이름으로만 참조되며 checksum/digest 검증 없음) — 반면 Beluga는 자체 JAR
공급망을 `sha256sum -c`로 검증한다
(`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:67-75`,
`05-flink-operator.yaml:49-56`). OS 이미지의 공급망 검증이 JAR 파일보다
약한 셈이다.

Beluga는 이미 구조화된 evidence 관례를 가지고 있으나
(`scripts/agent/operations_agent.py:65-90,292`, `ExecutionEvidence`,
`schema_version="beluga-agent-evidence/v1"`), 이는 `kubectl` 기반의
클러스터 수준 점검이지 노드 수준이 아니다.

**Beluga가 소비하고자 하는 계약(Beluga 자체 기대, 합의된 것 아님):**
`beluga-agent-evidence/v1` 네이밍 관례를 따르는 노드당 JSON 객체 1개:
- 노드 식별 — 이름, 역할, OS/커널 버전, 박스 식별자 + digest
- readiness — swap off, 커널 모듈 로드 여부, 필수 sysctl 설정 여부,
  컨테이너 런타임 존재 여부
- 스토리지 — 파일시스템 타입/XFS 여부, prjquota 활성화 여부, 여유 용량
- 최상위 `ready: true|false`와 `findings[]` 배열

**이번 패스에서 지금 실현 가능한 것:**
- 위 예상 스키마 문서화.
- `scripts/up.sh`에 opt-in 게이트를 추가하여 지정된 경로의 readiness
  리포트를 읽되, 파일이 없으면 아무 동작도 하지 않도록 함 — 오늘의 설치
  흐름을 절대 깨지 않음([후속 작업](#이번-패스에서-하지-않은-후속-작업) 참조).
- `.openforge/status.json` relationship
  `{target: "kube-ready-box", type: "consumes", scope: "node OS image; readiness evidence (expected)"}`
  등록.

**kube-ready-box 측 작업에 의해 막혀 있는 것:** readiness 리포트를 실제로
생성하는 것; 박스 digest/checksum 공개.

## 3. Narwhal ↔ Beluga — 결정됨: `peer`로 등록, `not-applicable`로 응답

**인간 결정(이미 확정됨):** 이슈 #99가 제시한 "Narwhal을 플랫폼
라이프사이클/컨트롤 플레인의 단일 원천으로 사용" 프레이밍은 채택하지
않는다. 대신 관계는 `peer`로 등록하며(`consumes`가 아님), #99의 통합
매트릭스 요구사항에 대한 이 경계의 답은 standalone 프로파일 기준
`not-applicable`이다. D11과 D13은 그대로 유효하며 — 코드 변경 없음,
향후 narwhal-hosted 프로파일에 대한 어떠한 확약도 현재 하지 않는다.

두 저장소 간 통합 코드는 전혀 없다. 모든 참조는 소비가 아니라 설계 계보다:
- Beluga는 Narwhal의 골격(Vagrant + 동일 박스 + ArgoCD GitOps)을
  `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md:14,165`
  기준으로 미러링했으며, 해당 스펙은 명시적으로 Beluga가 narwhal 저장소
  구조를 "미러링(mirrors)"한다고 서술한다.
- D16(`:53`)은 Narwhal의 kubeadm 대신 k3s를 선택했다.
- D1(`:38`)은 Narwhal(`192.168.56.x`)과 동시에 실행될 때 충돌을 피하기
  위해 특별히 `192.168.77.x` 서브넷을 선택했다 — 즉 두 프로젝트는 의존
  계층이 아니라 공존하는 peer로 설계되었다.
- D11/D13(`:17,29`)은 "narwhal 없이 standalone으로 실행하기 위해" SSO
  (Keycloak)와 API 게이트웨이(APISIX)를 명시적으로 자체 호스팅하며,
  설계 스펙은 Beluga가 "narwhal 인스턴스를 참조하지 않는다"고 명시한다.

Beluga와 Narwhal은 설계 패턴을 공유한다 — 동일한 Vagrant 박스, ArgoCD
app-of-apps 패턴, SeaweedFS S3 선택(D5), 부트스트랩 시점 랜덤 자격증명
생성(D15), 단일 CNPG 오퍼레이터 패턴(D9), harbor의 "exec format error"
사건에서 얻은 arm64 매니페스트 검증 게이트(`:404`). 이들은 "구현의
중복"이 아니라 "패턴의 상속"이며 — 이는 어떤 설계 결정도 뒤집지 않으면서
#99의 "중복 구현 후보 식별" 요구사항에 정직하게 답한다.

역경계 규칙은 peer/not-applicable 결정과 무관하게 그대로 유지된다:
Iceberg/Trino/Flink 및 data-product 시맨틱은 Beluga에 남으며 Narwhal로
이동하지 않는다.

**이번 패스에서 지금 실현 가능한 것:**
- `.openforge/status.json` relationship
  `{target: "narwhal", type: "peer", scope: "shared platform patterns; no runtime dependency"}`
  등록.
- 위 공유 패턴 목록 문서화.
- 위 역경계 규칙 문서화.

Narwhal 측 작업에 전혀 막혀 있지 않다 — 이 경계의 상태는 Narwhal이 무엇을
하든 상관없이 Beluga 자체의 이미 확정된 설계 결정만으로 완전히 결정된다.

## 4. KubeMetal ↔ Beluga — `unavailable`

이 저장소 어디에도 AI 기능이 존재하지 않는다.
ai/llm/inference/embedding/ollama/openai/gpu/mps/metal(MetalLB 제외)/
vllm/multimodal/whisper/ocr 전수 검색 0건; Apple Silicon/Metal/하드웨어
가속 관련 언급 0건. KubeMetal에 대한 언급은 설계 스펙 2곳뿐이며 모두
명백히 미래 시제다: `...design.md:24`("narwhal/kubemetal과 함께
infra/AI/data 트라이앵글을 완성")와 `:31`("ML feature store / kubemetal
통합 — 향후 확장 후보로만 기록"). 참고: `scripts/agent/operations_agent.py`는
이름에 "agent"가 들어가지만 읽기 전용 kubectl 래퍼 + 정책/evidence
프로토타입일 뿐이며 — 모델 호출도 추론도 없으므로 AI 기능으로 잘못
계산해서는 안 된다.

더 근본적으로, Beluga에는 아직 AI 어댑터가 붙을 소비 지점 자체가 없다:
문서/이미지/미디어 보강, 시맨틱 태깅, 분류는 모두 미구현 백로그(이슈
#73/#79/#80)이며, 현재 이 저장소에는 텍스트/문서/미디어 처리 파이프라인이
전혀 없다. 지금 어댑터를 만드는 것은 호출자가 없는 인터페이스를 만드는
것 — 이 문서가 의도적으로 하지 않는 추측성 구현이다.

따라서 이 절은 경계의 존재와 이슈 #90의 제약만을 기록한다: AI-optional
아키텍처 — KubeMetal은 선택적이어야 하고, 기본값은 off여야 하며, 특정
provider에 종속되지 않아야 하고, AI가 도출한 필드가 결정론적 필드를
덮어써서는 안 된다.

**참고용 계약 스케치**(Beluga의 기대일 뿐 합의된 것 아님, #90/#80이
소비 지점을 만들 때까지 연기):
- vendor-neutral 어댑터 경계로서 OpenAI 호환 엔드포인트 형태
  (`/v1/chat/completions`, `/v1/embeddings`) — #90의 재설계 없는 교체
  요구사항을 만족.
- 실패 시 non-AI 경로로의 폴백이 문서화된 `/healthz` readiness 체크.
- 계보 추적을 위한 호출 단위 provenance
  `{model, model_version, runtime, run_id, prompt_digest}`.
- AI 대 non-AI 리소스/비용/지연을 별도로 측정하는 텔레메트리.

KubeMetal은 로컬/오프라인 백엔드이므로, 전송 전 프라이버시/분류 게이트가
필요한 대신 명시적으로 "외부 egress 아님"으로 기술한다.

**권고:** 실제 어댑터 구현은 #90 백로그로 연기한다. 이 문서는 경계와
제약만 기록하며 아무것도 구축하지 않는다.

## 5. nfs-quota-agent ↔ Beluga — `not-applicable`

이 저장소에는 해당 기능 자체가 구현되어 있지 않으므로 중복이 존재하지
않는다. `nfs`/`NFS`/`nfs-subdir`/`nfs-client` 어디에도 0건. 스토리지는
누락에 의해 k3s 기본 `local-path` 프로비저너를 사용한다 — 어떤 PVC도
`storageClassName`을 지정하지 않는다(storageClass/local-path/hostPath
명시 설정 0건). PVC는 총 4개뿐이다: `seaweedfs-data` 5Gi
(`01-seaweedfs.yaml:161-168`, RWO), `apisix-etcd-data` 1Gi
(`apisix-infra.yaml:10-19`), `openldap-data` 2Gi + `openldap-config` 1Gi
(`openldap.yaml:49-69`).

quota/ResourceQuota/LimitRange/xfs_quota/prjquota/diskPressure/capacity
관련 항목은 어디에도 0건이다 — 네임스페이스 `ResourceQuota` 없음, 디스크
여유 공간 점검 스크립트 없음, 용량 모니터링 없음(이 저장소에는 Prometheus
알림 규칙 자체가 없다). XFS는 박스 이름
(`dasomel/ubuntu-26.04-xfs`)에만 등장한다 — prjquota의 자연스러운
기반이지만 이 저장소의 어떤 설정도 이를 구성하지 않으며, 이는 외부 박스
이미지에 내장된 선택이다. `Vagrantfile`에는 디스크 크기 설정이 전혀
없고 RAM/CPU 변수만 있다.

`unavailable`이 아니라 `not-applicable`이 정직한 라벨이다:
`unavailable`은 로드맵 약속처럼 읽히지만, 실제로는 어떤 프로파일에도
NFS/RWX 스토리지 클래스가 없고 이를 도입하겠다는 명시적 목표도 없다.
#99가 정의한 4가지 상태(`supported`/`partial`/`unavailable`/
`not-applicable`) 중 현실과 일치하는 것은 이것뿐이다.

**동기가 되는 맥락**(이미 저장소에 기록된 실제 사고):
`01-seaweedfs.yaml:136-141`의 인라인 주석은 `/data`에 원래 PVC가 없어
데이터가 컨테이너의 쓰기 가능 레이어에 기록되었고, S3 인증 롤아웃 중
파드가 재시작되면서 PVC가 추가되기 전에 기존 Iceberg 데이터(orders,
customers, events_enriched)가 유실된 사건을 기록하고 있다. 이 때문에
enforcement가 아직 적용되지 않더라도 용량 evidence *소비* 계약을 문서화할
가치가 있다.

**Beluga가 소비하고자 하는 계약(기대일 뿐 합의된 것 아님)** — enforcement가
아닌 용량 evidence *소비* 스키마만, `beluga-agent-evidence/v1` 필드
네이밍 관례를 따름: PVC당 레코드
`{namespace, claim, storage_class, used_bytes, limit_bytes, source,
observed_at}`, 여기서 `source`는 생산자를 명명한다(`nfs-quota-agent` /
`local-path` / `manual`) — nfs-quota-agent가 채택되는지 여부와 무관하게
이 필드가 스키마를 오늘 유용하게 만드는 지점이다. 용도: 프로파일 사이징,
데이터 라이프사이클(#18, Iceberg 보관/삭제 정책), `.openforge/status.json`
상태 보고, 리소스 거버넌스(#38).

**이번 패스에서 지금 실현 가능한 것:**
- 위 용량 evidence 소비 스키마 문서화(생산자 비종속).
- `.openforge/status.json` relationship
  `{target: "nfs-quota-agent", type: "not-applicable", scope: "filesystem quota enforcement; no NFS/RWX storage class in any profile"}`
  를 침묵하는 누락이 아니라 명시적 응답으로 등록.
- 아직 적용되지 않는 기능에 대해 소비자 스키마를 문서화하는 정직한 동기로
  위 SeaweedFS 데이터 유실 사건을 인용.

**막혀 있는 것:** 그 외 전부 — 구체적으로, 존재하지 않는 스토리지에 대한
enforcement 계약을 작성하는 것은 위시리스트를 계약처럼 꾸미는 일이 된다.
이는 nfs-quota-agent의 작업이 아니라 Beluga 자체의 스토리지 아키텍처
결정(NFS/RWX를 언젠가 도입할지 여부)에 막혀 있다.

## 이번 패스에서 하지 않은 후속 작업

1. 위에서 설명한 5개 `.openforge/status.json` `relationships` 항목을
   실제로 등록하는 작업(별도 PR).
2. `scripts/up.sh`의 kube-ready-box opt-in evidence 게이트를 구현하는
   작업(별도 PR).
3. OpenForge PR #79의 `portfolio/capability-ownership.json`은 향후
   링크할 가치가 있는 관련 산출물이지만, 이 워크스페이스에는 **포함되어
   있지 않으며**, 여기서는 그 필드명을 검증할 수 없다.
