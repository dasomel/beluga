# GitOps 설정 드리프트 제어 (제안)

[English](gitops-drift-control.md) | 한국어

[Issue #39](https://github.com/dasomel/beluga/issues/39) ("Detect and enforce GitOps configuration drift") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 스크립트, Application, 정책, CI 워크플로를 변경하지 않는다. 이 문서는
> 이미 존재하는 것 위에 서 있다: [권위 있는 설정 소스](configuration-sources-ko.md)(기준 1)와 읽기 전용
> `make drift-live` 검사. 저장소 관련 서술에는 이 문서를 작성한 커밋에서 읽은 `file:line`을 붙였다.
> 라이브 관련 서술은 2026-10-07(약 14:07 UTC)에 실행한 읽기 전용 명령에서 나왔으며 **L#** 로 표시한다. 측정하지 않은 항목은 **not
> verified live** 이다. 외부 서술은 공식 페이지 `[S#]`(접근일 2026-10-07)를 인용하거나 **no official recommendation** 이라고 밝힌다.
> **Proposed** 또는 **Owner decision** 으로 표시한 항목은 저장소에 근거가 없다.
> (영문 라벨은 그대로 유지한다: **Proposed** = 제안, **Owner decision** = 소유자 결정, **not verified live** = 라이브 미검증,
> **no official recommendation** = 공식 권고 없음.)

---

## 1. 목적 및 이슈 매핑

| Issue #39 인수 기준 | 현재 상태 | 여기서 다루는 위치 |
|---|---|---|
| 권위 있는 설정 소스가 문서화되어 있다 | 완료: [`configuration-sources.md` section 1](configuration-sources-ko.md) | 반복하지 않음 |
| 중대한 드리프트를 탐지하고 보고한다 | 부분적: 요청 시, 커버되는 범위에 한해(2.2) | 3절, 4.2절, 4.4절 |
| 비인가 라이브 변경을 예상된 생성 상태와 구분한다 | 부분적: 커버되는 범위에 분류가 있음 | 3절, 4.1절 |
| 조정(reconciliation) 절차가 반복 가능하다 | **Open** (`configuration-sources.md`에서 소유자 결정 대기 중) | 4.3절 |
| 드리프트 증적을 운영 검토를 위해 보존한다 | 산출물만 있음(수동) | 4.4절 |

---

## 2. 현재 상태 (확인됨)

### 2.1 ArgoCD에 의한 강제

| 사실 | 근거 |
|---|---|
| 두 워크로드 Application 모두 `automated: {prune: true, selfHeal: true}`와 `ServerSideApply=true`를 가진다. `beluga-data`는 `RespectIgnoreDifferences=true`와 `ignoreDifferences` 규칙 하나(StatefulSet `volumeClaimTemplates`의 API 기본값 필드)를 추가한다 | [`beluga-data.yaml:20-26`](../gitops/apps/beluga-data.yaml#L20-L26), [`:30-37`](../gitops/apps/beluga-data.yaml#L30-L37). `ignoreDifferences` 의미 [S4] |
| ArgoCD는 자동 sync 간격을 `timeout.reconciliation` ConfigMap 값(기본 120초 + 60초 지터)으로 문서화하며, `selfHeal`은 self-heal 타임아웃(기본 5초) 이후 재시도한다 [S1]. 라이브 `argocd-cm`은 `timeout.reconciliation`을 재정의하지 않으므로(L2) 기본값이 적용된다 | [S1], L2 |
| Self-heal은 대역 외(out-of-band) 수정을 조용히 되돌리며, 커밋만 하고 푸시하지 않은 수정도 포함한다. 이미 디버깅 시간을 소모시킨 바 있다 | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:63`](mistakes-log.md#L63) |
| ArgoCD는 고유한 (커밋, 파라미터) 쌍당 sync를 한 번만 자동화하며 같은 커밋에서 실패한 시도를 재시도하지 않는다 [S1]. 멈춘 훅이 Application을 붙잡을 수 있다 | [S1], [`mistakes-log.md:53`](mistakes-log.md#L53), [`:86`](mistakes-log.md#L86) |

### 2.2 `make drift-live` (기존)

| 사실 | 근거 |
|---|---|
| 읽기 전용(`kubectl get`만 사용). 종료 코드 0은 정상, 1은 비인가, 2는 도달 불가/검증 불가 리비전. `make validate`의 일부가 **아니다**(오프라인 단위 테스트는 포함됨) | [`Makefile:147-155`](../Makefile#L147-L155), [`Makefile:97-98`](../Makefile#L97-L98) |
| 분류: `expected`(예약됨, 이를 내보내는 곳 없음), `tolerated`, `unauthorized`. 검사: sync 리비전, 추적 리소스 OutOfSync, 컨테이너별 이미지 대 차트 렌더, 누락/미선언 워크로드, 상태(health)는 tolerated로 보고 | [`check-live-drift.py:7-21`](../scripts/ops/check-live-drift.py#L7-L21) |
| 명시된 커버리지 한계: Application, 추적 리소스 sync 상태, 워크로드 이미지. RBAC, NetworkPolicy, Service, ConfigMap/Secret 내용은 **아니다**. 차트로 렌더링되지도 Argo가 추적하지도 않는 워크로드(오퍼레이터, 업스트림 매니페스트, add-on)는 `skipped`이며 이미지도 검사하지 않는다 | [`check-live-drift.py:23-27`](../scripts/ops/check-live-drift.py#L23-L27) |
| 증적 산출물: `--out <file>`이 결정적 JSON을 쓴다. 저장과 검토는 수동이며 스케줄러도 보존 정책도 없다 | [`configuration-sources.md` section 4](configuration-sources-ko.md#L101), [`Makefile:149-155`](../Makefile#L149-L155) |
| 예상되는 생성 상태가 문서화되어 있다(자격 증명, 오퍼레이터가 생성한 Secret/Certificate, API 서버 기본값, sync 훅 Job) | [`configuration-sources.md` section 2](configuration-sources-ko.md#L34) |
| 정적 게이트가 이미 머지 전에 금지된 변경 몇 가지를 막는다(이미지 고정, NetworkPolicy 커버리지, 보안 기준선, 평문 ID 엔드포인트, Kafka 리스너 보안). [보안 게이트](security-gates-ko.md) 참고 | [`Makefile:64-120`](../Makefile#L64-L120) |

### 2.3 라이브 측정 (읽기 전용, 2026-10-07)

| # | 명령 | 결과 |
|---|---|---|
| L1 | `kubectl -n argocd get applications` 및 `-o json` | Application 3개(`beluga-root`, `beluga-platform`, `beluga-data`), 모두 `9f74c2be...` = `origin/main`에서 Synced/Healthy. 세 곳 모두 `selfHeal`, `prune`이 true. `beluga-data`만 `ignoreDifferences`(위의 StatefulSet 규칙)가 있다. `retry` 블록 없음 |
| L2 | `kubectl -n argocd get cm argocd-cm -o json` (키) | `resource.customizations.ignoreResourceUpdates.*`와 `resource.exclusions`뿐. `timeout.reconciliation` 없음 |
| L3 | `kubectl -n argocd get cm argocd-notifications-cm` | `DATA 0`: 알림 트리거나 서비스 없음. 알림 스택도 없다([모니터링 커버리지](monitoring-alerting-coverage-ko.md) L1 참고) |
| L4 | `make drift-live DRIFT_ARGS="--expect-revision 9f74c2be... --out <scratch>"` | `RESULT: PASS (no unauthorized drift)`. 요약 `expected 0 / tolerated 15 / unauthorized 0`. 15건 모두 "no sync status reported (sync-hook / untracked)"인 `resource` 항목(예: `ConfigMap/streaming/flink-sql-files`). 라이브 워크로드 42개 중 14개의 이미지를 검사, 28개 건너뜀 |
| L5 | `kubectl get networkpolicy -A --no-headers \| wc -l`; `kubectl get clusterrolebinding` 개수 | NetworkPolicy 25개, ClusterRoleBinding 83개 존재. 각각이 Argo 추적 대상인지 업스트림인지는 **확인하지 않았다** |

---

## 3. 인수 기준 대비 공백

| # | 공백 | 중요한 이유 |
|---|---|---|
| G1 | **일시적 드리프트는 보이지 않는다.** `selfHeal`은 추적 리소스를 조정 윈도우 안에 바로잡고, `drift-live`는 이력이 없는 특정 시점 스냅샷이다. 복구된 비인가 수정은 보존되는 기록을 남기지 않는다 | 기준 2와 5: "중대한 드리프트 탐지"는 윈도우 안에 누군가 검사를 실행할 때만 참이다 |
| G2 | **알림도 스케줄도 없다.** `drift-live`를 실행하는 CronJob/CI 잡이 없다(Makefile이 유일한 호출자). `argocd-notifications-cm`은 비어 있다(L3) | 기준 2 |
| G3 | **추적되지 않는 추가분은 탐지되지 않는다.** `prune`과 `OutOfSync`는 Application에 속한 리소스만 다룬다. 워크로드 네임스페이스에 수동으로 만든 리소스는 "orphaned resource"이며, ArgoCD가 경고할 수 있는 것은 AppProject가 `orphanedResources`를 활성화한 경우뿐이다 [S3]. 라이브 AppProject 설정은 **확인하지 않았다** | 기준 2/3 |
| G4 | **범위 한계.** RBAC, NetworkPolicy, Service 노출, ConfigMap/Secret 내용은 `drift-live` 커버리지 밖이다(2.2). 라이브 워크로드 42개 중 28개가 건너뛰어지며, 모든 오퍼레이터와 ArgoCD, 부트스트랩 스크립트가 설치한 기본 add-on이 여기에 포함된다(L4) | 이슈가 바로 이것들을 명시한다(Helm values, 매니페스트, RBAC, NetworkPolicy, 서비스 노출, 핵심 런타임 설정) |
| G5 | **생성 상태는 부분적으로만 구분된다.** 자격 증명과 파생 Secret은 설계상 비교하지 않는다. `expected`는 예약만 되어 있고 내보내지 않으므로, 검사하지 않는 종류의 생성 변경과 비인가 변경을 구분하지 못한다 | 기준 3 |
| G6 | **조정 / break-glass 절차가 없다.** 비인가 드리프트를 알림만 할지, `selfHeal`(이미 켜져 있음)로 복구할지, 기록된 예외가 필요한지 정해지지 않았다. 일시 중지하는 문서화된 방법은 읽은 페이지에 없다 | 기준 4 |
| G7 | **릴리스 사전 점검은 클러스터가 아니라 Git만 다룬다.** 정적 게이트는 Git의 금지된 변경을 막지만, 프로모션 전후에 클러스터를 릴리스와 비교하는 것은 없다 | 이슈의 마지막 요구 사항 |
| G8 | **오퍼레이터와 부트스트랩이 설치한 컴포넌트는 GitOps 밖에 있다**([업그레이드 절차](upgrade-rollback-procedures-ko.md) 2.1 참고). 이들의 드리프트는 ArgoCD로는 전혀 탐지할 수 없다 | "권위 있는 소스"의 범위 |

---

## 4. 제안 (모두 **Proposed**)

### 4.1 드리프트 분류

| 분류 | 정의 | 예시 | 대응 |
|---|---|---|---|
| expected | 설계상 생성되거나 기본값이 채워진 것 | 파생 Secret, cert-manager/CNPG가 생성한 Secret, 무시 대상 StatefulSet 필드의 API 서버 기본값 | 없음. 예외 목록은 `configuration-sources.md`에 유지 |
| tolerated | 운영상 수용되고 범위가 한정된 것 | sync 상태가 없는 훅 Job(L4), Progressing/Degraded 상태 | 보고만 |
| unauthorized | Git과 다른 그 밖의 모든 것 | 수정된 Deployment 이미지, 추가 Service/RoleBinding/NetworkPolicy 변경, 삭제된 정책 | 알림 후 조정하거나 break-glass 예외를 기록 |

제안: 문서화된 예외 목록에 대해 `expected`를 실제로 내보내도록 하여, 검토자가 산문을 읽지 않고도 생성된 것과 비인가 변경을 구분할 수 있게 한다.

### 4.2 탐지 계층

1. **지속적(ArgoCD):** `argocd_app_info{sync_status,health_status}`를 내보내고 [S2], Application이 조정 주기 몇 번보다 오래 `Synced`가 아니면 알림을 보낸다. 메트릭 스택이 필요하다([모니터링 커버리지](monitoring-alerting-coverage-ko.md) T1 참고).
2. **이벤트 기록:** ArgoCD notifications(sync 상태 변경 시 트리거)를 로그나 채널로 보내, 복구된 드리프트가 기록을 남기게 한다(G1). 서비스/채널은 **Owner decision** 이다.
3. **예약 스냅샷:** 읽기 전용 RBAC를 가진 스케줄러(클러스터 내 CronJob 또는 운영자 호스트)에서 `drift-live --out`을 실행하고 JSON 산출물을 보관한다.
4. **고아 리소스 탐지:** AppProject에서 `orphanedResources: {warn: true}`를 활성화하고 [S3], 리포트에 "orphaned"를 포함한다(G3).
5. **커버리지 확장(작은 단계):** NetworkPolicy, Service 타입/포트, RoleBinding/ClusterRoleBinding subject, 선택한 ConfigMap 키(Secret 값은 절대 제외)를 `drift-live`에 추가한다. 오퍼레이터는 `VERSIONS.md` 고정값과 비교한다(G4, G8).

### 4.3 조정 및 break-glass

| 상황 | 절차 (**Proposed**) |
|---|---|
| 비인가 드리프트 발견 | 기본은 `selfHeal`이 되돌리는 것. 운영자가 `make drift-live`로 확인한 뒤 발견 사항을 기록 |
| 의도적인 긴급 라이브 변경 | 먼저 break-glass 기록(누가, 무엇을, 왜, 만료)을 열고, 문서화된 ArgoCD 메커니즘으로 해당 Application의 자동 sync를 일시 중지(**런북을 쓰기 전에 공식 문서에서 정확한 명령을 확인할 것**. 읽은 auto-sync 페이지에는 명시되어 있지 않았다)하고, 변경한 뒤 **같은 변경을 Git에 커밋**하고, sync를 다시 켜고 `drift-live`를 실행 |
| 커밋만 하고 푸시하지 않은 수정 | 다음 sync에서 드리프트로 취급(알려진 실패, `mistakes-log.md:63`). 런북은 `drift-live`가 이미 요구하듯 `git ls-remote`가 기대 리비전과 같은지 확인 |
| 롤백 | Git에서 revert. ArgoCD는 자동 sync가 켜진 Application에서 `rollback` 명령을 허용하지 않는다 [S1] |

### 4.4 증적 보존

예약된 JSON 리포트와 break-glass 기록을 모두 소유자가 정한 기간 동안 CI 산출물이나 운영 저장소에 보관한다. 스키마는 이미 결정적이다. 보존 규칙은 데이터 라이프사이클 및 릴리스 증적 관행과 연결한다. 기간: **Owner decision**.

### 4.5 릴리스 사전 점검

프로모션 전에 `make validate`, `make drift-live`(`--expect-revision` = 릴리스 커밋)를 실행하고, 종료 코드 1 또는 2이면 프로모션을 실패시킨다. 프로모션 후에 반복한다. 금지된 변경 규칙은 정적 게이트에 두고, 라이브에만 존재하는 속성(예: Application에서 selfHeal이 비활성화됨)이 있을 때만 규칙을 추가한다.

---

## 5. 검증 및 테스트 아이디어

| 테스트 | 인수 신호 |
|---|---|
| 이미지 드리프트: 랩에서 `selfHeal`을 일시 중지하고 Deployment 이미지를 수동으로 설정 | `drift-live`가 `image` 발견 사항과 함께 종료 코드 1. 복구하면 사라짐 |
| 비인가 NetworkPolicy 수정 | 커버리지를 확장한 뒤에는 `unauthorized` 발견. 그 전에는 누락된 커버리지를 이 테스트의 예상 실패로 문서화 |
| 고아 리소스: Service를 수동으로 생성 | AppProject 경고가 나타나고 [S3] 보고됨 |
| 복구된 드리프트 기록 | `selfHeal`이 수동 수정을 되돌린 뒤 이벤트/알림이 존재함 |
| break-glass 모의 실행 | 기록, 일시 중지, 변경, 커밋, 재개, 깨끗한 `drift-live` |
| 리포트 결정성 | 변경 없는 클러스터에서 두 번 실행하면 타임스탬프 필드를 제외하고 바이트 단위로 같은 JSON(기존 스키마 확인) |

---

## 6. 남은 소유자 결정

| # | 결정 | 권고 (근거) |
|---|---|---|
| D1 | 강제 모드: 알림만 vs `selfHeal`(현재) | `selfHeal`은 켜 두고, 복구가 조용히 일어나지 않도록 알림과 기록을 추가(G1) |
| D2 | break-glass: 승인 가능한 사람, 최대 기간 | 소유자 단독 승인, 짧은 만료, 이후 Git 커밋 필수 |
| D3 | 스케줄러 위치(클러스터 내 CronJob vs 운영자 호스트) | 최소 ServiceAccount를 가진 클러스터 내 읽기 전용 CronJob. 랩 CI는 클러스터에 도달할 수 없음(미검증) |
| D4 | 드리프트 증적 보존 기간 | 릴리스 증적 보존 기간에 맞춤 |
| D5 | 알림 채널 | 소유자 입력 필요(L3) |
| D6 | 오퍼레이터/부트스트랩 컴포넌트를 드리프트 검사 대상으로 편입 | `VERSIONS.md`와의 고정값 비교부터(G8) |

---

## 7. 후속 구현 작업 (순서대로, 작게)

| # | 작업 | 인수 테스트 아이디어 |
|---|---|---|
| T1 | `check-live-drift.py`에서 문서화된 예외 목록에 대해 `expected`를 내보낸다 | 파생 Secret 픽스처를 쓰는 단위 테스트 |
| T2 | 읽기 전용 RBAC로 `drift-live --out`을 예약 실행한다 | 타임스탬프가 있는 리포트 두 개가 존재 |
| T3 | `orphanedResources.warn`을 활성화하고 이를 드러낸다 | 수동으로 만든 Service가 리포트에 나타남 |
| T4 | sync 상태 변경 시 ArgoCD notification | 수동 수정이 알림 기록을 남김 |
| T5 | 커버리지 확장: NetworkPolicy, Service, RoleBinding | 종류별 단위 테스트. 라이브 실행에서 비인가 0 |
| T6 | break-glass 런북(문서화된 ArgoCD 일시 중지 명령을 확인한 후) | 모의 실행 기록 |
| T7 | 릴리스 사전 점검 래퍼(`validate` + `drift-live`) | 종료 코드 1/2에서 실패 |

---

## 출처

모두 2026-10-07에 접근했다.

| ID | 출처 |
|---|---|
| S1 | ArgoCD automated sync policy: https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/ |
| S2 | ArgoCD metrics (`argocd_app_info`): https://argo-cd.readthedocs.io/en/stable/operator-manual/metrics/ |
| S3 | ArgoCD orphaned resources monitoring: https://argo-cd.readthedocs.io/en/stable/user-guide/orphaned-resources/ |
| S4 | ArgoCD diffing customization (`ignoreDifferences`): https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/ |
