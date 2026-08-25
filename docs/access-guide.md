# Beluga 서비스 접근 가이드

Beluga 데이터 플랫폼의 서비스 접근 URL, DNS 설정, kubectl 접근 방법, 인증 정보 및 트러블슈팅 절차를 정리한다.

> **Vagrant 로컬 환경 기준**: APISIX 게이트웨이 + MetalLB LoadBalancer 기반으로 모든 서비스가 `*.local.beluga.internal` 도메인, **포트 80**으로 통일 접근된다.

---

## 1. 네트워크 구성

| 구성요소 | IP | 설명 |
|----------|-----|------|
| Master-1 | `192.168.77.10` | 컨트롤플레인, dnsmasq DNS 서버 (`:53`) |
| Worker-1 | `192.168.77.21` | 데이터 워크로드 (DNS: Master-1 포워딩 / split-DNS) |
| Worker-2 | `192.168.77.22` | 데이터 워크로드 (DNS: Master-1 포워딩 / split-DNS) |
| Worker-3 | `192.168.77.23` | 데이터 워크로드 (DNS: Master-1 포워딩 / split-DNS) |
| MetalLB VIP | `192.168.77.200` | APISIX LoadBalancer IP |

### DNS 해석 아키텍처
- **dnsmasq (Master-1)**: `*.local.beluga.internal` 와일드카드 질의를 APISIX LoadBalancer IP(`192.168.77.200`)로 자동 응답한다 (`scripts/cluster/10-dnsmasq.sh`).
- **워커 노드**: `10-worker-dns.sh` 스크립트로 `systemd-resolved` drop-in (`/etc/systemd/resolved.conf.d/beluga-worker.conf`)을 설정하여 `*.local.beluga.internal` 도메인을 Master-1(`192.168.77.10`)로 포워딩하는 split-DNS로 작동한다.
- **k3s CoreDNS**: `coredns-custom` ConfigMap 한 곳에만 `local.beluga.internal:53` forward 존을 정의하여 파드 내부에서 도메인을 자동 해독한다. (중복 존 정의 시 CoreDNS가 크래시된다.)

---

## 2. 호스트(개발자 PC) DNS 1회 설정

### Option A: macOS resolver 설정 (정식 권장 방식)

macOS의 `/etc/resolver` 기능을 사용하면 `/etc/hosts` 파일 수정 없이 `*.local.beluga.internal` 도메인 질의만 Master-1 dnsmasq로 자동 위임된다. 새로운 서브도메인이 추가되어도 수동 등록이 불필요하다.

```bash
sudo mkdir -p /etc/resolver
echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal
```

설치 후 정상 동작 확인:
```bash
scutil --dns | grep -A 5 "local.beluga.internal"
ping -c 1 sso.local.beluga.internal
```

### Option B: `/etc/hosts` 직접 등록 (대안)

macOS `/etc/resolver`를 사용하지 않거나 Linux/Windows 호스트인 경우 `/etc/hosts`에 직접 등록한다.

```bash
sudo tee -a /etc/hosts << 'EOF'
# Beluga Data Platform (APISIX LB: 192.168.77.200)
192.168.77.200 trino.local.beluga.internal
192.168.77.200 airflow.local.beluga.internal
192.168.77.200 superset.local.beluga.internal
192.168.77.200 catalog.local.beluga.internal
192.168.77.200 s3.local.beluga.internal
192.168.77.200 flink.local.beluga.internal
192.168.77.200 argocd.local.beluga.internal
192.168.77.200 sso.local.beluga.internal
192.168.77.200 metadata.local.beluga.internal
EOF
```

---

## 3. kubectl 접근 설정

k3s가 Master-1 생성하는 기본 kubeconfig (`/etc/rancher/k3s/k3s.yaml`)는 server 주소가 `127.0.0.1`로 되어 있어 호스트 PC에서 직접 사용할 수 없다.
호스트 접근을 위해 `scripts/kubeconfig.sh` 스크립트를 통해 접근을 일원화한다.

### 사용법 1: 프로젝트 로컬 `.kube/config` 생성 (단일 셸/프로젝트 전용)

```bash
bash scripts/kubeconfig.sh
```
- Master-1에서 kubeconfig를 가져와 server 주소를 `192.168.77.10`으로 수정하고, context/cluster/user 명칭을 `beluga`로 치환하여 `.kube/config`에 저장한다.
- 사용 방법:
  ```bash
  export KUBECONFIG=.kube/config
  kubectl get nodes
  kubectl get pods -A
  ```

### 사용법 2: `~/.kube/config` 전역 병합 (전역 kubectl 전용)

```bash
bash scripts/kubeconfig.sh --merge
```
- 호스트의 `~/.kube/config`에 `beluga` 컨텍스트로 안전하게 병합한다. (기존 `~/.kube/config`는 `~/.kube/config.bak.<timestamp>`로 자동 백업됨)
- 사용 방법:
  ```bash
  kubectl config use-context beluga
  kubectl get nodes
  kubectl get pods -A
  ```

