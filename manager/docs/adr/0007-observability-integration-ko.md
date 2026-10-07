# ADR-0007: 관측성 통합(Observability Integration) — 메트릭, 로그 및 이벤트

- **상태**: 제안됨(Proposed) — 설계 제안이며, 본 ADR에 의해 구현되는 라이브 메트릭/로그 어댑터 또는 Grafana 프록시는 없습니다.
  번호 체계 참고: ADR-0005는 배포 및 GitOps 통합(PR #113), ADR-0006은 안전한 운영 조치(PR #134, 이슈 #21)이며, 본 관측성 제안은 ADR-0007입니다.
- **날짜**: 2026-10-07
- **이슈**: [#24 [ROADMAP][ARCH] Observability Integration — Metrics, Logs & Events](https://github.com/dasomel/beluga-manager/issues/24)
- **상위 에픽**: #1
- **관련 문서**: [ADR-0002](0002-backend-api-technology-ko.md)(Domain API, Hono), [ADR-0003](0003-ui-design-system-ko.md)(UI 디자인 시스템, Operations 화면), ADR-0006(Safe Actions 제안, PR #134), `AGENTS.md`(read-first 원칙, 업스트림 OSS와 통합 도메인의 경계), `docs/architecture.md`("Design Principles", 출시된 Operations 슬라이스와 로그 링크를 설명하는 "Navigation / Information Architecture", "Metrics, logs and traces"를 "Observability backends"에 할당하는 표가 있는 "Ownership Boundaries" 제목들; 제목에 번호는 없음), `packages/domain-api/src/schema/event.ts`(Event 스키마: severity `info|warning|error`, source `kubernetes|service|job`), `packages/domain-api/src/schema/resource.ts`(`cpuUsage`, `memoryUsage`, `capacity`, `logsUrl`).
- **결정권자**: dasomel

표기 규칙: Beluga 레포의 file:line 인용은 beluga 커밋 `1df61e0`(`origin/main`) 기준이며 라이브 클러스터 출력은 2026-10-07 측정값입니다. **현재 상태**는 관측한 사실만 적습니다(file:line 또는 실제 실행한 명령, 근거 일자 2026-10-07). **제안**은 설계 의도입니다. 모든 수치(캐시 TTL, 타임아웃, 줄 수 제한, 조회 기간)에는 *Proposed*를 표기합니다. 외부 사실은 2026-10-07에 실제로 연 공식 URL을 달거나 *not verified*로 표기합니다.

## 배경(Context)

Beluga Manager는 Beluga 데이터 플랫폼의 통합 운영 조종석입니다. 운영자에게는 (이슈 #24) 헬스 개요, 리소스/파이프라인에서 메트릭·로그·이벤트로의 드릴다운, 실패한 잡의 원인 맥락, 시간 범위 필터, 관측성 백엔드가 없을 때의 명시적 degraded 상태가 필요합니다. 지배 원칙: **Beluga Manager는 메트릭과 로그를 장기 저장하지 않으며**, 권위 있는 시스템이 제공하는 것을 소비·집계·상관합니다(`docs/architecture.md`, "Ownership Boundaries").

### 현재 상태(관측)

Beluga 플랫폼 측(beluga 레포의 `refs/remotes/origin/main`과 라이브 클러스터를 읽기 전용으로 확인):

| 사실 | 근거 |
|---|---|
| `VERSIONS.md`는 "Prometheus Stack 67.4.0"(`prometheus-community/kube-prometheus-stack`)을 나열하지만 이를 설치하는 것은 없습니다. | Beluga `VERSIONS.md:20`; Beluga `docs/portfolio-integration-matrix.md:54`(12행: "no Prometheus/Loki/Tempo workload"), `:81`(D8: "nothing deployed; VERSIONS.md entry is a drift candidate"); Beluga `docs/adr/0003-beluga-data-platform-plane.md:80`(Beluga ADR-0003 Q5). |
| `gitops/charts/beluga-platform/values.yaml:18-19`은 `prometheusGrafana.enabled: true`(버전 `67.4.0`, 포트 3000/9090)로 설정합니다. 이 플래그가 게이트하는 유일한 템플릿은 `grafana-external` Service shim입니다. 이 플래그는 Prometheus나 Grafana를 **설치하지 않습니다**. | Beluga `gitops/charts/beluga-platform/values.yaml:18-19`; `gitops/charts/beluga-platform/templates/platform-services.yaml:8-23`(`{{- if .Values.prometheusGrafana.enabled }}` -> `Service grafana-external`, NodePort 3000:30000, 셀렉터 `app.kubernetes.io/name: grafana`). |
| 라이브: Service `platform-system/grafana-external`은 존재하며(NodePort `3000:30000`) **엔드포인트가 없습니다**. | `kubectl -n platform-system get svc grafana-external`; `kubectl -n platform-system get endpoints grafana-external` -> `ENDPOINTS <none>`. |
| 라이브: Prometheus Operator CRD가 없고, `monitoring` 네임스페이스가 없으며, Prometheus/Grafana/Loki/Alertmanager/Promtail/Fluent Bit 파드가 없습니다(2026-10-07 측정 시점 총 76개 파드; 개수는 변동되며(하루 뒤 77개) 일치 0건이라는 결과에는 영향 없음). | `kubectl get crd -o name \| grep -c -i "coreos\|prometheus"` -> `0`; `kubectl get ns monitoring` -> NotFound; `kubectl get pods -A --no-headers \| grep -i -c "prometheus\|grafana\|loki\|alertmanager\|promtail\|fluent"` -> `0`. |
| Beluga gitops와 `VERSIONS.md`에 Promtail / Fluent Bit 매니페스트가 없습니다. | `git grep -n -i "promtail\|fluentbit\|fluent-bit" refs/remotes/origin/main -- gitops VERSIONS.md` -> 히트 없음. |
| Beluga 도메인 레지스트리(`*.local.beluga.internal`)는 `trino airflow superset catalog s3 argocd sso`를 나열하며 Grafana, Prometheus, Loki, `monitoring` 항목이 없습니다. | Beluga `AGENTS.md:16-18`. |

Beluga Manager 측:

| 사실 | 근거 |
|---|---|
| Event 도메인(`GET /api/v1/events`)과 Operations 타임라인은 스텁 픽스처로 존재하며, `Resource.cpuUsage`/`memoryUsage`/`logsUrl`은 선택/nullable 필드입니다. | `packages/domain-api/src/schema/event.ts:3-20`, `schema/resource.ts:11-19`, `stub-data/events.ts`. |
| 로그 링크는 리소스에 업스트림 URL이 설정된 경우에만 열리며 Manager는 로그를 저장하지 않습니다. | `docs/architecture.md`, "Navigation / Information Architecture" 절("Log links open only when an upstream URL is configured on the resource; Manager stores no logs" 문장). |
| Domain API에는 인증 미들웨어가 없습니다. | `docs/IMPLEMENTATION-STATUS.md:30`("the app has no auth middleware"). |

### 외부 참고 자료(2026-10-07 열람)

- Prometheus HTTP API — <https://prometheus.io/docs/prometheus/latest/querying/api/> (2026-10-07 열람): `GET /api/v1/query`(instant)와 `GET /api/v1/query_range`가 존재합니다.
- Loki HTTP API — <https://grafana.com/docs/loki/latest/reference/loki-http-api/> (2026-10-07 열람): `GET /loki/api/v1/query_range`; `start`/`end`는 "a nanosecond Unix epoch or another supported format"입니다.
- Kubernetes Event v1 API — <https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/> (2026-10-07 열람): core `v1` 경로 `GET /api/v1/namespaces/{namespace}/events`, `GET /api/v1/events`; `events.k8s.io/v1` 그룹 경로는 제가 읽은 부분에 보이지 않았습니다(*not verified*).
- Alertmanager API v2 OpenAPI — <https://raw.githubusercontent.com/prometheus/alertmanager/main/api/v2/openapi.yaml> (2026-10-07 열람; 릴리스에 고정하지 않은 `main` 브랜치): `GET /alerts`는 불리언 쿼리 파라미터 `active`, `silenced`, `inhibited`, `unprocessed`(모두 기본값 `true`), 배열 파라미터 `filter`(`alertname="MyAlert"` 같은 매처 표현식), `receiver`를 받습니다. 이전 초안의 `?filter=silenced=false`는 틀렸으며 `?silenced=false`(및 `inhibited=false`)를 써야 합니다. Beluga가 배포할 Alertmanager 버전은 미정이므로 그 버전이 이 `main` 스펙에 부합하는지는 *not verified*입니다. 이전 초안이 인용한 `management_api` 문서 페이지는 API 레퍼런스가 아니므로 제거했습니다.
- Grafana Explore URL 형식 — <https://grafana.com/docs/grafana/latest/explore/> (2026-10-07 열람)은 딥링크 URL 스키마(`left=` / `panes=`)를 **문서화하지 않습니다**. 따라서 아래 URL 템플릿은 *not verified*이며 구현 전에 배포된 Grafana 버전으로 검증해야 합니다(과제 3).
- 아래에서 쓰는 PromQL 메트릭 이름(`node_namespace_pod_container:...:sum_irate`, `container_memory_working_set_bytes`, `kube_persistentvolumeclaim_resource_requests_storage_bytes`)은 kube-prometheus-stack / kube-state-metrics의 관례적 이름이며 해당 문서를 열지 않았으므로 *not verified*이고, 최종 배포되는 스택에 따라 달라집니다.

## 결정 동인(Decision Drivers)

1. **읽기 전용, 무중복**: Manager에 시계열이나 로그를 저장·색인하지 않으며 업스트림이 권위를 유지합니다.
2. **Degraded 우선**: 백엔드가 없을 때(오늘의 현실) 핵심 화면(Overview, Services, Pipelines)은 계속 동작하며 무엇이 없는지 알려야 합니다.
3. `Resource.cpuUsage`, `memoryUsage`, `logsUrl`, `Event`로의 **일관된 도메인 매핑**.
4. 도메인 리소스와 업스트림 텔레메트리 간의 **상관과 드릴다운**.
5. **마스킹과 접근 제어**: 로그와 알림 텍스트에는 비밀/PII가 있을 수 있고 API에는 현재 인증이 없습니다(현재 상태).

## 검토한 옵션(Considered Options)

### 옵션 1: Manager 내장 메트릭/로그 저장소
**기각**: 기록 원천을 복제하고, "No unnecessary duplication"(`docs/architecture.md`, Design Principles 3)과 충돌하며, 풋프린트가 큽니다.

### 옵션 2: 브라우저가 게이트웨이로 Prometheus/Loki를 직접 조회
**기각**: 통합 인가·마스킹을 우회하고 원시 백엔드를 브라우저에 노출합니다.

### 옵션 3: 딥링크 우선 + 선택적 임시 프록시를 갖춘 관측성 어댑터 계층 (제안)
1. **메트릭**: 어댑터가 시점 CPU/메모리와 알림 상태를 위해 Prometheus 즉시 쿼리를 읽습니다.
2. **로그**: 기본 경로는 Grafana Explore 딥링크(`Resource.logsUrl`)이며, 선택적 임시 tail 엔드포인트가 마스킹과 속도 제한 하에 Loki에서 최근 줄을 읽습니다.
3. **이벤트**: Kubernetes Events와 Alertmanager 알림을 `Event` 스키마로 정규화합니다.
4. **Degraded 상태**: 백엔드가 없으면 오류 대신 구조화된 degraded 응답을 반환합니다.
- **장점**: Manager에 저장소가 없음; 즉각적인 드릴다운; 중앙 마스킹.
- **단점**: 워크로드별 쿼리 템플릿 유지; 아직 존재하지 않는 백엔드 엔드포인트가 필요.
- **결과**: **제안**.

## 결정 결과(제안)

```mermaid
flowchart TD
    subgraph Browser["Manager Web UI"]
        OV["Overview KPI Cards"]
        Ops["Operations Timeline & Resource View"]
        Pipe["Pipelines & Services View"]
    end

    subgraph ManagerBackend["Beluga Manager Domain API"]
        ObsRouter["GET /api/v1/resources\nGET /api/v1/events\nGET /api/v1/resources/{id}/logs (제안)"]
        ObsAdapter["Observability Adapter Registry"]
        Redactor["PII & Secret Sanitizer"]
        DegradeH["Degraded Fallback Handler"]
    end

    subgraph PlatformOSS["백엔드 (현재 Beluga에 배포되어 있지 않음)"]
        Prom["Prometheus API\nInstant Vectors"]
        AM["Alertmanager API v2"]
        Loki["Loki API\nLogQL"]
        K8s["Kubernetes API\nCore v1 Events (존재)"]
        Grafana["Grafana Explore\nlogsUrl 대상"]
    end

    OV --> ObsRouter
    Ops --> ObsRouter
    Pipe --> ObsRouter
    ObsRouter --> ObsAdapter
    ObsAdapter --> DegradeH
    ObsAdapter -.-> Prom
    ObsAdapter -.-> AM
    ObsAdapter -.-> K8s
    ObsAdapter -.-> Loki
    Loki --> Redactor --> ObsRouter
    Ops -->|logsUrl 클릭| Grafana
```

이 다이어그램에서 현재 존재하는 것은 Kubernetes API뿐입니다.

### 1. 백엔드 현실과 단계

- **Phase 1(degraded 기반)**: 어댑터 인터페이스와 API 계약을 정의합니다. `PROMETHEUS_URL` / `LOKI_URL` / `ALERTMANAGER_URL`(제안 변수명)이 없거나 도달 불가이면 어댑터는 `status: "degraded"`, `cpuUsage: null`, `memoryUsage: null`을 보고하고 Operations 타임라인은 Kubernetes Events만 사용합니다(존재하는 유일한 백엔드).
- **Phase 2(Beluga가 스택을 배포한 이후 — 결정은 Beluga 레포 소관, Beluga 레포의 ADR-0003 Q5(`beluga/docs/adr/0003-beluga-data-platform-plane.md`; 본 레포의 ADR-0003(UI 디자인 ADR)이 아님))**: 어댑터는 그 배포가 노출하는 클러스터 내부 엔드포인트에 대해 활성화됩니다. 서비스 이름과 네임스페이스는 **미정**이며, 이전 초안의 `prometheus.monitoring.svc.cluster.local:9090` / `loki.monitoring.svc.cluster.local:3100`은 *제안 자리표시자일 뿐*입니다(`monitoring` 네임스페이스가 없음 — 현재 상태). 이 값은 설정에서 읽어야 하며 하드코딩하면 안 됩니다.

### 2. 메트릭 통합과 도메인 매핑 (제안)

| 도메인 엔티티 | 필드 | PromQL 패턴(예시; 메트릭 이름은 not verified) | 출력 |
|---|---|---|---|
| `Resource` (Workload/Pod) | `cpuUsage` | `sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace=~"$ns", pod=~"$pod.*"})` | 수량 문자열, 예: `"250m"` |
| `Resource` (Workload/Pod) | `memoryUsage` | `sum(container_memory_working_set_bytes{namespace=~"$ns", pod=~"$pod.*", container!=""})` | 예: `"512Mi"` |
| `Resource` (PVC) | `capacity` | `kube_persistentvolumeclaim_resource_requests_storage_bytes{...}` | 예: `"128Gi"` |

PromQL에 삽입되는 레이블 값은 이스케이프하거나 허용 목록으로 검증해야 합니다(쿼리 인젝션).

- **캐시와 예산(Proposed)**: 즉시 결과 TTL 15초, 쿼리당 타임아웃 1500ms(빠르게 실패하여 degraded로), 동시 페이지 로드가 업스트림 호출 하나를 공유하도록 쿼리 키별 single-flight, 전체 요청 데드라인, 동시성 상한, 유한 대기열. 모든 값은 *Proposed*이며 실제 백엔드로 조정해야 하고 측정한 것은 없습니다.

### 3. 로그 통합 (제안)

1. **Tier 1 — 딥링크(`logsUrl`)**: Grafana Explore URL로 채웁니다. 호스트와 URL 스키마는 **제안**입니다. `grafana.local.beluga.internal`은 Beluga 도메인 레지스트리(`AGENTS.md:16-18`, 현재 상태)에 없으므로 호스트는 설정에서 가져와야 하며, Explore 쿼리 파라미터 형식은 *not verified*입니다(외부 참고 자료). 검증 대상인 예시 형태일 뿐: `https://<grafana-host>/explore?<상태-파라미터>=...`에 데이터소스, LogQL 표현식(`{namespace="…",pod=~"…"}`), 시간 범위가 담깁니다.
2. **Tier 2 — 임시 tail 프록시** `GET /api/v1/resources/{id}/logs?lines=100&since=15m`: 최대 200줄, 최대 1시간 조회로 제한합니다(*Proposed*, 기본 100줄 / 15분, *Proposed*). 페이징·스트리밍 아카이브는 제공하지 않습니다. Domain API에는 현재 인증이 없으므로(`docs/IMPLEMENTATION-STATUS.md:30`), **실제 OIDC/JWT 검증과 리소스별 인가가 존재하기 전에는 이 엔드포인트를 배포하면 안 됩니다**(ADR-0006 0절과 같은 필수 선행 조건). 리소스 id는 서버 측 허용 목록 LogQL 템플릿에 매핑되어야 하며 클라이언트가 준 쿼리여서는 안 됩니다.

### 4. 마스킹 정책 (제안)

로그 줄이나 알림 텍스트가 API를 떠나기 전에 서버 측에서 적용합니다:
1. **자격 증명**: bearer 토큰/JWT, `password=` 형태의 쌍, 클라우드 액세스 키, `scheme://user:secret@host` URL을 마스킹합니다.
2. **PII**: 이메일 주소와 주민번호/카드번호 유사 패턴을 마스킹합니다. 패턴은 로케일 검토가 필요하고 미탐이 있으므로 마스킹은 보장이 아닌 심층 방어입니다.
3. **SQL 리터럴**: Trino/Airflow 로그의 `INSERT ... VALUES (...)` 파라미터를 잘라냅니다.

### 5. 이벤트 상관 (제안)

`packages/domain-api/src/schema/event.ts`(`severity: info|warning|error`, `source: kubernetes|service|job`)로의 매핑:
1. **Kubernetes Events**(`GET /api/v1/namespaces/{ns}/events`, core v1): `type: Normal` -> `info`, `Warning` -> `warning`; `source: "kubernetes"`; involved object는 해석 가능하면 `relatedResourceId`로(아니면 비움; 추측하지 않음).
2. **Alertmanager 알림**(위 OpenAPI에 따른 `GET /api/v2/alerts?silenced=false&inhibited=false`): 레이블 `severity="critical"` -> `error`, `severity="warning"` -> `warning`; `source: "service"`. 레이블 관례는 스택의 것이며 보장되지 않습니다.
3. **Safe Action 실행**(ADR-0006): 그런 조치가 존재하게 되면 `source: "job"` 또는 `"service"`의 이벤트로 발행합니다(ADR-0006의 선행 조건 이전에는 실행이 예정된 조치가 없음).

### 6. Degraded 동작 (제안)

```typescript
export interface ObservabilityHealthStatus {
  backend: "prometheus" | "loki" | "alertmanager" | "kubernetes";
  status: "available" | "unavailable" | "disabled";
  endpoint?: string;   // 인증되지 않은 호출자에게 내부 URL을 노출하지 않음
  lastChecked: string;
  message?: string;
}
```

- Prometheus 도달 불가/미설정: `GET /api/v1/resources`는 여전히 200이며 `cpuUsage: null`, `memoryUsage: null`, degraded 표시(헤더 `X-Beluga-Degraded: metrics-unavailable`, 제안 이름)와 0 대신 UI 배지를 제공합니다.
- Loki 도달 불가: `logsUrl`은 `null`이며 tail 엔드포인트는 안정적인 오류 코드와 함께 503을 반환합니다.

## 결과(Consequences)

### 긍정적
- Manager에 메트릭·로그 저장소가 없습니다.
- 오늘의 Beluga처럼 관측성 스택이 없는 클러스터에서도 동작합니다.
- 텔레메트리가 브라우저에 도달하기 전에 서버 측 마스킹과(선행 조건 충족 시) 인가가 적용됩니다.

### 부정적
- tail 보기는 짧으며 깊은 분석은 Grafana가 필요합니다.
- 딥링크는 아직 결정·검증되지 않은 Grafana 호스트와 URL 형식에 의존합니다.
- Beluga 레포가 스택을 배포하기 전에는 메트릭이 비어 있습니다.

## 고려한 대안(Alternatives Considered)

1. **Manager 내부 OpenTelemetry Collector** — 기각: Manager는 텔레메트리의 소비자이지 수집기가 아닙니다. (이전 초안의 "Beluga는 이미 Prometheus Operator, Promtail/Fluent Bit를 사용한다"는 주장은 거짓이었습니다. 현재 상태에 그런 CRD, 파드, 매니페스트가 없습니다.)
2. **`metrics-server`(`kubectl top`)만 단일 소스로 사용** — 단일 소스로는 채택하지 않음(*Proposed* 판단): 새 배포 없이 현재 CPU/메모리를 제공할 수 있어 Phase 1 후보입니다(현재 상태: `kubectl -n kube-system get deploy`에 `metrics-server 1/1`, `kubectl get apiservice v1beta1.metrics.k8s.io`가 `True`). 한계(이력·rate·네임스페이스 롤업·디스크/네트워크 메트릭 없음)는 문서에서 확인하지 않은 일반론이므로 *not verified*입니다.

## 위험과 완화(Risks and Mitigations)

| 위험 | 영향 | 완화(제안) |
|---|---|---|
| Prometheus 쿼리 증폭 | UI를 많이 쓰면 백엔드 과부하 | single-flight, 15초 캐시, 쿼리별 타임아웃, 전체 데드라인, 동시성 상한, 유한 대기열(값은 *Proposed*) |
| 로그/알림의 비마스킹 비밀 | 자격 증명 노출 | 서버 측 마스킹; tail 엔드포인트는 인증 필수; 기본적으로 원시 로그 보기 없음 |
| 인증 없는 API가 텔레메트리 노출 | API에 닿는 누구나 로그 열람 | 필수 선행 조건(3절) |
| Grafana 딥링크 깨짐 | 404 또는 빈 쿼리 | 출시 전에 배포된 Grafana로 URL 검증; 설정 기반 호스트 |
| 시간대 불일치 | 타임라인 불일치 | API는 UTC ISO-8601; UI에서 지역화 렌더링 |

## 열린 질문(Open Owner Questions)

1. **Beluga의 관측성 스택**: `kube-prometheus-stack`(및 로그 스택)을 배포할 것인가, 어느 네임스페이스/엔드포인트로?
   - *권고*: Beluga 레포에서 제기합니다(Beluga 레포의 ADR-0003 Q5(`beluga/docs/adr/0003-beluga-data-platform-plane.md`; 본 레포의 ADR-0003(UI 디자인 ADR)이 아님) / D8). 답이 나올 때까지 Phase 1은 degraded 우선을 유지합니다.
2. **Grafana 임베딩 vs 딥링크**.
   - *권고*: 외부 딥링크만 사용합니다. iframe은 CSP, 쿠키, SSO 문제를 일으킵니다(추론이며 Grafana 문서로 검증하지 않음).
3. **Phase 1에 tail 프록시를 둘 것인가?**
   - *권고*: Phase 2로 미루고 인증이 생긴 뒤에 합니다. Phase 1은 `logsUrl`과 Kubernetes Events만 제공합니다.
4. **스택이 생기기 전의 메트릭 소스**: 현재 클러스터에는 metrics-server가 동작 중입니다(대안 2번의 현재 상태).
   - *권고*: Phase 1에서 `cpuUsage`/`memoryUsage`용 metrics-server 기반 어댑터를 평가합니다(새 배포 불필요; 먼저 API 문서 확인 필요, not verified). Prometheus 어댑터는 Phase 2에 유지합니다.

## 후속 구현 과제 및 인수 테스트 아이디어

1. **어댑터 인터페이스와 헬스 프로브**. *인수*: 프로브가 실패해도 `Resource` 목록은 `cpuUsage: null`과 degraded 표시와 함께 200을 반환.
2. **Prometheus 즉시 쿼리 어댑터**(백엔드가 존재한 뒤에만 의미 있음). *인수*: 모의 서버 테스트에서 `"250m"`/`"512Mi"`로 변환, 설정된 한도에서 타임아웃, 동시 동일 쿼리를 업스트림 호출 하나로 합침.
3. **Grafana Explore URL 생성기** — 먼저 배포된 Grafana 버전으로 URL 형식을 검증합니다. *인수*: 검증된 형식의 URL 인코딩 단위 테스트; 호스트는 설정에서 가져옴.
4. **마스킹 유틸리티**. *인수*: JWT, 비밀번호 쌍, 이메일 주소가 포함된 샘플이 마스킹됨.
5. **Kubernetes Event 어댑터**. *인수*: `Warning` -> `warning`; 해석되지 않은 involved object는 `relatedResourceId`를 비워 둠.
6. **Alertmanager 어댑터**(백엔드가 존재한 뒤). *인수*: 요청이 `silenced=false&inhibited=false`를 사용하며 severity 레이블이 명세대로 매핑됨.
