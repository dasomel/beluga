# Beluga 서비스 접근 가이드

Beluga 데이터 플랫폼의 서비스 접근 URL, DNS 설정, 인증 정보를 정리한다.

> **이 문서는 Vagrant 로컬 환경 기준이다.** APISIX 게이트웨이 + MetalLB LoadBalancer 기반으로
> 모든 서비스가 `*.local.beluga.internal` 도메인, **포트 80** 으로 통일 접근된다.

## 네트워크 구성

| 구성요소 | IP | 설명 |
|----------|-----|------|
| Master-1 | 192.168.77.10 | 컨트롤플레인, dnsmasq DNS 서버 (:53) |
| Worker-1 | 192.168.77.21 | 데이터 워크로드 (DNS: Master-1 포워딩) |
| Worker-2 | 192.168.77.22 | 데이터 워크로드 (DNS: Master-1 포워딩) |
| Worker-3 | 192.168.77.23 | 데이터 워크로드 (DNS: Master-1 포워딩) |
| MetalLB VIP | **192.168.77.200** | APISIX LoadBalancer IP |

## 서비스 URL 및 인증 정보

### 데이터 스택

| 서비스 | URL | 인증 방식 | 기본 자격 증명 |
|--------|-----|-----------|---------------|
| Trino Coordinator | http://trino.local.beluga.internal | 인증 없음 (dev 모드) | — |
| Airflow 3 UI | http://airflow.local.beluga.internal | 로컬 인증 (`standalone` 자동 생성) | 콘솔 로그에서 확인¹ |
| Superset BI | http://superset.local.beluga.internal | Flask 로컬 인증 | `admin` / Secret 조회³ |
| Lakekeeper REST | http://catalog.local.beluga.internal | 인증 없음 (REST API) | — |
| SeaweedFS S3 | http://s3.local.beluga.internal | S3 호환 (any/any) | AccessKey: `any` / Secret: `any` |
| SeaweedFS Filer | http://filer.local.beluga.internal | 인증 없음 (Web UI) | — |

### 플랫폼 서비스

| 서비스 | URL | 인증 방식 | 기본 자격 증명 |
|--------|-----|-----------|---------------|
| ArgoCD | http://argocd.local.beluga.internal | 로컬 인증 | `admin` / 초기 비밀번호² |
| Grafana | — (NodePort 30000) | 로컬 인증 / Keycloak SSO | `admin` / Secret 조회³ |
| Prometheus | — (NodePort 30090) | 인증 없음 | — |

### 데이터 인프라 (UI 없음 — API/클라이언트 직접 연결)

| 서비스 | 접근 방식 | 포트 | 비고 |
|--------|-----------|------|------|
| Kafka (bootstrap) | 호스트 포트포워딩 | `localhost:9094` | NodePort 30094 → 호스트 9094 |
| PostgreSQL (CNPG) | 클러스터 내부 전용 | `postgres-main-rw:5432` | `beluga_admin` / Secret 조회³ |
| Flink JobManager | http://flink.local.beluga.internal | 80 | APISIX route (구현 후) |

> ¹ **Airflow 3 standalone 비밀번호**: `airflow standalone` 명령이 첫 기동 시 admin 계정을 자동 생성하고
> 비밀번호를 콘솔에 출력한다. 확인 방법:
> ```bash
> vagrant ssh master-1 -c "sudo kubectl logs -n beluga-data deployment/airflow-webserver | grep 'password'"
> ```
>
> ² **ArgoCD 초기 비밀번호**: ArgoCD 설치 시 자동 생성되는 secret에서 추출:
> ```bash
> vagrant ssh master-1 -c "sudo kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo"
> ```
>
> ³ **플랫폼 랜덤 생성 비밀번호 (D15)**: 부트스트랩 시 자동 생성된 `beluga-credentials` Secret에서 추출:
> ```bash
> # Superset admin 비밀번호
> kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.superset-admin-password}' | base64 -d; echo
>
> # PostgreSQL (CNPG) 비밀번호
> kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.pg-password}' | base64 -d; echo
>
> # Keycloak / Grafana admin 비밀번호
> kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.keycloak-admin-password}' | base64 -d; echo
> ```

## DNS 설정

beluga는 master-1(192.168.77.10)에서 **dnsmasq** 기반의 중앙 DNS 서버를 운용하며, `*.local.beluga.internal` 와일드카드 도메인을 APISIX LB IP(`192.168.77.200`)로 자동 해석한다.