---

## 4. 서비스 URL 및 상태

모든 서비스는 포트 **80**으로 접근한다.

| 서비스 | URL (Port 80) | 네임스페이스 | 실측 HTTP 응답 | 비고 및 상태 |
|--------|---------------|--------------|----------------|--------------|
| Airflow 3 UI | `http://airflow.local.beluga.internal` | `orchestration` | `HTTP 200` | 정상 동작 |
| OpenMetadata | `http://metadata.local.beluga.internal` | `governance` | `HTTP 200` | 정상 동작 |
| Flink Dashboard | `http://flink.local.beluga.internal` | `streaming` | `HTTP 200` | 정상 동작 |
| SeaweedFS S3 | `http://s3.local.beluga.internal` | `storage` | `HTTP 200` | 정상 동작 |
| SSO Keycloak | `http://sso.local.beluga.internal` | `iam` | `HTTP 302` | 정상 (로그인 페이지 리다이렉트) |
| ArgoCD UI | `http://argocd.local.beluga.internal` | `argocd` | `HTTP 307` | 정상 (HTTPS/로그인 리다이렉트) |
| Lakekeeper REST | `http://catalog.local.beluga.internal` | `lakehouse` | `HTTP 308` | 정상 (API 리다이렉트) |
| Superset BI | `http://superset.local.beluga.internal` | `analytics` | `HTTP 302` | 정상 (로그인 리다이렉트 → 200) |
| Trino UI | `http://trino.local.beluga.internal` | `analytics` | `HTTP 303` | 정상 (`/ui/` 리다이렉트) |

플랫폼 게이트웨이(APISIX)·인증 백엔드(OPA/OpenFGA)는 `platform-system`, PostgreSQL(CNPG)은 `database`에 있다.

---

## 5. Keycloak SSO 사용자 로그인 및 권한 매핑

Beluga 플랫폼은 Keycloak OIDC 기반 단일 인증(SSO)을 제공한다. `beluga` Realm에는 3종의 사용자 계정이 자동 생성(Job `keycloak-users`)되며, 각 사용자별 그룹에 따라 플랫폼 서비스 권한이 제어된다.

### SSO 서비스 URL
- **Keycloak SSO 콘솔**: `http://sso.local.beluga.internal` (Realm: `beluga`)
- **OIDC 로그인 지원 서비스**: Superset (`http://superset.local.beluga.internal`), Airflow, OpenMetadata, Grafana
- **Trino는 아직 인증이 없다**: OIDC 로그인이 붙어 있지 않고, `X-Trino-User` 헤더로 임의
  사용자를 자칭할 수 있는 상태다. 인가(그룹 기반 권한)는 별도로 LDAP group provider 경유로
  붙일 예정이나 배포는 아직이다. cert-manager → TLS → OAuth2 순으로 인증을 붙이는 작업은
  계획만 됐고 미착수다.

### 사용자 계정 및 그룹 / 역할 매핑

| 계정 (Username) | 이메일 | Keycloak 그룹 | 주요 앱 롤 매핑 (역할) |
|---------------|-------|--------------|----------------------|
| `beluga-admin` | `beluga-admin@beluga.local` | `admin` | **Superset Admin** / 플랫폼 전역 관리자 권한 |
| `beluga-engineer` | `beluga-engineer@beluga.local` | `engineer` | **Superset Alpha** (데이터셋/파이프라인 생성 및 편집 권한) |
| `beluga-analyst` | `beluga-analyst@beluga.local` | `analyst` | **Superset Gamma** (대시보드/차트 조회 및 쿼리 전용) |

> **비밀번호 조회**:
> `bash scripts/credentials.sh` 실행 시 각 사용자의 동적 생성 비밀번호를 확인할 수 있다.

---

## 6. 서비스 자격증명 조회 방법

D15 사양에 따라 플랫폼 서비스 자격증명은 `platform-system` 네임스페이스의 `beluga-credentials` Secret 또는 서비스별 Secret에 저장되어 관리된다.

### 권장: 한 번에 조회

```bash
bash scripts/credentials.sh          # 서비스별 URL·계정·비밀번호를 한 화면에 출력
bash scripts/credentials.sh --raw    # key=value 형태 (스크립트/파이프용)
```

### 개별 조회 (스크립트 없이)

```bash
# 임의의 키 하나만 (pg-password, keycloak-admin-password, superset-admin-password,
#                  superset-secret-key, apisix-admin-key, client-secret-<앱>)
kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d; echo

# ArgoCD admin 초기 비밀번호 (별도 Secret)
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo

# Airflow 3 standalone 비밀번호 (pod log에서 확인)
kubectl logs -n orchestration deployment/airflow-webserver | grep 'password'
```

