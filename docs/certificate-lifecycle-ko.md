# 인증서 수명주기, 갱신 및 만료 통제 (제안)

[English](certificate-lifecycle.md) | 한국어

이슈 [#47](https://github.com/dasomel/beluga/issues/47) ("Establish certificate lifecycle, renewal, and expiry controls") 관련.

> **상태: 제안. 문서만 변경.** 이 문서는 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않습니다. 저장소에 대한 모든 서술은
> 커밋 `9f74c2b`에서 읽은 `file:line`을 가집니다. 라이브 클러스터에 대한 서술은 2026-10-07에 실행한 읽기 전용 `kubectl` 명령
> ([2.3절](#23-라이브-상태-2026-10-07-실측))에서 나왔거나 **라이브 미검증**으로 표시했습니다. 외부 사실은 [출처](#출처)(접근일 2026-10-07)를 인용하며,
> 공식 권고를 찾지 못한 경우 그렇게 적었습니다. **제안**으로 표시한 수치는 저장소/업스트림 근거가 없으므로 소유자 결정이 필요합니다.

관련 문서: [`docs/development.md`](development.md) (인증서 인벤토리 게이트), [`docs/privileged-access-inventory.md`](privileged-access-inventory.md),
[`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (C03 행), [`docs/environment-profiles.md`](environment-profiles.md) (보안 프로파일 preflight 설계).

## 1. 목적과 이슈 매핑

이슈 #47은 발급, 갱신, 신뢰 배포, 만료 모니터링, 통제된 교체를 포괄하는 인증서 수명주기를 요구합니다. 이슈 배경은 `VERSIONS.md`가 cert-manager를
미설치로 기록한다고 적지만 **이는 오래된 내용**입니다. `VERSIONS.md:18`은 cert-manager 1.21.1을 기재하고, `scripts/gitops/01-argocd-bootstrap.sh:295-300`이 설치하며,
라이브 클러스터에서 cert-manager 파드 3개가 실행 중이었습니다(2.3). 따라서 남은 간극은 "cert-manager 부재"가 아니라 운영 영역(라이브 증거, 알림, CA 회전, cert-manager 외 인증서)입니다.

## 2. 현재 상태 (검증됨)

### 2.1 저장소가 정의하는 것

| 영역 | 사실 | 출처 |
|---|---|---|
| 설치 | SHA-256 검증된 릴리스 매니페스트로 cert-manager v1.21.1 적용 | [`01-argocd-bootstrap.sh:295-300`](../scripts/gitops/01-argocd-bootstrap.sh#L295-L300), [`VERSIONS.md:18`](../VERSIONS.md#L18) |
| 발급자 모델 | 자체서명 부트스트랩 `ClusterIssuer` -> CA `Certificate` `beluga-internal-ca`(isCA, RSA 2048, duration 8760h, renewBefore 2920h) -> CA `ClusterIssuer` `beluga-internal-ca-issuer`. 파일은 외부 ACME 발급자가 불필요하다고 명시 | [`cert-manager-issuer.yaml:1-4`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L1-L4), [`:11-18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L11-L18), [`:21-38`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L21-L38), [`:44-51`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L44-L51) |
| 리프 인증서 | 게이트웨이 와일드카드, Trino 코디네이터(PKCS12 키스토어 포함), OpenLDAP, Kafka OAuth 신뢰 인증서: 모두 `duration: 2160h`, `renewBefore: 720h`, 발급자 `beluga-internal-ca-issuer` | [`apisix-gateway.yaml:247-265`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L265), [`06-trino.yaml:124-150`](../gitops/charts/beluga-data/templates/06-trino.yaml#L124-L150), [`openldap.yaml:34-52`](../gitops/charts/beluga-platform/templates/openldap.yaml#L34-L52), [`03-strimzi-kafka.yaml:380-394`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L380-L394) |
| Kafka OAuth 신뢰 인증서 | `strimzi.oauthListener`가 true일 때만 렌더링 | [`03-strimzi-kafka.yaml:373`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L373) (닫는 `end`는 `:395`) |
| Kafka 리스너 TLS | 내부 `plain` 리스너는 `strimzi.listenerTls`를 설정하지 않으면 `tls: false` | [`03-strimzi-kafka.yaml:64-67`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L64-L67) |
| CA 신뢰 배포 | Sync 훅 Job이 `ca.crt`를 `iam`, `analytics`, `orchestration`, `lakehouse`의 ConfigMap `beluga-internal-ca`로 복사하며, `ca.crt`를 현재 CA 하나로 덮어씀 | [`internal-ca-distribution.yaml:25`](../gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml#L25), [`:87-96`](../gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml#L87-L96) |
| 정적 인벤토리 게이트 | `check-certificate-inventory.py`가 `make validate`에서 실행([`Makefile:84`](../Makefile#L84)): 모든 TLS 참조는 명시적 `duration`/`renewBefore`를 가진 cert-manager Certificate가 필요하고, `renewBefore < duration`이며, 인라인 TLS Secret 데이터는 금지. 라이브 만료, 갱신/리로드, CA 재배포, 알림, 잘못된 인증서 동작은 검증하지 **않는다**고 명시 | [`development.md:149-206`](development.md#L149-L206) |
| Fail-closed 신뢰 테스트 | 라이브 테스트가 내부 CA 없는 HTTPS를 거부(`-k` 미사용)하고 `--cacert`로 체인을 검증 | [`tests/10-tls-identity-boundary.sh:1-12`](../tests/10-tls-identity-boundary.sh#L1-L12) |
| 만료 점검 | `scripts/`, `tests/`, `Makefile`, `.github/`에서 `notAfter`, `checkend`, `enddate`, `renewalTime` 검색: 일치 없음. **해당 경로에는 만료 preflight나 릴리스 점검이 없다** | 이 커밋 기준 검색 |
| 알림 | `prometheusGrafana.enabled: true`는 NodePort Service `grafana-external`만 렌더링. `gitops/`, `scripts/`에서 `prometheusGrafana`, `kube-prometheus`, `prometheus-community` 검색: Prometheus/Grafana 워크로드를 배포하는 매니페스트 없음 | [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22), [`platform-services.yaml:8-23`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L23) |

### 2.2 cert-manager로 발급하지 않는 인증서

| 인증서 | 발급자 / 컨트롤러 | 저장소 근거 |
|---|---|---|
| PostgreSQL 서버/복제 인증서 | CloudNativePG 오퍼레이터 CA(매니페스트에 `spec.certificates` 없음) | [`02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml): `tls`, `ssl`, `cert`를 대소문자 구분 검색: 일치 없음; 오퍼레이터 기본값 적용 |
| Kafka 클러스터/클라이언트 CA 및 브로커 인증서 | Strimzi 생성(Kafka spec에 `clusterCa`/`clientsCa` 없음; 라이브 spec도 비어 있음) | [`03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml): `clusterCa`, `clientsCa`, `generateCertificateAuthority`, `validityDays`, `renewalDays` 검색: 없음 |
| Kubernetes API 서빙/클라이언트 인증서 | k3s | [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32)로 설치, 인증서 플래그 없음 |
| Hubble, CNPG 웹훅 | Cilium CA / CNPG 웹훅 CA | 라이브에서만 관찰 |

### 2.3 라이브 상태 (2026-10-07 실측)

명령: `kubectl get certificate -A -o custom-columns=...`, `kubectl get clusterissuer,issuer -A`, `kubectl get pods -n cert-manager`,
`kubectl get secret -A --field-selector type=kubernetes.io/tls`, 선택한 Secret의 **공개** `tls.crt`/`ca.crt`에 `openssl x509 -noout -subject -issuer -dates`
(개인 키는 읽지 않음). 서버 시계 `date -u`: 2026-10-07T14:06Z; 클러스터 생성 후 3일 6시간.

| 인증서 (라이브) | 발급자 | duration / renewBefore | notAfter | renewalTime |
|---|---|---|---|---|
| `cert-manager/beluga-internal-ca` (CA) | `selfsigned-bootstrap` | 8760h / 2920h | 2027-10-04 | 2027-06-04 |
| `analytics/trino-coordinator-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |
| `iam/openldap-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |
| `platform-system/apisix-gateway-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |

| cert-manager 외 (관찰) | notAfter | 관찰된 유효기간 |
|---|---|---|
| `database/postgres-main-server`, `-replication`, CNPG CA (Cluster `status.certificates.expirations`) | 2027-01-02 | 90일 |
| `cnpg-system/cnpg-webhook-cert` | 2027-01-02 | 90일 |
| Strimzi 클러스터 CA 및 클라이언트 CA (`CN=cluster-ca v0`, `clients-ca v0`) | 2027-10-04 | 365일 |
| `kube-system/k3s-serving` | 2027-10-04 | 365일 |
| `kube-system/hubble-server-certs` (Cilium CA) | 2027-10-04 | 365일 |

기타 라이브 사실: ClusterIssuer `selfsigned-bootstrap`, `beluga-internal-ca-issuer` Ready("Signing CA verified"); ConfigMap `beluga-internal-ca`가 위 네 네임스페이스에 존재;
`cert-manager` 파드는 Running이나 재시작 있음(controller 35, cainjector 242, webhook 2; 원인은 **조사하지 않음**);
`monitoring.coreos.com` CRD 0개; Prometheus/Grafana 파드 없음, 단 Service `grafana-external`은 존재; `beluga-kafka-oauth-ca` Secret 없음(`oauthListener` off와 일치).
**이 클러스터에서 갱신이 한 번도 일어나지 않았으므로**(인증서 생성 3일 경과) 갱신, 리로드, CA 재신뢰는 **라이브 미검증**입니다.

### 2.4 사용한 업스트림 사실

- cert-manager: 기본 `spec.duration` 90일; 기본 갱신 시점은 유효기간의 2/3 경과 시(즉 1/3 잔여); 최소 duration 1시간, 유효 `renewBefore` 최소 5분;
  v1.18.0부터 기본 `privateKey.rotationPolicy`는 `Always`; 수동 갱신은 `cmctl renew` [S1].
- k3s: 클라이언트/서버 인증서 유효기간 365일, k3s 시작 시 만료되었거나 만료 120일 이내이면 갱신(2025년 5월 이전 릴리스는 90일); CA는 10년 유효, 자동 갱신 없음;
  `k3s certificate rotate`, `rotate-ca`, `check` 제공 [S2].
- CloudNativePG: 오퍼레이터 생성 인증서 유효기간 90일, 만료 7일 전 무중단 갱신; 사용자가 제공한 서버/클라이언트 인증서는 사용자가 재발급해야 함 [S3].
- cert-manager 인증서 만료 메트릭 이름: 읽은 메트릭 페이지에는 Venafi 메트릭만 있고 서드파티 mixin을 가리킴; **공식 인증서 만료 알림 권고는 찾지 못함** [S4].
- Strimzi CA `validityDays`/`renewalDays` 기본값: **미검증**(읽은 구간에 스키마가 없었음); 라이브 CA 유효기간은 365일(2.3).

## 3. 수락 기준 대비 간극

| 수락 기준 | 상태 | 이유 |
|---|---|---|
| 모든 프로덕션 TLS 엔드포인트의 인벤토리 | **부분** | cert-manager Certificate의 정적 인벤토리는 있으나 저장되지 않음([`development.md:149-206`](development.md#L149-L206)); 소유자/목적 필드 없음; CNPG, Strimzi, k3s, Cilium 인증서는 미포함; "프로덕션 프로파일"은 아직 정의되지 않음(환경 프로파일 문서 참조) |
| 갱신이 자동 또는 반복 가능하며 만료 전 테스트됨 | **부분** | cert-manager는 설계상 자동 갱신 [S1]; 갱신이 실행된 적 없고 강제 갱신 테스트도 없음 |
| 만료 알림이 실행 가능 | **미충족** | 모니터링 스택 미배포; 알림 규칙 없음; preflight/릴리스에 만료 점검 없음 |
| 매니페스트 수동 편집 없는 회전 | **부분(CA)** | 리프 회전은 매니페스트 편집 불필요. CA 신뢰 배포는 단일 CA로 덮어쓰는 1회성 Sync 훅 Job이라 CA 키 회전에 중첩 구간이 없음(분석이며 테스트하지 않음) |
| 잘못된/만료 인증서가 fail closed | **부분** | 신뢰되지 않는 CA 거부는 라이브 테스트됨(`tests/10`); 만료 및 호스트명 불일치 사례는 테스트 없음 |
| 보안 프로파일 검증이 신뢰 체인 배포를 확인 | **미충족** | 인벤토리 게이트는 발급자/호스트를 정적으로만 비교; ConfigMap 내용이나 체인의 라이브 점검 없음 |

## 4. 제안 (모든 항목은 제안)

### 4.1 인증서 분류, 발급자, 신뢰 경계

| 분류 | 예 | 발급자 (제안) | 신뢰 배포 | 만료 출처 |
|---|---|---|---|---|
| C1 외부 게이트웨이 리프 | `apisix-gateway-tls` | 개발: 내부 CA(현행). 프로덕션: 소유자가 기업 CA 또는 공인 CA 선택(**소유자 결정 D1**) | 클러스터 외부 클라이언트는 CA 체인 필요; 현재는 `ca.crt`를 별도 경로로 전달 | `Certificate.status.notAfter` |
| C2 내부 서비스 리프 | Trino, OpenLDAP, Kafka OAuth 신뢰 | 내부 CA | 소비 네임스페이스별 ConfigMap `beluga-internal-ca` | 동일 |
| C3 내부 CA | `beluga-internal-ca` | cert-manager 자체서명 부트스트랩(현행); 프로덕션 루트 보관은 **D2** | 동일 ConfigMap, 회전 중에는 신/구 CA를 함께 담아야 함(4.3) | 동일 |
| C4 Kafka CA | Strimzi 클러스터/클라이언트 CA | Strimzi | Strimzi Secret | Secret `ca.crt`에 `openssl`(라이브) |
| C5 PostgreSQL | CNPG 서버/복제 | CNPG ([S3]에 따라 cert-manager 가능; **D3**) | CNPG Secret | Cluster `status.certificates.expirations` |
| C6 Kubernetes API | k3s | k3s | kubeconfig | `k3s certificate check` [S2] |
| C7 메시/오퍼레이터 | Hubble, CNPG 웹훅 | 각 컨트롤러 | 내부 | 관찰 |

행마다 기록할 인벤토리 필드: 소유자, 목적, 발급자, SAN 목록, notAfter, 갱신 방식, 소비자. 저장소 게이트는 이미 발급자, SAN, 수명, 소비자를 출력합니다.
**제안**: 게이트 출력 소스에 `owner`와 `purpose`를 필수 필드로 추가하고, C4-C7은 수기 관리 항목으로 표를 확장.

### 4.2 만료 신호와 임계값

인벤토리의 모든 인증서에 세 신호를 평가: (a) `Ready != True`; (b) 갱신 지연: 현재 시각 > `status.renewalTime` + 유예 시간; (c) `notAfter`까지 남은 일수가 하한 미만.
유예와 하한은 **공식 권고 없음** [S4]; **제안**: 90일 리프는 유예 24시간, 하한 14일; 365일 인증서는 하한 60일(소유자 결정 **D4**).
전달 방식은 **D5**(모니터링 스택)에 달려 있음: Prometheus 스택이 있으면 cert-manager 메트릭에 알림 규칙(메트릭 이름은 실행 중인 컨트롤러의 `/metrics`에서 확인, 포트 9402는 [S4]);
없으면 읽기 전용 `kubectl` 보고 스크립트가 유일한 수단.

### 4.3 회전과 CA 신뢰

- 리프 갱신: cert-manager 자동 갱신에 의존 [S1]; 제안 테스트는 폐기 가능 클러스터에서 **강제** 갱신(`cmctl renew`) 후 라이브 TLS 점검.
- 소비자 리로드: 소비자(APISIX, Trino, OpenLDAP, CNPG)별로 갱신된 Secret 내용을 재시작 없이 반영하는지 기록; 어느 것도 **라이브 미검증**.
- CA 회전: 덮어쓰기 동작을 발급자 전환 전에 배포되는 신뢰 **번들**(신/구 `ca.crt`)로 대체하고, 모든 리프가 새 CA로 체인된 뒤에만 구 CA 제거. 재배포는 ArgoCD Sync뿐 아니라 CA 갱신 시에도 실행되어야 함(훅은 `internal-ca-distribution.yaml:25`). 설계만.
- Fail closed: 라이브 TLS 테스트 집합에 부정 테스트(만료 리프, 잘못된 호스트명, 잘못된 CA) 추가.

## 5. 검증 및 테스트 아이디어

1. 정적: 게이트가 owner/purpose 어노테이션이 없는 Certificate를 거부(제안된 스키마 변경 후); 픽스처 기반, `make validate`에서 실행.
2. 라이브 읽기 전용: `kubectl get certificate -A` 및 Secret `tls.crt` 날짜 파싱; 하한(D4) 미만 잔여 또는 `Ready != True`이면 실패.
3. 폐기 가능 클러스터에서 라이브 강제 갱신: 게이트웨이 인증서 갱신 후 `--cacert` HTTPS 검증이 유지되고 notAfter가 증가함을 확인.
4. 폐기 가능 클러스터에서 CA 회전 훈련: `beluga-internal-ca` 회전, ConfigMap이 두 CA를 담는지 확인, 모든 리프 재발급, 구 CA 제거; `tests/10`에서 핸드셰이크 실패 없음.
5. 부정: 만료된 인증서 제공(cert-manager `duration` 최소 1시간 [S1]이므로 단기 테스트 인증서 생성 가능) 후 클라이언트가 실패함을 확인.

## 6. 남은 소유자 결정

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 외부 게이트웨이 인증서의 프로덕션 발급자(기업 CA, 공인 CA, 내부 CA만) | C1은 기업/공인 CA, C2는 내부 CA 유지; 프로파일 정의 후 결정 |
| D2 | 내부 루트 보관(현재 클러스터 Secret) | 비프로덕션은 유지; 프로덕션은 오프라인/HSM 기반 루트 여부 결정 필요 |
| D3 | CNPG 인증서를 cert-manager 아래로 이동할지 [S3] | CNPG 기본값(90일, 자동 갱신) 유지 후 모니터링 |
| D4 | 알림 하한 및 유예 값 | 90일 리프 14일/24시간, 365일 인증서 60일 |
| D5 | 모니터링 스택(Prometheus/Alertmanager) vs 스크립트 전용 보고 | 이슈 #44/#45/#35와 함께 결정; 스택 권장 |
| D6 | 인벤토리를 릴리스 증거로 저장할지 | 예, 릴리스 증거 번들에 포함 |

## 7. 후속 구현 작업 (순서대로)

1. 종료 코드를 가진 읽기 전용 라이브 만료 보고 스크립트(kubectl만) 추가; 수락: 하한 미만 인증서에서 exit 1, 픽스처 JSON으로 테스트.
2. 인벤토리에 `owner`/`purpose` 필드를 추가하고 C4-C7로 확장; 수락: 필드 누락 시 게이트 실패(부정 픽스처).
3. 라이브 TLS 테스트에 만료 인증서 및 호스트명 불일치 사례 추가; 수락: 둘 다 fail closed.
4. 소비자별 강제 갱신 및 리로드 테스트; 수락: 소비자별 결과 기록.
5. 신뢰 번들 배포 설계 및 훈련(4.3); 수락: 핸드셰이크 실패 없는 CA 회전.
6. D5 결정 후 알림 규칙; 수락: 하한 미만 테스트 인증서가 알림을 발생.
7. 이슈를 갱신할 때 오래된 배경 서술(cert-manager가 설치됨)을 정정.

## 출처

모두 2026-10-07 접근.

| ID | 출처 |
|---|---|
| S1 | cert-manager, Certificate resource: https://cert-manager.io/docs/usage/certificate/ |
| S2 | K3s, Certificate management: https://docs.k3s.io/cli/certificate |
| S3 | CloudNativePG v1.30.0, Certificates: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/certificates.md |
| S4 | cert-manager, Prometheus metrics: https://cert-manager.io/docs/devops-tips/prometheus-metrics/ |
