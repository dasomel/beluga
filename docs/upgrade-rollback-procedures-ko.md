# 업그레이드, 롤백, 호환성 및 유지보수 절차 (제안)

[English](upgrade-rollback-procedures.md) | 한국어

[Issue #13](https://github.com/dasomel/beluga/issues/13) ("Define upgrade, rollback, compatibility, and maintenance procedures") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않는다. 저장소
> 관련 서술에는 이 문서를 작성한 커밋에서 읽은 `file:line`을 붙였다. 라이브 클러스터 관련 서술은 2026-10-07(약 14:07 UTC)에 실행한
> 읽기 전용 `kubectl get` 명령에서 나왔으며 **L#** 로 표시한다. 측정하지 않은 항목은
> **not verified live** 로 표시한다. 외부 서술은 공식 페이지 `[S#]`(접근일 2026-10-07)를 인용하거나 **no official
> recommendation** 이라고 밝힌다. **Proposed** 또는 **Owner decision** 으로 표시한 항목은 저장소에 근거가 없다.
> (영문 라벨은 그대로 유지한다: **Proposed** = 제안, **Owner decision** = 소유자 결정, **not verified live** = 라이브 미검증,
> **no official recommendation** = 공식 권고 없음.)

---

## 1. 목적 및 이슈 매핑

| Issue #13 인수 기준 | 다루는 위치 |
|---|---|
| 지원되는 업그레이드 경로가 문서화되어 있다 | 4.1절(제안 순서), 2.1절(현재 버전 고정 방식) |
| 대표적인 업그레이드와 롤백 1건을 클린 환경에서 테스트했다 | 4.6절(리허설 설계). 여기서는 실행하지 않음 |
| 상태 저장(stateful) 업그레이드 전에 데이터 호환성을 확인한다 | 4.2절(업그레이드 전 게이트) |
| 실패한 업그레이드로부터의 복구를 시연했다 | 4.4절, 5절(여기서는 실행하지 않음) |
| 서비스 영향과 유지보수 절차가 문서화되어 있다 | 4.3절, 4.5절 |
| 호환성 매트릭스를 릴리스마다 유지한다 | 4.7절 |

---

## 2. 현재 상태 (확인됨)

### 2.1 현재 버전을 고정하고 변경하는 방식

| 사실 | 근거 |
|---|---|
| `VERSIONS.md`가 컴포넌트와 이미지 버전의 단일 원천이다 | [`VERSIONS.md:1-5`](../VERSIONS.md) (행: 플랫폼 [`:14-20`](../VERSIONS.md#L14-L20), Strimzi [`:28`](../VERSIONS.md#L28)) |
| `make validate`는 `VERSIONS.md`와 렌더링된 이미지 간 드리프트 검사를 실행한다(차트 조합 2개). 오퍼레이터 버전은 부트스트랩 스크립트의 고정값과 대조한다 | [`Makefile:64`](../Makefile#L64), [`check-version-consistency.py:18-22`](../scripts/ci/check-version-consistency.py#L18-L22), [`:150`](../scripts/ci/check-version-consistency.py#L150) |
| 오퍼레이터와 기본 add-on은 ArgoCD Application이 **아니다**. 부트스트랩 스크립트가 ArgoCD v3.5.0(`:23`), cert-manager 1.21.1(`:299`), CNPG 1.30.0(`:306`), Strimzi 1.1.0(`:313`)을 `kubectl apply`로 적용하고, Flink 오퍼레이터는 `helm upgrade --install` 1.15.0(`:320-322`)으로 적용한다. 다운로드는 SHA-256으로 잠겨 있다 | [`01-argocd-bootstrap.sh:23-24`](../scripts/gitops/01-argocd-bootstrap.sh#L23-L24), [`:299-300`](../scripts/gitops/01-argocd-bootstrap.sh#L299-L300), [`:306-307`](../scripts/gitops/01-argocd-bootstrap.sh#L306-L307), [`:313`](../scripts/gitops/01-argocd-bootstrap.sh#L313), [`:320-322`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L322), [`upstream-artifacts.sha256`](../configs/upstream-artifacts.sha256) |
| k3s는 **채널**에서 설치된다(`INSTALL_K3S_CHANNEL=v${K8S_VERSION}`, `K8S_VERSION=1.36`). 즉 패치 레벨은 설치 시점에 채널이 제공하는 값이며, `scripts/cluster/`에 업그레이드 스크립트는 없다 | [`cluster.env:21`](../configs/cluster.env#L21), [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32), [`:61`](../scripts/cluster/02-k8s-init.sh#L61) |
| 워크로드 차트(`beluga-platform`, `beluga-data`)는 ArgoCD가 `targetRevision: HEAD`에서 `automated: {prune: true, selfHeal: true}`로 배포한다 | [`beluga-data.yaml:10`](../gitops/apps/beluga-data.yaml#L10), [`:20-26`](../gitops/apps/beluga-data.yaml#L20-L26) |
| 알려진 비호환성은 `VERSIONS.md` 비고에 자유 서술로만 기록된다(예: Strimzi 0.45는 "incompatible with K8s 1.36"으로 측정됨, APISIX Ingress Controller 2.x와 etcd 3.5는 보류). 구조화된 매트릭스는 없다 | [`VERSIONS.md:28`](../VERSIONS.md#L28), [`:48-49`](../VERSIONS.md#L48-L49) |
| 부트스트랩 재실행 업그레이드 경로는 실패를 삼킨다. `kubectl apply ... cnpg.yaml \|\| true`(그리고 Strimzi apply, Flink 오퍼레이터 `helm upgrade`, 마지막 차트 `helm template \| kubectl apply`에도 같은 `\|\| true`)이므로 실패한 오퍼레이터 업그레이드가 성공처럼 보일 수 있다. 재실행 시 각 단계의 결과를 명시적으로 확인해야 한다 | [`01-argocd-bootstrap.sh:307`](../scripts/gitops/01-argocd-bootstrap.sh#L307), [`:315`](../scripts/gitops/01-argocd-bootstrap.sh#L315), [`:325`](../scripts/gitops/01-argocd-bootstrap.sh#L325), [`:346`](../scripts/gitops/01-argocd-bootstrap.sh#L346), [`:361`](../scripts/gitops/01-argocd-bootstrap.sh#L361) |
| `tests/` 아래에 업그레이드 리허설이나 롤백 테스트가 없다(이 커밋의 `tests/` 목록: 01-18 기능/렌더 검사뿐) | [`tests/run-all.sh:12-29`](../tests/run-all.sh#L12-L29) |
| Kubernetes 리소스 백업 도구는 계획에 없다("no Velero in Beluga"). SeaweedFS로 향하는 CNPG barman이 유일한 백업이다 | [`portfolio-integration-matrix-ko.md:76`](portfolio-integration-matrix-ko.md#L76), [`02-cnpg.yaml:57-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L71) |

### 2.2 실수 로그에 이미 기록된 라이프사이클 주의사항 (모든 업그레이드에 해당)

| # | 주의사항 | 근거 | 업그레이드에 미치는 영향 |
|---|---|---|---|
| G1 | Flink SQL 잡은 컨트롤러가 아니라 ArgoCD **Sync hook** Job(`flink-sql-submit`, `backoffLimit: 10`)이 제출한다. 재시작 후에는 sync가 훅을 실행할 때만 잡이 다시 제출된다. CI는 훅을 실행하지 않으므로 훅 실패(예: `drop ALL` + root `curl` 실패)는 머지 전에는 보이지 않는다 | [`14-flink-jobs.yaml:27-31`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L27-L31), [`mistakes-log.md:86`](mistakes-log.md#L86), [`:88`](mistakes-log.md#L88) |
| G2 | Flink 세션 클러스터에는 HA가 없고 체크포인트 디렉터리도 설정되어 있지 않다(`execution.checkpointing.interval/mode`만 있음). 라이브 설정이 이를 확인한다(L5). Flink 문서에 따르면 HA가 없으면 JobManager가 크래시할 때 실행 중인 프로그램이 실패한다 [S7] | [`05-flink-operator.yaml:10-14`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L10-L14) |
| G3 | 캐시된 의존성이 egress/ID 공백을 가린다: Lakekeeper는 인메모리 JWKS 캐시로 5시간 동안 동작하다가 파드 재시작 후에야 실패했다(default-deny egress가 게이트웨이를 허용하지 않았음) | [`mistakes-log.md:88`](mistakes-log.md#L88) |
| G4 | init 컨테이너는 재실행 가능해야 한다: 노드 재시작 후 같은 파드에서 두 번째로 실행했을 때 Trino `keytool -importcert`가 실패했다 | [`mistakes-log.md:85`](mistakes-log.md#L85) |
| G5 | `selfHeal: true`는 라이브 수정과 커밋만 하고 푸시하지 않은 수정을 조용히 되돌린다. 오래된 훅 리비전에 걸린 오퍼레이션이 Application을 붙잡을 수 있다 | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:53`](mistakes-log.md#L53), [`:63`](mistakes-log.md#L63) |

### 2.3 라이브 측정 (읽기 전용, 2026-10-07)

| # | 명령 (`KUBECONFIG`는 랩 kubeconfig로 설정) | 결과 |
|---|---|---|
| L1 | `kubectl get nodes -o wide` | 노드 4개(control-plane `master-1` 1개, 워커 3개), 모두 `Ready`, `v1.36.5+k3s1`, 생성 후 3d6h |
| L2 | `kubectl -n argocd get applications` | `beluga-root`, `beluga-platform`, `beluga-data`: 리비전 `9f74c2be...`에서 Synced/Healthy이며 이는 **측정 시점(2026-10-07 ~14:07 UTC) 기준**으로, 당시 `origin/main`과 같았다. 이후 `origin/main`은 앞으로 나아갔으므로(현재 head는 더 나중 커밋) 이 리비전을 현재 값으로 읽지 말 것. Application은 3개뿐이므로 어떤 오퍼레이터도 Argo가 관리하지 않는다 |
| L3 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`, 클러스터 `status.conditions`, `logs postgres-main-1` | `Backup` 객체 2개(첫째는 2026-10-05T02:00:00Z 시작, 둘째는 2026-10-07T02:09:09Z 생성)가 `startedAt`/`stoppedAt` 없이 각각 약 2일, 약 7시간 50분 동안 끝나지 않다가 instance manager 재시작(2026-10-07T02:08:09Z와 09:58:43Z, 아마 VM 재시작, 조사하지 않음) 때에야 `failed`로 끝났다. 즉 백업이 **멈춰 있었다**. `lastSuccessfulBackup`과 `firstRecoverabilityPoint`는 비어 있다. `ContinuousArchiving=False`가 2026-10-04T07:19:43Z부터 계속되며 로그에 `barman-cloud-check-wal-archive ... AccessDenied ... CreateBucket`이 있다(상세: [HA/DR 목표](ha-dr-objectives-ko.md) 2.2절) |
| L4 | `kubectl get pdb -A` | `postgres-main-primary` min 1 / allowed disruptions 0. `beluga-kafka-kafka` min 2 / allowed 1. `beluga-kafka-entity-operator` allowed 1. 그 외 PDB 없음 |
| L5 | `kubectl get --raw .../flink-cluster-rest:8081/proxy/jobs/overview` 및 `/jobmanager/config` (API 서버를 통한 GET) | 잡 3개 `RUNNING`(`beluga-cdc_orders`, `beluga-cdc_customers`, `beluga-events_sessionization`). 클러스터는 3일 전에 생성되었는데도 모두 2026-10-07 10:19 UTC에 시작됨. `high-availability`/`checkpoint`/`state`와 일치하는 설정 키는 `execution.checkpointing.mode/interval`뿐이다. 시작 시각은 `postgres-main-1`의 재시작("2 restarts, last 4h8m ago")과 일치하며, VM 재시작 후 잡이 다시 제출된 것과 부합한다(추론. 재시작 원인은 조사하지 않음) |
| L6 | `kubectl get sc` / `kubectl get pv` | `local-path`뿐이며 reclaim policy는 `Delete`. 모든 PV는 한 노드에 node affinity가 있다(Postgres `worker-2`, SeaweedFS와 Kafka 브로커 1 `master-1`, Kafka 브로커 0과 2는 둘 다 `worker-3`) |
| L7 | 같은 리비전에서 `make drift-live` (읽기 전용) | `PASS (no unauthorized drift)`: 예상 0, 허용 15(sync 상태가 없는 훅 생성 객체), 비인가 0. 이미지 14개 검사, 라이브 워크로드 28개 건너뜀(오퍼레이터, ArgoCD 자체, add-on) |
| L8 | `kubectl get deploy,sts -A` (spec/ready 레플리카) | 나열된 모든 Beluga 워크로드는 레플리카가 1개다(Deployment와 `seaweedfs` / ArgoCD 컨트롤러 StatefulSet). `cilium-operator`만 2개다. Kafka: `KafkaNodePool/mixed`는 controller+broker 역할의 노드 3개를 가진다 |

---

## 3. 인수 기준 대비 공백

| 기준 | 상태 | 공백 |
|---|---|---|
| 지원되는 업그레이드 경로 문서화 | **Open** | 고정값과 검사는 있으나(2.1) 순서, 컴포넌트별 절차, 지원되는 버전 점프가 없다. 오퍼레이터/ArgoCD/k3s는 GitOps 밖에 있으므로 이들의 업그레이드 경로는 "고정값 수정 + 잠금 + 부트스트랩 재실행"이며, 문서화도 테스트도 되어 있지 않다(**not verified live**) |
| 클린 환경 업그레이드 및 롤백 테스트 | **Open** | 리허설이 없다(2.1) |
| 상태 저장 업그레이드 전 데이터 호환성 확인 | **Open** | 업그레이드 전 게이트가 없다. 현재 유일한 Postgres 복구 지점이 존재하지 않으므로(L3) "백업 체크포인트"는 지금 충족할 수 없다 |
| 실패한 업그레이드로부터의 복구 시연 | **Open** | 이를 시연한 것이 없다. 자동 sync Application의 롤백은 Git으로 한다. ArgoCD는 자동 sync가 켜진 Application에 `rollback`을 허용하지 않기 때문이다 [S3] |
| 영향 및 유지보수 절차 문서화 | **Open** | 유지보수 윈도우나 영향 서술이 없다 |
| 릴리스마다 매트릭스 유지 | **Open** | 자유 서술 비고뿐이다(2.1) |

---

## 4. 제안 (모두 **Proposed**)

### 4.1 업그레이드 순서

근거: 인프라 먼저, 그다음 CRD를 소유한 컨트롤러, 상태 저장소, ID, 데이터 경로, 마지막으로 엣지 순이다. 벤더 문서는 제품별 순서만
제공한다(k3s는 서버를 에이전트보다 먼저, 마이너 버전을 건너뛰지 않음 [S1]; Kubernetes
컨트롤 플레인을 kubelet보다 먼저 [S2]; ArgoCD는 마이너별 업그레이드 노트를 읽을 것 [S3]; Strimzi Cluster Operator를 Kafka 클러스터보다 먼저 [S5]; CNPG는 레플리카를 프라이머리보다 먼저 [S4]). 아래의 제품 간 순서에 대한 **no official recommendation** 을 찾지 못했으며, 이는 차트에서 보이는 의존성에서 도출한 것이므로 확정은 소유자의 몫이다.

| 단계 | 컴포넌트 | 현재 수단 | 롤백 분류 |
|---|---|---|---|
| 0 | 사전 점검(4.2) | 작성 예정 스크립트 | 해당 없음 |
| 1 | k3s / Kubernetes (서버, 이후 에이전트. 한 번에 마이너 하나) | 수동(스크립트 없음) | **Snapshot restore only** [S1b] |
| 2 | Cilium, MetalLB, cert-manager | helm/부트스트랩 | CRD 변경: forward-fix 권장 |
| 3 | ArgoCD | 부트스트랩 `kubectl apply --server-side --force-conflicts` [S3] | 설정 백업 복원 [S3] |
| 4 | CNPG, Strimzi, Flink 오퍼레이터 (CRD 먼저, 이후 컨트롤러) | 부트스트랩 | CRD/스키마가 바뀌지 않은 경우에만 오퍼레이터 이미지 롤백(미검증) |
| 5 | 상태 저장: PostgreSQL 마이너(이미지 태그), SeaweedFS, Kafka (Strimzi, 이후 Kafka 버전, 이후 메타데이터 버전) | Git(차트) | Postgres 메이저와 Kafka 메타데이터 버전: **되돌릴 수 없는 것으로 취급** |
| 6 | OpenLDAP, Keycloak, OpenFGA, OPA | Git | DB 스키마에 따라 다름(미검증) |
| 7 | Lakekeeper(`lakekeeper-migrate` Job 있음), OpenMetadata, Airflow, Superset | Git | DB 체크포인트 복원 |
| 8 | Trino, Flink 런타임과 커넥터, Debezium | Git | `git revert` |
| 9 | APISIX, APISIX Ingress Controller | Git | `git revert` |

### 4.2 업그레이드 전 게이트 (읽기 전용, 스크립트화 가능)

1. `make validate`와 `make drift-live`가 통과한다(후자는 비인가 드리프트가 없다고 보고).
2. 세 Application이 모두 `Synced/Healthy`이고, `Failed` 상태의 훅 Job이 없다(G1).
3. **복구 지점이 존재한다**: CNPG `status.lastSuccessfulBackup`이 최근 값이고 `firstRecoverabilityPoint`가 설정되어 있다. CNPG 복구에는 물리 베이스 백업이 필요하며 WAL 아카이브만으로는 충분하지 않다 [S4b]. 현재 이 게이트는 실패한다(L3).
4. 떠나는 버전에서 k3s 데이터스토어 스냅샷을 취한다(k3s 마이너 버전 롤백에는 이전 마이너에서 취한 스냅샷이 필요 [S1b]). 데이터스토어 유형은 **not verified live** 이다.
5. 호환성 확인: 대상 버전이 라이프사이클 매트릭스(4.7)에 지원 대상으로 나와 있고, 벤더 릴리스 노트(ArgoCD, Strimzi, CNPG, Flink 오퍼레이터)를 읽었다.
6. 상태 저장 세부 사항: Kafka `min.insync.replicas`와 토픽 복제 현황을 파악하고(L4/5절), Flink 잡 목록과 마지막 체크포인트를 기록한다(G2).

### 4.3 유지보수 윈도우 및 예상 영향

현재는 정성적 서술이며 수치로 된 윈도우는 소유자 결정이다. 현재의 싱글턴 구성(L8: Postgres, SeaweedFS,
Trino 코디네이터, Keycloak, Lakekeeper, APISIX, Flink JobManager는 레플리카 1개이고, Kafka는 브로커 3개이지만 복제 계수는 1)에서는 해당 워크로드의 모든 재시작이 눈에 보이는 중단이며, `postgres-main-primary`는 0건의 중단만 허용하므로(L4) 노드 drain은 PDB에서 멈춘다. 따라서 HA 프로필이 생기기 전까지는 4.1의 모든 단계에 명시적 윈도우가 필요하다([HA/DR 목표](ha-dr-objectives-ko.md) 참고).

### 4.4 롤백 기준 및 절차

- **트리거(Proposed):** 다음 중 하나: 합의된 안정화 시간 이후에도 Application이 `Healthy`가 아님. 훅 Job이 `Failed`. `tests/run-all.sh` 실패. `make drift-live` 종료 코드 1. 데이터 경로 검사 실패(행이 여전히 Kafka에서 Iceberg로 흐르는지, Trino 쿼리가 결과를 반환하는지).
- **스테이트리스/Git 관리:** 업그레이드 커밋을 `git revert`하고 푸시한 뒤 hard refresh한다. `argocd app rollback`은 쓰지 않는다 [S3]. 푸시가 실제로 되었는지 확인한다(G5).
- **스키마 마이그레이션이 있는 상태 저장(Lakekeeper, Airflow, Superset, OpenMetadata, Keycloak):** 마이그레이션이 되돌릴 수 있는지는 **확인되지 않았다**. 롤백 = 업그레이드 전 데이터베이스 체크포인트를 복원한 뒤 이미지를 되돌린다.
- **PostgreSQL:** 마이너 업그레이드는 CNPG 롤링 업데이트를 동반하는 이미지 태그 변경이다 [S4a]. 메이저 업그레이드는 논리 덤프/복원, 논리 복제, 오프라인 `pg_upgrade`이며, CNPG는 먼저 전체 백업을 하고 이후 새 베이스 백업을 취할 것을 강하게 권장한다 [S4c].
- **Kafka:** 메타데이터 버전 업그레이드는 되돌릴 수 있다고 가정할 수 없다(여기서는 **no official recommendation** 을 확인하지 못함. Strimzi는 버전 순서를 문서화한다 [S5]).
- **Flink:** 체크포인트 디렉터리가 없으면 `last-state`/`savepoint` 업그레이드 모드를 쓸 수 없다 [S6]. 런타임 업그레이드는 잡을 다시 제출하는 것을 뜻한다(Kafka 오프셋으로부터의 데이터 재생이 유일한 복구 수단).

### 4.5 업그레이드 후 점검 (런북에 추가)

1. 주의사항 프로브 세 가지를 다시 실행한다: 재시작된 모든 파드가 readiness를 통과함. 훅 Job이 `Complete`. Flink `jobs/overview`에 잡 3개가 모두 `RUNNING`으로 표시됨(G1/G2).
2. 파드 재시작 후 첫 의존성 조회를 강제로 일으킨다(로그에서 Lakekeeper JWKS 가져오기 확인)(G3).
3. `make drift-live` 후 `bash tests/run-all.sh`.
4. 새 CNPG 베이스 백업이 완료된다(게이트 3을 다시 확인).

### 4.6 클린 클러스터 리허설 (설계만)

이전 태그 릴리스로 클린 클러스터를 프로비저닝하고, 데모 데이터를 적재하고, CNPG 백업을 취한 뒤, 4.1의 업그레이드를 Git을 통해 단계별로 적용하고, 4.5를 실행한 다음, 4.4로 롤백하고 4.5를 다시 실행한다. 소요 시간을 기록한다(이 값이 4.3의 수치가 된다). 프로비저닝은 기존 Vagrant 흐름을 사용한다. **이 레인에서는 실행하지 않았다**.

### 4.7 라이프사이클 매트릭스

제안 파일 `docs/lifecycle-matrix.md`(+ `-ko`): 컴포넌트별로 현재 고정값, 마지막으로 테스트한 조합, 지원되는 업그레이드 점프, 근거가 있는 비호환 조합, 롤백 분류를 담는다. 새 `make validate` 검사가 이 매트릭스의 "current" 열을 `VERSIONS.md`와 비교하여(`check-version-consistency.py`와 같은 패턴) 오래된 값이 되지 않게 한다.

---

## 5. 검증 및 테스트 아이디어

| 아이디어 | 인수 신호 |
|---|---|
| `scripts/ops/preupgrade-check.sh` (읽기 전용, JSON 리포트) | 최근 CNPG 복구 지점이 없는 동안 0이 아닌 값으로 종료(L3 재현) |
| `make validate`의 매트릭스 최신성 검사 | `VERSIONS.md`가 바뀌었는데 매트릭스 행이 바뀌지 않으면 실패 |
| 리허설 잡 (수동, 문서화) | 업그레이드와 롤백이 각각 4.5 통과로 끝남 |
| 장애 훈련: Flink JobManager 파드 삭제 | 잡 손실과 재제출 경로를 문서화(G1/G2 확인) |

---

## 6. 남은 소유자 결정

| # | 결정 | 권고 (근거) |
|---|---|---|
| D1 | 유지보수 윈도우 길이/빈도와 단계별 허용 중단 시간 | 워크로드가 싱글턴인 동안은 모든 단계에 공지된 명시적 윈도우로 시작(L4) |
| D2 | 지원하는 버전 점프 정책 | k3s와 ArgoCD는 한 번에 마이너 버전 하나 [S1][S3]. 나머지는 공식 서술 없음 |
| D3 | 호환성 매트릭스의 위치 | 새 `docs/lifecycle-matrix.md`와 validate 검사(4.7) |
| D4 | 리허설 환경 규모와 주기 | 릴리스마다 4-VM 전체 프로필. 더 저렴한 대안은 소유자 입력 필요 |
| D5 | 오퍼레이터/ArgoCD를 GitOps 아래로 옮길 것인가 | 보류. 먼저 부트스트랩 재실행 경로를 문서화 |
| D6 | 채널 대신 k3s 패치 버전을 고정할 것인가 | 고정 권장(재현 가능한 리허설). 패치 지연은 소유자가 저울질 |
| D7 | 싱글턴 상태 저장 업그레이드의 다운타임 수용 | 학습 프로필에서는 예. HA 프로필과 함께 재검토 |

---

## 7. 후속 구현 작업 (순서대로, 작게)

| # | 작업 | 인수 테스트 아이디어 |
|---|---|---|
| T1 | CNPG 예약 백업과 WAL 아카이빙이 성공하도록 만든다. [HA/DR 목표](ha-dr-objectives-ko.md) T1의 진단 단계부터 시작한다(백업이 멈추고, WAL 아카이빙이 `CreateBucket` AccessDenied로 실패) | 24시간 이내에 `lastSuccessfulBackup`이 채워짐 |
| T2 | `docs/lifecycle-matrix.md`와 validate 검사를 추가한다 | 의도적 불일치에서 검사가 실패함 |
| T3 | `scripts/ops/preupgrade-check.sh`를 작성한다 | L3 상태에서 실패하고 T1 이후 통과 |
| T4 | `scripts/ops/postupgrade-check.sh`를 작성한다(4.5) | 삭제된 Flink 잡을 감지함 |
| T5 | k3s 패치를 고정한다(D6) | 노드 버전이 고정값과 같음 |
| T6 | 소요 시간을 기록하는 리허설 런북 | 업그레이드+롤백 증적 파일 1개 |

---

## 출처

모두 2026-10-07에 접근했다.

| ID | 출처 |
|---|---|
| S1 | k3s manual upgrade: https://docs.k3s.io/upgrades/manual (servers first, one at a time; do not skip minor versions) |
| S1b | k3s rollback: https://docs.k3s.io/upgrades/roll-back (needs a snapshot from the older version) |
| S2 | Kubernetes version skew policy: https://kubernetes.io/releases/version-skew-policy/ |
| S3 | ArgoCD upgrade overview https://argo-cd.readthedocs.io/en/stable/operator-manual/upgrading/overview/ ; automated sync https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/ ("Rollback cannot be performed against an application with automated sync enabled") |
| S4 | CloudNativePG 1.30: (a) rolling updates https://cloudnative-pg.io/docs/1.30/rolling_update ; (b) backup https://cloudnative-pg.io/docs/1.30/backup ; (c) PostgreSQL upgrades https://cloudnative-pg.io/docs/1.30/postgres_upgrades |
| S5 | Strimzi deploying guide, upgrades: https://strimzi.io/docs/operators/latest/deploying#assembly-upgrade-str |
| S6 | Flink Kubernetes Operator 1.15 job management: https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.15/docs/custom-resource/job-management/ |
| S7 | Flink 1.20 HA overview: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/overview/ |