### SeaweedFS 데이터 플레인 자격증명/버킷 정책

- SeaweedFS S3 게이트웨이는 `storage/seaweedfs-s3-credentials` Secret에서 3개 identity를 렌더링한다: `trino-service`, `flink-service`, `lakekeeper-service`.
- 각 소비자는 자기 네임스페이스의 전용 Secret만 읽는다: `analytics/trino-s3-credential`, `streaming/flink-s3-credential`, `lakehouse/lakekeeper-s3-credential`.
- 현재 버킷은 `beluga-lake` 하나이며, 허용 액션은 모두 `Action:beluga-lake` 형태로만 선언된다. 전역 `Read`/`Write`/`List` 권한은 두지 않는다.
- 데이터 경로 규약:
  `raw/`는 CDC·수집 랜딩 영역, `curated/`는 분석/모델링용 관리 테이블, `tmp/`는 재작성·체크포인트·임시 산출물용이다.
- 이 리포의 SeaweedFS 구성은 버킷 단위 액션 스코프만 사용한다. `raw/`/`curated/`/`tmp/` prefix 자체를 ACL로 강제하지는 않으며, prefix-level enforcement는 후속 과제다.

### SeaweedFS 자격증명 회전/폐기

1. `platform-system/beluga-credentials`에서 대상 identity의 `seaweedfs-<identity>-access-key`와 `seaweedfs-<identity>-secret-key` 두 data 키를 제거한다. 다음 bootstrap 실행의 `ensure_cred`가 각각 새 `openssl rand -hex 16` 값으로 재생성한다. (파생 Secret만 삭제해서는 회전되지 않는다.)
2. `bash scripts/gitops/01-argocd-bootstrap.sh`를 실행해 `storage/seaweedfs-s3-credentials`와 해당 소비자 Secret을 새 값으로 다시 만든다.
3. 같은 identity를 반영하도록 `seaweedfs` StatefulSet과 소비자 워크로드를 재시작한다:
   `storage/seaweedfs`, `analytics/trino-coordinator`(+ `trino-worker` 사용 시 함께), `streaming`의 Flink 세션 클러스터/SQL 제출 Job, `lakehouse/lakekeeper-bootstrap`.
4. 폐기만 필요하면 `seaweedfs-s3-identities-template`에서 해당 identity의 `credentials` 배열을 비우고 `seaweedfs`만 재시작한다. 액션 정의는 남겨 두되 유효 키만 제거하는 방식이다.

---

## 7. 트러블슈팅 가이드

도메인 접근이 불가능하거나 HTTP 에러 발생 시 아래 단계별 명령어로 원인을 점검한다.

### 7.1 도메인 접근 문제 확인 순서

1. **Step 1: 호스트 DNS Resolver 확인**
   ```bash
   # DNS 질의 테스트
   dig @192.168.77.10 sso.local.beluga.internal
   # 호스트 resolver 설정 확인 (macOS)
   scutil --dns | grep -A 5 "local.beluga.internal"
   ```

2. **Step 2: Master-1 dnsmasq 서비스 상태 확인**
   ```bash
   vagrant ssh master-1 -c "sudo systemctl status dnsmasq"
   ```

3. **Step 3: CoreDNS 파드 상태 확인**
   ```bash
   kubectl get pods -n kube-system -l k8s-app=kube-dns
   kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
   ```

4. **Step 4: APISIX 라우트 수 및 상태 확인**
   ```bash
   # APISIX에 등록된 route 수 조회
   kubectl exec -n platform-system deployment/apisix -- curl -s http://127.0.0.1:9180/apisix/admin/routes | grep -c '"id"'
   ```

### 7.2 주요 증상별 원인 및 조치

| 증상 | 주요 원인 | 점검 및 조치 방안 |
|------|-----------|-------------------|
| **000 (Connection Refused / Name Not Resolved)** | 호스트 DNS 해석 실패 | `/etc/resolver/local.beluga.internal` 파일 존재 여부 및 `nameserver 192.168.77.10` 등록 상태 점검. `systemctl status dnsmasq`로 master-1 DNS 상태 확인 |
| **HTTP 404 Not Found (전 도메인)** | APISIX 라우트 0개 등록 | ApisixRoute CRD 미적용 또는 etcd / Ingress Controller 동기화 실패. `kubectl get apisixroute -A` 및 `kubectl logs -n platform-system deployment/apisix-ingress-controller` 점검 |
| **HTTP 502 Bad Gateway** | 업스트림 파드 비정상 | APISIX 라우팅 대상 백엔드 Pod가 다운되었거나 unhealthy 상태. `kubectl get pods -A -l app=<서비스명>`으로 target pod의 네임스페이스와 CrashLoopBackOff 또는 status 확인 (서비스별 네임스페이스는 §4 참조) |