- **클러스터 노드(워커 노드)**: `10-worker-dns.sh` 스크립트를 통해 `systemd-resolved` drop-in (`/etc/systemd/resolved.conf.d/beluga-worker.conf`)을 설정하여 `*.local.beluga.internal` 질의를 master-1 dnsmasq로 자동 포워딩한다.
- **클러스터 내부 파드(Pod)**: CoreDNS ConfigMap에 `local.beluga.internal:53` forward 존이 자동 추가되어 파드 내부에서도 `sso.local.beluga.internal`, `metadata.local.beluga.internal` 등을 추가 설정 없이 자동 해독할 수 있다.

### 호스트(개발자 PC) DNS 설정 방법

호스트(macOS/Linux/Windows)에서는 다음 두 가지 방법 중 하나를 선택하여 구성한다.

#### Option A: macOS resolver 설정 (권장)

macOS의 `/etc/resolver` 기능을 이용하면 hosts 파일 수정 없이 `*.local.beluga.internal` 도메인만 master-1 dnsmasq로 처리된다.

```bash
sudo mkdir -p /etc/resolver
echo "nameserver 192.168.77.10" | sudo tee /etc/resolver/local.beluga.internal
```

#### Option B: `/etc/hosts` 직접 등록

`/etc/resolver`를 사용하지 않거나 Linux/Windows 호스트인 경우 `/etc/hosts`에 직접 등록한다.

```bash
# macOS / Linux /etc/hosts에 추가 (한 번만 실행)
sudo tee -a /etc/hosts << 'EOF'
# Beluga Data Platform (APISIX LB: 192.168.77.200)
192.168.77.200 trino.local.beluga.internal
192.168.77.200 airflow.local.beluga.internal
192.168.77.200 superset.local.beluga.internal
192.168.77.200 catalog.local.beluga.internal
192.168.77.200 s3.local.beluga.internal
192.168.77.200 filer.local.beluga.internal
192.168.77.200 flink.local.beluga.internal
192.168.77.200 argocd.local.beluga.internal
192.168.77.200 sso.local.beluga.internal
192.168.77.200 metadata.local.beluga.internal
EOF
```

### DNS 해석 확인

```bash
# DNS 해석 확인 (Option A 설정 시)
dig @192.168.77.10 trino.local.beluga.internal

# HTTP 접근 확인
curl -I http://trino.local.beluga.internal
curl -I http://airflow.local.beluga.internal
curl -I http://superset.local.beluga.internal
curl -I http://argocd.local.beluga.internal
```

### Windows (관리자 PowerShell)

```powershell
$hosts = @"
# Beluga Data Platform (APISIX LB: 192.168.77.200)
192.168.77.200 trino.local.beluga.internal
192.168.77.200 airflow.local.beluga.internal
192.168.77.200 superset.local.beluga.internal
192.168.77.200 catalog.local.beluga.internal
192.168.77.200 s3.local.beluga.internal
192.168.77.200 filer.local.beluga.internal
192.168.77.200 flink.local.beluga.internal
192.168.77.200 argocd.local.beluga.internal
192.168.77.200 sso.local.beluga.internal
192.168.77.200 metadata.local.beluga.internal
"@
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value $hosts
```

## SSO 통합 (D13 — 미구현, 향후 계획)

설계서 D13에 따라 beluga 자체 Keycloak을 편입하여 독립 SSO를 제공할 예정이다.
narwhal의 Keycloak과는 별개의 인스턴스로, narwhal 미기동 상태에서도 beluga 단독으로
동작해야 한다는 요건에 따른 결정이다.

### SSO 구현 시 계획

| 항목 | 내용 |
|------|------|
| IdP | Keycloak (CNPG PostgreSQL 기반, beluga-data 네임스페이스) |
| 도메인 | `http://keycloak.local.beluga.internal` |
| Realm | `beluga` |
| 프로토콜 | OIDC (OpenID Connect) |
| 인증 통합 방식 | APISIX `openid-connect` 플러그인 (narwhal 패턴과 동일) |

### SSO 적용 대상 서비스

| 서비스 | SSO 방식 | 비고 |
|--------|----------|------|
| ArgoCD | native OIDC (`argocd-cm` 설정) | narwhal 동일 |
| Grafana | native `generic_oauth` | Grafana 자체 OAuth 설정 |
| Superset | APISIX `openid-connect` 플러그인 | Superset 자체 OIDC 미지원 |
| Airflow | native OIDC (Flask-OIDC 또는 FAB) | Airflow 3 자체 설정 |
| Trino | 인증 없음 유지 (dev 전용) | 운영 시 Trino gateway OIDC |

### SSO 구현 시 필요한 작업

