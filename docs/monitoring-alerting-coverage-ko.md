# 서비스 수준 모니터링, 알림 및 인시던트 대응 커버리지 (제안)


## 노드 메모리·재시작·시계 검사 (2026-11-16, #45 / #408)

선언 상태이며 라이브 미검증: 규칙 18개, scrape job 13개. 컴포넌트·RBAC 추가 없음.

- **D-ALERT-22:** `NodeMemoryLow`는 `100 * (1 - working_set / capacity)`를 쓴다.
  서로 다른 job 라벨을 가진 두 입력을 먼저 `node`별 집계한 뒤 나눈다.
  여유 <15%가 5분 지속되면 warning, <10%가 2분 지속되면 critical이다.
  제공된 장애 추정치 22/24 GiB는 여유 8.3%로 두 임계값을 넘는다. 지속 시간까지
  확인한 재현이 아닌 추론이다. working set은 Linux `MemAvailable`과 다르며 slab·OOM
  횟수를 따로 측정하지 않는다. 비용: 휴리스틱·캐시 집계 차이. 탈출구: 실측 후 조정.
  cAdvisor의 `machine_memory_bytes`는 `id`/`device` 없이도 보존한다.
  기존 파일시스템 필터는 overlay/tmpfs와 `/dev/shm`을 계속 제외한다.
