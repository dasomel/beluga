# 시간 동기화 및 신뢰 가능한 이벤트 타임스탬프 (제안)

[English](time-synchronization.md) | 한국어

이슈 [#45](https://github.com/dasomel/beluga/issues/45) ("Establish platform time synchronization and trusted event timestamps") 관련.

> **상태: 제안. 문서만 변경.** 이 문서는 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않습니다. 저장소에 대한 모든 서술은
> 커밋 `9f74c2b`에서 읽은 `file:line`을 가집니다. 라이브 클러스터에 대한 서술은 2026-10-07에 실행한 읽기 전용 `kubectl` 명령
> ([2.2절](#22-라이브-상태-2026-10-07-실측))에서 나왔거나 **라이브 미검증**으로 표시했습니다. 노드 셸 접근(`vagrant ssh`)은 의도적으로 사용하지 않았으므로 노드 수준 시간 동기화 상태는 **측정하지 못했습니다**.
> 외부 사실은 [출처](#출처)(접근일 2026-10-07)를 인용합니다. **제안** 또는 **소유자 결정**으로 표시한 수치는 저장소/업스트림 근거가 없습니다.

관련 문서: [`docs/audit-retention.md`](audit-retention.md) (이슈 #35, 보존 증거의 시간 요구),
[`docs/privileged-access-logging.md`](privileged-access-logging.md) (이슈 #44), [`docs/certificate-lifecycle.md`](certificate-lifecycle.md) (이슈 #47, 유효기간은 시계에 의존),
[`docs/environment-profiles.md`](environment-profiles.md).

## 1. 목적과 이슈 매핑

이슈 #45는 승인된 시간 소스, 노드 동기화, 허용 편차, 드리프트 탐지와 알림, 문서화된 타임스탬프 및 시간대 규약, preflight/릴리스 시계 점검을 요구합니다.
이 문서는 저장소와 라이브 클러스터가 보여 주는 것을 기록하고 기준선을 제안합니다.

## 2. 현재 상태 (검증됨)

### 2.1 저장소가 정의하는 것

| 영역 | 사실 | 출처 |
|---|---|---|
| 시간 동기화 설정 | `Vagrantfile`, `scripts/`, `gitops/`, `tests/`, `policies/`, `docs/*.md`에서 (대소문자 무시) `chrony`, `ntp`, `timesyncd`, `timedatectl`, `clock skew`, `clock drift`, `time sync`, `leeway`, `timezone`, `TZ`, `log_timezone`, `default_timezone`, `local-time-zone` 검색: **설정 일치 없음**(Python `datetime.timezone` 사용과 argparse 잡음만). 해당 경로에서 저장소는 시간 소스, 데몬 설정, 편차 임계값을 선언하지 않음 | 이 커밋 기준 검색 |
| 노드 이미지 | VM 박스 `dasomel/ubuntu-26.04-xfs`; 시간 동기화 동작은 이 저장소가 아니라 이미지에 달려 있음 | [`Vagrantfile:51`](../Vagrantfile#L51) |
| k3s 시작 | k3s는 시간 관련 옵션 없이 설치됨 | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| 워크로드 시간대 | 클러스터의 어떤 파드도 `TZ` 환경 변수를 설정하지 않음(라이브, 2.2) | 라이브 |
| 코드의 타임스탬프 규약 | 두 Python 도구가 이미 `Z` 접미사의 UTC를 출력: 운영 에이전트와 리서치 증거 기록기 | [`operations_agent.py:96`](../scripts/agent/operations_agent.py#L96), [`record-evidence.py:117`](../scripts/research/record-evidence.py#L117) |
| 스케줄 시간 기준 | PostgreSQL 백업 cron은 UTC(02:00)로 문서화됨 | [`02-cnpg.yaml:79-81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L79-L81) |
| 릴리스 증거 | `scripts/release/evidence_bundle.py`에서 (대소문자 무시) `time`, `date`, `SOURCE_DATE` 검색: 무관한 일치만; 번들 빌더에서 타임스탬프나 신뢰 시간 필드를 찾지 못함 | search on this commit |
| 시계 의존 기능 | cert-manager 유효기간(인증서 문서 참조), Keycloak OIDC 토큰, CNPG/Kafka/Flink 타임아웃은 모두 일관된 시계에 의존; 이 저장소에는 허용 오차가 설정되어 있지 않음 | 분석, 저장소 설정 없음 |
| 모니터링 | 이 저장소에서 배포되는 Prometheus/Grafana 워크로드 없음; [`certificate-lifecycle.md`](certificate-lifecycle.md) 2.1절 참조 | [`platform-services.yaml:8-23`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L23) |

### 2.2 라이브 상태 (2026-10-07 실측)

| 측정 | 명령 | 결과 |
|---|---|---|
| 노드 | `kubectl get nodes -o wide` | 노드 4개(`master-1`, `worker-1..3`), Ubuntu 26.04 LTS, 커널 7.0.0-22-generic |
| API 서버 시계 vs 운영자 워크스테이션 | `date -u`, `kubectl get --raw /readyz -v=9`(응답 `Date` 헤더), 다시 `date -u` | 워크스테이션 14:13:17Z / API 서버 `Date: ... 14:13:18 GMT` / 워크스테이션 14:13:18Z: 헤더 해상도 1초 내에서 일치. 워크스테이션은 플랫폼 노드가 **아니며** 자체 동기화 상태는 미상 |
| 노드 Lease renewTime | `kubectl get lease -n kube-node-lease -o custom-columns=...` | 네 노드 모두 renewTime이 샘플 5-8초 전(`leaseDurationSeconds` 40) |
| 파드 시간대 env | `TZ`에 대한 `kubectl get pods -A -o jsonpath` | 76개 파드 중 설정한 것 없음 |
| 노드별 동기화 데몬과 오프셋 | `kubectl`로 측정 불가 | **라이브 미검증** |

이 측정이 증명하는 것: API 서버 호스트와 관찰자 사이에 Lease 주기(약 10초)를 넘는 큰 드리프트가 지금은 없습니다. 증명하지 **않는** 것: 노드 간 1초 미만 편차, 동기화 데몬, 설정된 소스, 드리프트 이력.
Lease/`Date` 점검은 초 단위 해상도이며 편차 측정이 아닙니다.

### 2.3 사용한 업스트림 사실

- JWT(RFC 7519 4.1.4, 4.1.5절): 구현자는 시계 편차를 고려해 "some small leeway, usually no more than a few minutes"를 둘 수 있음(MAY) [S1]. Beluga의 OIDC 흐름에 적용되는 표준의 유일한 편차 수치이며 목표가 아니라 허용 오차입니다.
- RFC 3161: 타임스탬프 서비스는 데이터가 특정 시점 이전에 존재했다는 증명을 지원; 타임스탬프 기관(TSA)에 대한 요청/응답을 정의 [S2].
- Prometheus node_exporter에는 `timex`(adjtimex 통계, 기본 활성, Linux)와 `time` 수집기가 있음 [S3]. 읽은 README 표에는 메트릭 이름이 없으므로 실행 중인 exporter에서 확인해야 합니다.
- 26.04의 Ubuntu 기본 시간 동기화 데몬: **미검증**(가져올 때 공식 페이지를 사용할 수 없었음, HTTP 503) [S4].
- 감사, 추적, SLA 상관관계의 허용 편차: 읽은 출처에서 **공식 권고를 찾지 못함**.

## 3. 수락 기준 대비 간극

| 수락 기준 | 상태 | 이유 |
|---|---|---|
| 승인된 시간 소스와 동기화 정책 문서화 | **미충족** | 저장소에 소스나 정책 없음(2.1) |
| 노드 시계 편차가 측정 가능하며 정의된 임계값 이내 | **미충족** | 임계값 미정의; 노드별 오프셋 미측정(2.2); 수집기 미배포 |
| 과도한 드리프트가 운영 알림을 발생 | **미충족** | 모니터링 스택과 규칙 없음 |
| 보안/감사 증거가 문서화된 타임스탬프 규약을 사용 | **부분** | 두 도구가 UTC `Z`를 출력(2.1); 로그, 증거, 표시를 아우르는 서면 규약 없음 |
| Preflight가 허용할 수 없는 시간 편차를 탐지 | **미충족** | 검색한 preflight/validate 경로에 시계 점검 없음 |

## 4. 제안 (모든 항목은 제안)

### 4.1 시간 소스와 노드 정책

- 권위 있는 소스: 조직이 승인한 NTP 소스 목록과 대체 소스; 목록 자체는 **소유자 결정 D1**(여기서 소스를 선택하지 않음).
- 노드와 지원 VM은 OS 시간 데몬으로 승인된 목록에 동기화; 설정을 쓰기 전에 **이미지가 어떤 데몬을 제공하는지 확인**(S4 사용 불가).
- 클러스터 내 워크로드는 노드 시계를 상속; 파드별 시간 데몬 없음.
- API 서버 호스트와 모든 노드를 같은 목록에 두어 노드 간 편차가 서로 다른 소스가 아니라 데몬으로 한정되도록 함.

### 4.2 편차 임계값 (소유자 값)

| 임계값 | 목적 | 값 |
|---|---|---|
| 노드 오프셋 경고 / 위험 | 감사 및 추적 상관관계 | **소유자 결정 D2**, 후속 작업 1의 기준선 측정 후 선택 |
| 토큰 leeway 대비 상한 | OIDC 검증 | 애플리케이션이 설정한 JWT leeway보다 충분히 작아야 함(표준 표현은 수 분 [S1]); 애플리케이션의 실제 leeway는 **미검증** |
| 알림 전 드리프트 지속 시간 | 깜빡임 방지 | **소유자 결정 D3** |

### 4.3 탐지

권장: Prometheus 스택이 수집하는 node_exporter `timex` 수집기 [S3]로 오프셋과 동기화 상태에 알림(메트릭 이름은 실행 중인 exporter에서 확인). 모니터링 스택 결정(D4)이 필요합니다.
스택이 없으면: 승인된 채널로 각 노드의 동기화 상태를 읽는 운영자 측 preflight 스크립트(이 제안의 조사에서는 노드 접근을 사용하지 않음). kubectl만 쓰는 점검(API `Date` 헤더 대 Lease `renewTime`)은 초 단위의 큰 드리프트만 탐지할 수 있으며 그렇게 표기해야 합니다.

### 4.4 타임스탬프 규약

**제안**: 기계가 작성하는 모든 증거와 로그는 UTC, `Z` 접미사의 RFC 3339 / ISO 8601, 최소 밀리초 정밀도를 사용(기존 두 도구가 이미 그렇게 함, 2.1); 스케줄은 UTC로 문서화;
사람용 표시는 로컬 시간대를 쓸 수 있으나 시간대를 표시해야 함; 모든 감사 레코드는 소스 호스트 시계 값과 상관 ID를 포함(이슈 #44, #35와 공유).

### 4.5 증거용 신뢰 타임스탬프

보존 증거(이슈 #35)에는 외부 신뢰 타임스탬프가 선택 사항: 증거 매니페스트 해시에 대한 RFC 3161 TSA 토큰 [S2]. 조직에 필요한지와 어떤 TSA를 쓸지는 **소유자 결정 D5**이며, 없으면 증거 시간은 플랫폼 자체 시계와 오브젝트 스토어 보존 시계에 의존합니다.

## 5. 검증 및 테스트 아이디어

1. 기준선: 폐기 가능 클러스터에서 승인된 채널로 정해진 기간 동안 각 노드의 `chronyc tracking` 상당 오프셋 기록; 수락: 관찰된 오프셋 표.
2. 폐기 가능 클러스터에서 편차 주입: 한 노드의 시계를 알려진 양만큼 이동시키고 (a) 알림이 발생하고 (b) preflight가 실패함을 단언.
3. 토큰 허용 오차: 설정된 OIDC leeway 바로 아래와 바로 위 편차에서 각각 로그인 성공과 실패를 단언.
4. 규약 점검: 새 증거 생성 스크립트가 UTC `Z` 타임스탬프를 출력하는지 정적 테스트(grep 기반 픽스처).
5. 릴리스 preflight: 시계 보고 입력이 임계값을 초과하는 부정 픽스처가 0이 아닌 코드로 종료.

## 6. 남은 소유자 결정

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 승인된 시간 소스와 대체 소스 | 조직 내부 NTP가 있으면 사용; 없으면 소유자가 정하는 공개 풀 |
| D2 | 오프셋 경고/위험 임계값 | 먼저 기준선을 측정(작업 1)한 후 감사 상관관계 요구를 고려해 선택 |
| D3 | 알림 전 드리프트 지속 시간 | 단계적 변화를 잡을 만큼 짧게; 값은 기준선 이후 |
| D4 | 모니터링 스택 vs 스크립트 전용 탐지 | 스택, 인증서·감사·권한 접근 알림과 공유 |
| D5 | 증거용 RFC 3161 신뢰 타임스탬프 | 감사 보존 결정 이후로 연기; 나중에 추가하는 비용이 낮음 |
| D6 | UTC `Z`/밀리초를 서면 규약으로 | 수용 |

## 7. 후속 구현 작업 (순서대로)

1. 승인된 절차로 노드별 동기화 데몬, 소스, 오프셋을 측정하고 문서화; 수락: 노드별 명령과 출력을 담은 표.
2. 규약(4.4)을 짧은 규범 문서로 작성하고 증거 문서에서 링크; 수락: docs-check 통과, 쌍 존재.
3. D4 결정 후 오프셋/동기화 상태 규칙 추가; 수락: 편차 주입 테스트 5.2.
4. 부정 픽스처를 포함한 preflight 시계 점검 추가; 수락: 테스트 5.5.
5. 애플리케이션(Keycloak, Lakekeeper, Trino, Superset, Airflow)의 실제 토큰 leeway 확인; 수락: 값 표와 테스트 5.3.
6. 증거 번들용 선택적 TSA 단계(D5).

## 출처

모두 2026-10-07 접근.

| ID | 출처 |
|---|---|
| S1 | RFC 7519, JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519.html |
| S2 | RFC 3161, Time-Stamp Protocol: https://www.rfc-editor.org/rfc/rfc3161.html |
| S3 | Prometheus node_exporter README (collectors): https://github.com/prometheus/node_exporter |
| S4 | Ubuntu Server docs, chrony: https://ubuntu.com/server/docs/how-to/networking/serve-ntp-with-chrony/ (가져올 때 HTTP 503; 읽지 못함) |