1. **Keycloak 배포** — CNPG에 `keycloak` DB 추가, Keycloak Deployment/Service 추가
2. **APISIX route에 OIDC 플러그인 추가** — narwhal의 `apisix-routes.yaml` 패턴 참고
3. **각 서비스 OIDC 클라이언트 등록** — Keycloak 관리 콘솔 또는 부트스트랩 스크립트
4. **APISIX에 OIDC secret 주입** — `$env://` 패턴 (narwhal `apisix.yaml` 참고)

> 참고: narwhal SSO 구현 코드
> - [`apisix-routes.yaml`](file:///Users/m/Documents/IdeaProjects/20.dasomel/idp/narwhal/gitops/charts/narwhal-platform/templates/apisix-routes.yaml) — OIDC 플러그인 설정 예시
> - [`apisix.yaml`](file:///Users/m/Documents/IdeaProjects/20.dasomel/idp/narwhal/gitops/charts/narwhal-apps/templates/apisix.yaml) — OIDC secret 주입 패턴

## APISIX 게이트웨이 아키텍처

```
호스트 브라우저
  │
  │  http://trino.local.beluga.internal:80
  │
  ▼
/etc/hosts → 192.168.77.200 (MetalLB LB IP)
  │
  ▼
┌─────────────────────────────────────────────┐
│ apisix-gateway (LoadBalancer :80 → :9080)   │
│   ┌─────────────────────────────────────┐   │
│   │ APISIX 3.11.0                       │   │
│   │   radixtree_host_uri router         │   │
│   │   Host header → upstream 매핑       │   │
│   └───────────┬─────────────────────────┘   │
│               │                             │
│   ┌───────────▼─────────────────────────┐   │
│   │ Ingress Controller 1.8.0            │   │
│   │   ApisixRoute CRD → etcd → APISIX  │   │
│   └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
  │
  ├── trino.local.beluga.internal → trino:8080
  ├── airflow.local.beluga.internal → airflow:8080
  ├── superset.local.beluga.internal → superset:8088
  ├── catalog.local.beluga.internal → lakekeeper:8181
  ├── s3.local.beluga.internal → seaweedfs-s3:8333
  ├── filer.local.beluga.internal → seaweedfs-s3:8888
  └── argocd.local.beluga.internal → argocd-server:80
```

## 문제 해결

### DNS 해석 실패

```bash
# /etc/hosts 항목 확인
grep beluga /etc/hosts

# MetalLB IP 직접 접근 테스트
curl -I http://192.168.77.200 -H "Host: trino.local.beluga.internal"
```

### 서비스 연결 거부

```bash
# APISIX Pod 상태 확인
vagrant ssh master-1 -c "sudo kubectl get pods -n beluga-system -l app=apisix"

# APISIX 서비스 확인 (LoadBalancer IP: 192.168.77.200)
vagrant ssh master-1 -c "sudo kubectl get svc -n beluga-system apisix-gateway"

# MetalLB 상태 확인
vagrant ssh master-1 -c "sudo kubectl get ipaddresspool -n metallb-system"
vagrant ssh master-1 -c "sudo kubectl get pods -n metallb-system"

# ApisixRoute 전체 확인
vagrant ssh master-1 -c "sudo kubectl get apisixroute -A"

# 특정 서비스 파드 상태
vagrant ssh master-1 -c "sudo kubectl get pods -n beluga-data"
```

### APISIX 라우팅 문제

```bash
# etcd 상태 확인
vagrant ssh master-1 -c "sudo kubectl get pods -n beluga-system -l app=apisix-etcd"

# Ingress Controller 로그 확인
vagrant ssh master-1 -c "sudo kubectl logs -n beluga-system deployment/apisix-ingress-controller --tail=30"

# APISIX 게이트웨이 로그 확인
vagrant ssh master-1 -c "sudo kubectl logs -n beluga-system deployment/apisix --tail=30"

# APISIX Admin API로 등록된 route 확인
vagrant ssh master-1 -c "sudo kubectl exec -n beluga-system deployment/apisix -- curl -s http://127.0.0.1:9180/apisix/admin/routes | python3 -m json.tool"
```

## narwhal과의 동시 기동

beluga(192.168.77.x)와 narwhal(192.168.56.x)은 서브넷이 분리되어 있어 동시 기동 가능하다.

`/etc/hosts`에 양쪽 항목이 공존해도 도메인이 다르므로(`*.local.beluga.internal` vs `*.local.narwhal.internal`) 충돌하지 않는다.

```bash
# /etc/hosts 예시 (양쪽 동시 운영)
# narwhal
192.168.56.200 argocd.local.narwhal.internal grafana.local.narwhal.internal ...
# beluga
192.168.77.200 trino.local.beluga.internal airflow.local.beluga.internal ...
```