- **D-ALERT-26/27 (#428 후속):** `NodeMemoryMetricsMissing`은 메모리 입력의 정확한
  selector 중 하나가 전체에서 15분간 사라지면 warning을 낸다. 기존 파일시스템 부재
  유예와 맞춰 노드 재시작을 허용한다. 일부 노드 누락은 탐지하지 않으며 테스트 31은
  여전히 모든 노드 입력을 검사한다. kubelet scrape와 메트릭 필터를 확인한다.
  Alertmanager는 같은 `node`의 critical 동안 `NodeMemoryLow` warning을 억제한다.
  집계가 `instance`를 제거하므로 instance로 묶으면 다른 노드 warning도 억제된다.
  비용: 전체 부재만 지연 탐지·중복 warning 숨김. 탈출구: 검토된 노드별 인벤토리 또는
  집계·억제 설정의 동시 변경.
- **D-ALERT-23:** `ContainerRestartingFrequently`는 동일 Pod/컨테이너의 start time이
  30분 동안 3회 이상 바뀐 상태가 5분 지속될 때 warning이다. 롤아웃의 새 Pod 이름은
  별도 시계열이며 합산하지 않는다. resource 메트릭에 owner-kind 라벨이 없어 차트의
  Deployment/StatefulSet Pod 이름·Kubernetes safe-encoded 해시 패턴만 허용한다. migration·seed·hook을 포함한 차트
  Job은 제외된다. 오퍼레이터 관리 Kafka/CNPG/Flink와 커스텀 워크로드는 이 일반 규칙
  범위 밖이고 기존 Flink 재시작 경보는 유지한다. 허용된 컨트롤러와 같은 Pod 이름
  패턴을 의도적으로 쓰는 커스텀 Job은 이 입력만으로 구분할 수 없다. 비용: 제한된
  커버리지. 탈출구: 검토된 소유권 메타데이터 추가. 가짜 `owner_kind` selector는 쓰지 않는다.
- **D-ALERT-24/25:** 노드·exporter·평가기의 시계가 같으므로 클러스터 내부 vmalert만으로
  독립 기준 시계와 비교할 수 없다. 신뢰할 수 있는 운영자 호스트에서
  `KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash tests/32-node-clock-sanity.sh`를 실행한다.
  호출자/리포 kubeconfig를 비공개 임시 파일로 격리하고 kubectl의 CA·클라이언트 인증서
  검증을 유지한다. `/version` 본문 대신 `/healthz -v=8` 응답 `Date`를 읽고 API 시차와
  노드별 Ready heartbeat 미래 시차를 출력한다. `NODE_CLOCK_MAX_SKEW_SECONDS` 기본값은
  120이며 양의 정수만 허용한다. 절대 API 시차·미래 heartbeat가 임계값을 넘거나
  헤더/heartbeat 누락·TLS/인증 실패·API 불통이면 실패한다. 요청 지연과 Date의 1초
  정밀도는 API 비교에서 허용한다. 비용: 시점 검사·호스트/프록시 시계 신뢰·client-go
  텍스트 헤더 형식 의존. 탈출구: API/TLS 장애 시 호스트/게스트 직접 비교.
  연속 호출/페이징·NTP 설정·복구는 추가하지 않는다.

메트릭 근거: [Kubernetes v1.35 resource collector](https://raw.githubusercontent.com/kubernetes/kubernetes/v1.35.0/pkg/kubelet/metrics/collectors/resource_metrics.go)를
읽어 working set·start time 이름과 Pod/container/namespace 라벨을 확인했다.
[cAdvisor v0.53 machine collector](https://raw.githubusercontent.com/google/cadvisor/v0.53.0/metrics/prometheus_machine.go)를
읽어 용량 메트릭과 파일시스템 라벨 부재를 확인했다.
[client-go v0.35 transport](https://raw.githubusercontent.com/kubernetes/client-go/v0.35.0/transport/round_trippers.go)를
읽어 verbosity 8의 응답 헤더 출력을 확인했다. 이는 업스트림 계약이며 실제 kubelet의
노출/수집 여부는 추론이다. 이 작업자는 라이브 측정하지 않았다. 리포 인시던트 raw/28은
이전 14개 규칙 검사만 입증하며 신규 입력의 근거가 아니다.
[컨트롤러 해시](https://raw.githubusercontent.com/kubernetes/kubernetes/v1.35.0/pkg/controller/controller_utils.go)와
[safe-encoding 문자 집합](https://raw.githubusercontent.com/kubernetes/apimachinery/v0.35.0/pkg/util/rand/rand.go)도
읽었다. 해시에서 모음을 제외해 `keycloak-clients-*`·`lakekeeper-bootstrap-*`를 Deployment
Pod로 오인하지 않는다. 오프라인 검사기는 네 값 조합에서 렌더된 모든 차트 Job 제외와
Deployment/StatefulSet 포함을 확인한다.

대응: 호스트/VM 메모리·slab·OOM·컨테이너 이전 로그를 확인하고 가용성 영향을 검토한 뒤
원인 워크로드 부하를 낮춘다. API 불통이면 호스트/VM 진단을 사용한다. 신뢰할 수 있는
호스트 시계와 게스트/RTC를 비교한 뒤 [Colima 복구 절차](colima-single-node-ko.md)를 따른다.
자동 재부팅·워크로드 삭제·시각 교정은 추가하지 않았다. 기본 null 수신자는 외부로 보내지
않으므로 노드/평가기 전체 장애 탐지에는 외부 watchdog이 여전히 필요하다.

To confirm live: 테스트 31의 모든 노드 양수 용량/working set·node 라벨 일치·재시작
시계열·정상 규칙 18개를 확인한다. 테스트 32는 실제 클라이언트 인증서 kubeconfig로
Date를 읽고 미래 heartbeat/시차를 거부해야 한다. 별도 승인된 검사로 warning/critical
전이·캐시/slab 영향·알림 경로를 확인한다. 오프라인 구조·stub 검사는 PromQL 평가나
알림 전달을 입증하지 않는다.

> **갱신 2026-11-15 — 이슈 #408·#412, 선언 상태(라이브 미검증):** VictoriaMetrics에 전체 노드와 `database`/`platform-system` CNPG Pod SD를 추가하고, **새 RBAC 없이** 정적 `Service/flink-cluster-metrics`(`flink-cluster-metrics.streaming.svc.cluster.local:9249`, `D-ALERT-21`)로 Flink JobManager Prometheus 리포터(`:9249`)를 스크레이프한다. 직접 kubelet TLS `:10250`는 `victoria-metrics` ServiceAccount의 `nodes/metrics get` 및 node list/watch만 쓰며, pod list/watch는 두 namespace의 Role로 한정한다. `nodes/proxy`·Secret API 권한은 없다. kubelet 세 job은 filesystem/resource 메트릭(`kubelet-resource`는 Flink 재시작 탐지용 `container_start_time_seconds` 포함)만, cAdvisor는 machine memory capacity 및 `id="/",device=~"/dev/.+",device!="/dev/shm"`의 host fs usage/limit만 보존해 tmpfs/overlay를 제외한다. NodeRootFilesystemLow 이름은 유지하며 용량 >1073741824 bytes를 `node, device`별로 평가해 root/data disk를 포함한다. 실측한 cloud-init ISO는 항상 100%여서 전체 장치 최솟값은 오탐이다. 1 GiB 이하 또는 `/dev/` 밖 파일시스템은 제외되며 부재 경보와 테스트 31(모든 노드 용량 >1 GiB, 장치 출력)이 보완한다. 탈출구는 node-exporter mountpoint 라벨이다. node-exporter·kube-state-metrics는 추가하지 않는다. vmalert 규칙 18개(스크레이프 job 13개): root/data 여유 <20% warning / <12% critical, 슬롯 WAL >512MiB/10m warning / >900MiB/2m critical, 슬롯 비활성 /15m, pg_wal >2GiB/10m, archive ready >20/15m, scrape 실패 /10m, `NodeRootFilesystemMetricAbsent` /15m warning(동일 usage/limit selector의 전체 부재; 노드별 부재는 테스트 31), `FlinkNoRunningJobs` /5m critical(`up{job="flink"} == 0` 또는 `absent(flink_jobmanager_numRunningJobs{job="flink"})` 또는 `< 1`), `FlinkJobManagerRestarting` /5m warning(`changes(container_start_time_seconds{job="kubelet-resource",namespace="streaming",container="flink-main-container"}[15m]) >= 2` 또는 `resets(flink_jobmanager_Status_JVM_CPU_Time{job="flink"}[15m]) >= 2`), Watchdog. container fs는 전체 로그/emptyDir 사용량을 보장하지 않아 파드별 ephemeral storage 경보는 생략한다. VM은 단일 장애 지점이다. Alertmanager silence/nflog는 256Mi PVC에 보존하며 기본 null 수신자는 **외부 알림을 보내지 않는다**. 채널/담당자는 오너 미결정이며 승인 후 `observability.alertmanager.config`와 `extraEgress` 값으로 확장한다. Grafana 내장 Alertmanager 데이터소스와 VM `-vmalert.proxyURL`로 경보/규칙을 조회하며 플러그인·공개 호스트명은 추가하지 않는다. `check-alerting-pipeline.py`는 구조만 검사하고 Ready·TLS/RBAC/SD·메트릭·평가·Watchdog 전달은 `tests/31-alerting-pipeline.sh` 라이브 확인이 필요하다. [ADR-0011](adr/0011-alerting-vmalert-alertmanager-ko.md), [CDC/스토리지 런북](runbooks/cdc-slot-wal-retention-ko.md), [Flink HA 손상 체크포인트 런북](runbooks/flink-ha-broken-checkpoint-ko.md). 아래 제안은 역사 기록이며 ‘평가기/Alertmanager 없음’은 이전 상태다.

> **2026-11-12 CDC 디스크 탐지:** `tests/29-cdc-slot-wal-retention.sh`는 읽기 전용으로 슬롯 보존 WAL(<1GiB), 모든 Connect Pod의 `/kafka/logs` 할당 사용량(<=200MiB), kubelet nodefs/imagefs 여유(>=20%)를 검사합니다. WAL이 imagefs를 채운 것과 별개로 Connect의 무제한 시간별 로그가 nodefs를 채웠습니다. GitOps에 콘솔 로깅·재접속 로거 ERROR·log/tmp emptyDir 상한·ephemeral-storage limit을 선언했으며 실제 로그 회전·eviction은 이번 변경에서 라이브 검증하지 않았습니다. 현재 VM scrape 목록에 CNPG 9187·노드 exporter가 없고, custom query ConfigMap·경보 평가기·프로비저닝 대시보드 관례도 없습니다. CNPG 기본 `cnpg_pg_replication_slots_*` 메트릭은 VM 수집/알림 증거가 아닙니다. 이 검사는 시점 검사이며 자동 알림/스케줄은 미구축입니다. [복구 런북](runbooks/cdc-slot-wal-retention-ko.md).

[English](monitoring-alerting-coverage.md) | 한국어

> **갱신 2026-11-09 (이슈 #366):** 아래 내용은 2026-10-07 시점 상태다. Prometheus Stack 서술은 VictoriaMetrics single-node + Grafana로 대체됐고(`gitops/charts/beluga-platform/templates/observability.yaml`, VERSIONS.md 행), `grafana-external` NodePort 껍데기는 삭제됐으며, Grafana는 APISIX를 거쳐 `grafana.<baseDomain>`에서 Keycloak SSO로 제공된다. 알림 규칙·Alertmanager·로그(Loki)는 범위 밖이며 로그는 Kubernetes Events로 유지한다.

[Issue #14](https://github.com/dasomel/beluga/issues/14) ("Define service-level monitoring, alerting, and incident response coverage") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 규칙, exporter, 대시보드, 스크립트, 매니페스트를 변경하지 않는다. 저장소 관련
> 서술에는 이 문서를 작성한 커밋에서 읽은 `file:line`을 붙였다. 라이브 관련 서술은 2026-10-07(약 14:07 UTC)에 실행한 읽기 전용 `kubectl`
> 명령에서 나왔으며 **L#** 로 표시한다. 측정하지 않은 항목은 **not verified live** 이다. 외부
> 서술은 공식 페이지 `[S#]`(접근일 2026-10-07)를 인용하거나 **no official recommendation** 이라고 밝힌다. 심각도, 대응
> 목표, 소유권은 **Owner decisions** 이며, 근거와 함께 선택지로 제시할 뿐 사실로 제시하지 않는다.
> (영문 라벨은 그대로 유지한다: **Proposed** = 제안, **Owner decision** = 소유자 결정, **not verified live** = 라이브 미검증,
> **no official recommendation** = 공식 권고 없음.)

---

## 1. 목적 및 이슈 매핑

| Issue #14 인수 기준 | 다루는 위치 |
|---|---|
| 핵심 서비스에 실행 가능한(actionable) 알림이 있다 | 3절(공백)과 4.2절(카탈로그) |
| 심각도와 대응 목표가 문서화되어 있다 | 4.3절(선택지) |
| 런북이 있고 알림에서 링크된다 | 4.5절 |
| 주요 계층마다 통제된 장애 1건으로 탐지를 시연한다 | 5절 |
| 운영 상태 리포트가 반복 가능하게 생성된다 | 4.6절 |

---

## 2. 현재 상태 (확인됨)

### 2.1 저장소

| 사실 | 근거 |
|---|---|
| "Prometheus Stack 67.4.0 (`prometheus-community/kube-prometheus-stack`)"이 컴포넌트로 나열되어 있고 README 아키텍처 표에도 있다 | [`VERSIONS.md:20`](../VERSIONS.md#L20), [`README.md:66`](../README.md#L66) |
| 이와 관련해 저장소에 있는 산출물은 values 블록(`prometheusGrafana.enabled: true`, 포트)과 `app.kubernetes.io/name=grafana`를 선택하는 NodePort `Service` `grafana-external`뿐이다. 저장소 전체에서 `kube-prometheus`, `alertmanager`, `PrometheusRule`/`ServiceMonitor`를 검색하면 `VERSIONS.md` 행만 나오며, 스택을 설치하는 템플릿, 부트스트랩 단계, ArgoCD Application은 없다 | [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22), [`platform-services.yaml:8-21`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L21) |
| Kafka에는 `metricsConfig`가 없고, `prometheus.io/scrape` 어노테이션을 가진 파드도 없다(`gitops/` 검색 결과 일치 없음) | [`03-strimzi-kafka.yaml:34-108`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L34-L108) |
| Keycloak은 `grafana` OIDC 클라이언트를 등록한다(로그인 쪽은 있으나 서비스는 없음) | [`keycloak.yaml:211`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L211) |
| `make test` / `tests/01-cluster-health.sh`는 노드 수와 파드 phase를 한 번 확인한다. 이는 상태 검사이지 모니터링이 아니다(`tests/01` 13-37행) | [`01-cluster-health.sh:13-37`](../tests/01-cluster-health.sh#L13-L37), [`run-all.sh:12-29`](../tests/run-all.sh#L12-L29) |
| 패턴으로 쓸 수 있는 기존 리포트형 도구: `make drift-live --out` JSON, `scripts/generate_sizing_report.py`, `scripts/generate_release_qa_report.py` | [`Makefile:147-155`](../Makefile#L147-L155) |
| 실수 로그에는 모니터링이 드러냈어야 할 조용한 실패가 있다: 멈춘 훅 Job, 10일간의 Keycloak CrashLoop, 8일간 정체된 import Job, 수정을 조용히 되돌린 `selfHeal` | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:63`](mistakes-log.md#L63), [`:86`](mistakes-log.md#L86), 그리고 2026-09-08 항목 |

### 2.2 라이브 측정 (읽기 전용, 2026-10-07)

| # | 명령 | 결과 |
|---|---|---|
| L1 | `kubectl get prometheusrules,servicemonitors,podmonitors,alertmanagers,prometheuses -A` | `error: the server doesn't have a resource type "prometheusrules"` (Prometheus Operator CRD가 설치되어 있지 않음) |
| L2 | `kubectl get pods -A \| grep -E "prometheus\|alertmanager\|grafana\|kube-state\|node-exporter"` 및 `kubectl get svc -A \| grep -i -E "prom\|graf\|alert"` | 파드 없음. Service `platform-system/grafana-external`(NodePort 30000) 하나가 있으며 Endpoints는 `<none>` |
| L3 | `kubectl get apiservices \| grep metrics` | `metrics.k8s.io`를 `kube-system/metrics-server`가 제공(리소스 메트릭만 제공, 알림 평가 없음) |
| L4 | `kubectl -n argocd get cm argocd-notifications-cm` | `DATA 0`으로 존재(트리거/서비스 설정 없음). notifications 컨트롤러 파드는 실행 중 |
| L5 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; 클러스터 `status.conditions` | 백업 2개(2026-10-05T02:00:00Z 시작, 둘째는 2026-10-07T02:09:09Z 생성)가 각각 약 2일, 약 7시간 50분 동안 멈춰 있다가 instance manager 재시작 때에야 `failed`로 표시됐다("instance manager was restarted during backup"). `lastSuccessfulBackup` 없음. `ContinuousArchiving=False`가 2026-10-04T07:19:43Z부터 계속(`AccessDenied ... CreateBucket`, [HA/DR 목표](ha-dr-objectives-ko.md) 2.2 참고). 이에 대해 알림이 없었다(알림 스택 없음, L1): 규칙은 "백업이 N시간 넘게 실행 중"과 "ContinuousArchiving false" 둘 다 다뤄야 한다 |
| L6 | `kubectl -n streaming get kafka beluga-kafka` conditions | `Ready=True`와 함께 `Warning` `KafkaMinInsyncReplicas`("min.insync.replicas ... defaults to 1 which does not guarantee reliability") |
| L7 | `kubectl get certificates -A` | Certificate 4개 `Ready=True`. 갱신 시각은 2026-12-03(리프 인증서 3개)과 2027-06-04(내부 CA) |
| L8 | `kubectl get pods -A` 재시작 횟수(누적, 클러스터 생성 후 3d6h) | 상위: `metallb-frr-k8s` 258, `metallb-speaker` 251, `cert-manager-cainjector` 242, `clickstream-gen` 217, `openldap` 205, `apisix-ingress-controller` 186, `seaweedfs-0` 165, `cnpg-controller-manager` 156. 원인은 조사하지 않음. Running이 아닌 파드 없음. 측정 시점에 Warning 이벤트 없음 |
| L9 | `kubectl get --raw .../flink-cluster-rest:8081/proxy/jobs/overview` | 잡 3개 `RUNNING`. 10:19 UTC에 시작됨(클러스터 생성 시각이 아님). 즉 아무 신호 없이 최소 한 번 재시작되었다 |

---

## 3. 인수 기준 대비 공백

| 기준 | 상태 | 공백 |
|---|---|---|
| 핵심 서비스에 실행 가능한 알림이 있다 | **Open (현재는 알림이 0개일 수밖에 없음)** | 메트릭 스택이 실행되지 않는다(L1, L2). `VERSIONS.md`와 README의 Prometheus Stack은 이 저장소에서 배포되지 않는다. 메트릭 소스(Kafka, Flink, Trino, SeaweedFS)도 노출되어 있지 않다(2.1) |
| 심각도와 대응 목표 | **Open** | 정의되지 않았다 |
| 알림에서 링크되는 런북 | **Open** | 런북 디렉터리가 없다 |
| 계층별 통제된 장애 | **Open** | 탐지할 수단이 없다(L1) |
| 반복 가능한 상태 리포트 | **Partial** | 특정 시점 리포트 패턴은 있으나(2.1) 서비스 상태나 추세를 다루는 것은 없다 |

무엇보다 먼저 바로잡을 것이 있다: 문서(README, `VERSIONS.md`)는 Prometheus Stack이 있다고 하지만 저장소와 라이브 클러스터에는 없다. 이 제안은 "스택 설치와 연결"을 첫 작업으로 본다(7절, T1).

---

## 4. 제안 (모두 **Proposed**)

### 4.1 원칙

사용자에게 중요한 증상에 대해 알림을 설정하고, 알림 수는 적게 유지하며, 짧은 일시적 변동은 허용하고, 모든 알림이 실행 가능하도록 하며 콘솔과 런북에 링크한다 [S1]. Alertmanager는 알림을 라우팅하고 그룹화할 뿐이며, 규칙 평가는 Prometheus의 일이다 [S2].

### 4.2 알림 카탈로그 (계층별 시작 세트)

메트릭 이름은 공식 페이지를 읽은 경우에만 인용했으며, 나머지 행은 "구현 중 확인"이라고 적었다.

| 계층 | 신호 (알림 조건) | 메트릭 / 소스 | 심각도 (선택지) |
|---|---|---|---|
| GitOps | Application이 N분 동안 `Synced`가 아니거나 `Healthy`가 아님 | `argocd_app_info{sync_status,health_status,name}` [S3] | warning, `Degraded`이면 critical |
| GitOps 드리프트 | 비인가 드리프트 보고됨 | `make drift-live` JSON ([GitOps 드리프트 제어](gitops-drift-control-ko.md) 참고) | warning |
| PostgreSQL | 인스턴스 다운. 복제 지연. **최근 성공한 백업 없음 / 복구 지점 없음** | `cnpg_collector_up`, `cnpg_pg_replication_lag`, `cnpg_collector_last_failed_backup_timestamp`, `cnpg_collector_last_available_backup_timestamp` (포트 9187, PodMonitor는 수동 생성) [S4] | critical (다운, 백업 오래됨) |
| Kafka | 브로커/컨트롤러 다운, under-replicated 파티션, 컨슈머 랙(CDC) | `metricsConfig`(JMX exporter 또는 Strimzi Metrics Reporter)와 Strimzi 예시 규칙 필요 [S5]. 메트릭 이름: 확인 | critical / warning |
| Kafka Connect (Debezium) | 커넥터 또는 태스크 `FAILED` | Strimzi `KafkaConnector` 상태. 메트릭 이름: 확인 | critical |
| Flink | 잡이 `RUNNING`이 아님 / JobManager 비응답(`FlinkNoRunningJobs`); JobManager 반복 재시작(`FlinkJobManagerRestarting`) | 정적 `Service/flink-cluster-metrics` 경유 포트 9249 Prometheus reporter [S6](`flink_jobmanager_numRunningJobs`, `flink_jobmanager_Status_JVM_CPU_Time`) + `kubelet-resource` `container_start_time_seconds`(`D-ALERT-21`, [런북](runbooks/flink-ha-broken-checkpoint-ko.md)) | critical(`FlinkNoRunningJobs`, 5m) / warning(`FlinkJobManagerRestarting`, 5m) |
| Trino | 코디네이터 사용 불가. 큐 대기/실패 쿼리 비율(포화) | Trino JMX/메트릭: **미검증**, 확인 | warning |
| 오브젝트 스토리지 | 볼륨 용량(PVC는 5Gi), S3 엔드포인트 가용성 | kube-prometheus-stack의 kubelet 볼륨 통계(확인), blackbox 프로브 | 사용률이 높으면 critical |
| 인증/ID | Keycloak/OpenLDAP 다운, 로그인 프로브 실패 | blackbox/synthetic 프로브(tests 06/07/10 로직 재사용) | critical |
| 인증서 | 갱신 윈도우 안에서 만료 임박 | cert-manager는 포트 9402에서 메트릭 제공 [S7]. 정확한 메트릭 이름은 읽은 페이지에 없었음: 확인 | warning |
| 플랫폼 | 파드 재시작 비율, 노드 메모리/디스크 압박, 허용 중단 0인 PDB | 스택의 kube-state-metrics / node-exporter(확인) | warning |

### 4.3 심각도와 대응 목표 (선택지, **Owner decision**)

세 가지 등급을 제시한다. 수치 목표에 대한 **No official recommendation** 이 있으며, 소유자가 고른다.

| 등급 | 의미 | 대응 목표 선택지 | 알림 방식 |
|---|---|---|---|
| P1 critical | 데이터 손실 위험 또는 한 계층의 전면 장애(CNPG 다운, 백업 오래됨, Kafka ISR 미달, Flink 잡 중단) | 업무 시간 기준 수 시간 내 확인 vs 24x7: **Owner decision** | 페이지 |
| P2 warning | 성능 저하 또는 위험 상태이며 즉각적 손실은 없음 | 다음 영업일 | 티켓/채팅 |
| P3 info | 추세/위생(인증서 갱신 윈도우, 재시작) | 주간 검토 | 리포트만 |

### 4.4 소유권 및 에스컬레이션

저장소에는 온콜 담당자가 명시되어 있지 않다. 제안: 런북 인덱스에 역할(플랫폼 운영자, 데이터 엔지니어, ID 소유자), 주/부 연락처 필드, 저장소 소유자로의 에스컬레이션 단계를 담은 표를 둔다. 구체적인 이름은 **Owner decision** 이다.

### 4.5 런북

디렉터리 `docs/runbooks/`(+ `-ko`)에 이슈에 나열된 장애마다 한 페이지를 둔다. 각 페이지에는 증상과 알림, 처음 수행할 읽기 전용 확인 세 가지, 안전한 완화 조치, 에스컬레이션 시점, 사후 로그 항목(`mistakes-log.md`에 기록)을 담는다. 페이지: Kafka 랙, 커넥터 장애, Flink 잡 장애(훅 재제출 경로와 JobManager 재시작 시 잡 손실 포함, [업그레이드 절차](upgrade-rollback-procedures-ko.md) G1/G2 참고), Trino 포화, CNPG 장애와 실패한 백업, 오브젝트 스토리지 용량, Keycloak/LDAP 장애, ArgoCD 드리프트. 알림 어노테이션에 `runbook_url`을 넣는다.

### 4.6 주기적 상태 리포트

읽기 전용 스크립트 `scripts/ops/health-report.py`가 결정적(deterministic) JSON과 짧은 Markdown 요약을 작성한다: 노드와 파드 상태, Application sync/health, CNPG 백업 최신성, Flink 잡 상태, 인증서 만료, 재시작 이상치(측정 L5-L9가 첫 세트). `drift-live --out` 패턴을 재사용한다. 주기와 보존 기간은 **Owner decision** 이다.

### 4.7 개발 프로필의 노이즈

프로필에 따라 규칙 세트를 두 가지로 고른다([환경 프로필](environment-profiles-ko.md) 참고): 프로덕션 스타일은 모든 P1/P2를 켜고, 개발 프로필은 P1만 유지하며 P2/P3는 리포트로 보낸다. 단일 레플리카 워크로드와 허용 중단이 0인 PDB는 개발 프로필에서 정상이므로 페이지를 울려서는 안 된다.

---

## 5. 검증 및 테스트 아이디어 (통제된 장애, 랩 전용)

| 계층 | 장애 | 기대 탐지 |
|---|---|---|
| GitOps | `selfHeal`을 일시 중지한 상태에서 Deployment를 수동으로 스케일(소유자 실행) | 드리프트 리포트 발견 또는 `OutOfSync` 알림 |
| PostgreSQL | WAL 아카이빙을 막는다(예: 스크래치 클러스터에서 잘못된 버킷 지정, L5 조건 재현) | 한 번의 scrape와 규칙 윈도우 이내에 아카이빙 실패와 백업 오래됨 알림 |
| Kafka | 브로커 하나 중지 | under-replicated / broker-down 알림 (참고: RF=1이면 손실은 경고에 그치지 않고 데이터 사용 불가가 된다) |
| Flink | JobManager 파드 삭제(잡 손실 재현) | job-not-running 알림 |
| 인증/ID | Keycloak을 0으로 스케일 | 로그인 프로브 알림 |
| 인증서 | 수명이 짧은 테스트 인증서 발급 | 만료 윈도우 알림 |

각 항목은 리허설 클러스터에서만 실행한다. 이 레인에서는 어느 것도 실행하지 않았다.

---

## 6. 남은 소유자 결정

| # | 결정 | 권고 (근거) |
|---|---|---|
| D1 | 저장소에서 Prometheus Stack을 설치할 것인가, 아니면 README/`VERSIONS.md`에서 해당 서술을 제거할 것인가 | 설치(서술이 이미 있고 포트/OIDC 클라이언트도 준비되어 있음) |
| D2 | 운영 시간(24x7 또는 합의된 시간)과 대응 목표 | 학습 프로필은 합의된 시간. HA 프로필과 함께 재검토 |
| D3 | 알림 채널(채팅/이메일) | 소유자 입력 필요. ArgoCD notifications는 비어 있음(L4) |
| D4 | 등급별 소유자와 에스컬레이션 담당 | 4.4의 소유권 표를 채운다 |
| D5 | 리포트 주기와 보존 기간 | 주간 리포트, 릴리스 산출물로 보관 |
| D6 | 장애 테스트 주기 | 릴리스 리허설마다 |

---

## 7. 후속 구현 작업 (순서대로, 작게)

| # | 작업 | 인수 테스트 아이디어 |
|---|---|---|
| T1 | 메트릭 스택(ArgoCD Application)과 null receiver를 가진 Alertmanager를 배포한다 | `kubectl get prometheusrules`가 동작하고 타깃이 up |
| T2 | Kafka, Flink, CNPG 메트릭을 노출한다(PodMonitor) | 각각에 대해 타깃이 나열됨 |
| T3 | 규칙: CNPG 백업 오래됨, ArgoCD 미동기화, 인증서, 파드 재시작 | 규칙이 로드되고 강제 장애에서 발화함 |
| T4 | `docs/runbooks/` 골격과 어노테이션 링크 | 모든 규칙에 런북 URL이 있는지 CI 검사 |
| T5 | `scripts/ops/health-report.py` | 두 번 실행해도 출력이 반복 가능 |
| T6 | 통제된 장애 훈련(5절) | 계층별 증적 파일 1개 |

---

## 2026-11-12 업데이트: emptyDir·ephemeral-storage 상한 (#403)

두 차트가 렌더하는 Deployment/StatefulSet/DaemonSet/Job의 disk emptyDir 상한과
컨테이너(init 포함) ephemeral-storage request/limit을 선언했다. 렌더 검사는
기본·full·SSO·full+SSO에서 양수 sizeLimit과 request ≤ limit을 강제하며 Connect의
로그 마운트 검사도 유지한다. **이 범위의 Memory emptyDir는 0개**이며 검사에서 면제한다.
외부 CNPG 파드의 shm은 Memory이며 범위 밖이다. 상세 예산·퇴거 영향·오퍼레이터 후속 필드는
[저장소 상한 인벤토리](ephemeral-storage-bounds.md), 제공된 실측 원문은
[영문 증거 절](monitoring-alerting-coverage.md#2026-11-12-update-emptydir-and-ephemeral-storage-bounds-403)을 본다.

Airflow home 2,009,600KiB는 `/home/airflow` 설치본 포함 볼륨 전체 값이며 로그 크기로
단정하지 않는다. `/opt/airflow/logs`와 `/home/airflow/logs`에 공식 3.3.0 이미지
`/clean-logs`(3일 보존·15분 간격)를 기동한다. 로그 burst/열린 파일은 상한을 넘겨 단일
LocalExecutor 파드를 퇴거시키고 태스크를 중단할 수 있다. 확인한 것은 소스·정적 렌더·문법이며
실제 로그 정리·퇴거·복구는 라이브 미검증이다. **자동 수집/경보 평가/알림 파이프라인은 여전히 없다.**

---

## 출처

모두 2026-10-07에 접근했다.

| ID | 출처 |
|---|---|
| S1 | Prometheus, Alerting practices: https://prometheus.io/docs/practices/alerting/ |
| S2 | Alertmanager configuration: https://prometheus.io/docs/alerting/latest/configuration/ |
| S3 | ArgoCD metrics: https://argo-cd.readthedocs.io/en/stable/operator-manual/metrics/ |
| S4 | CloudNativePG 1.30 monitoring: https://cloudnative-pg.io/docs/1.30/monitoring |
| S5 | Strimzi deploying guide, metrics: https://strimzi.io/docs/operators/latest/deploying#assembly-metrics-config-files-str |
| S6 | Flink 1.20 metric reporters: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/metric_reporters/ |
| S7 | cert-manager Prometheus metrics: https://cert-manager.io/docs/devops-tips/prometheus-metrics/ |

`ContainerRestartingFrequently`에 선택 활성화한 `database/shop-gen`도 포함한다. DB 장애는 7회 시도 후, 숫자 설정 오류는 즉시 비정상 종료한다. pip 장애는 프로세스 안에서 재시도한다. [Shop 트래픽](shop-traffic-generator-ko.md) 참고.
