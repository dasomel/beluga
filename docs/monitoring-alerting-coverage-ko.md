# 서비스 수준 모니터링, 알림 및 인시던트 대응 커버리지 (제안)

[English](monitoring-alerting-coverage.md) | 한국어

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
| Flink | 잡이 `RUNNING`이 아님. 체크포인트 실패 | Prometheus reporter, 기본 포트 9249 [S6]. 활성화에는 `flinkConfiguration` 키가 필요. 메트릭 이름: 확인. REST `jobs/overview`(L9)는 임시 프로브 | critical |
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
