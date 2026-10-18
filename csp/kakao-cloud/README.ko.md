# Beluga on Kakao Cloud

[English](README.md) | 한국어

Vagrant 경로와 같은 토폴로지(`master-1`(.10) + `worker-1..3`(.21-.23), 프로파일 64)로 Kakao Cloud 위에
Beluga(k3s + Cilium + ArgoCD GitOps)를 배포한다. **상태: 2026-10-16 라이브 apply 1회 검증("라이브 검증" 참고).** 남은 미확인 사항은
"첫 apply 위험"에 둔다.

```
인터넷 ──► NLB(공인 IP) 80/443 ──► 워커 NodePort 31080/31443 ──► APISIX ──► 서비스
운영자 ──► bastion(공인 IP, admin_cidrs 에서만 SSH) ──► 노드(사설, 공인 IP 없음)
노드 ──► bastion squid :3128 ──► apt / GitHub / Helm / 이미지 레지스트리
```

## 결정

| ID | 결정 | 이유 / 탈출구 |
|---|---|---|
| D1 | 사설 노드 + bastion squid 프록시로 egress | 제공자에 NAT 리소스가 없고 노드마다 공인 IP를 주면 노출된다. 탈출구: 노드 공인 IP 부여 + cloud-init 프록시 제거(미구현). |
| D2 | NLB 하나: TCP 80/443 → 워커 NodePort 31080/31443, MetalLB 생략(`BELUGA_LB_MODE=nodeport`) | VPC 안에서는 MetalLB L2 ARP 광고가 불가능하다. |
| D3 | 코드 + 정적 검증만 | 자격증명·실제 리소스 없이 작성했다. |
| D-KAKAO-2 | `apisix-gateway` 고정 ClusterIP `10.43.0.200`, dnsmasq 가 `*.kakao.beluga.internal` 을 이 IP로 응답 | 클러스터/노드 안에서 도메인이 Service 로 직접 풀려 공인 NLB IP 헤어핀이 필요 없다. `10.43.0.0/16` 은 k3s 기본값(`02-k8s-init.sh` 가 바꾸지 않음). `gitops/charts/beluga-platform/values-kakao.yaml` 의 `apisix.service.clusterIP` 와 같아야 한다. |
| D-KAKAO-3 | 루트 `beluga-root` 는 두 소스 사용(`gitops/apps` 에서 `beluga-platform.yaml`/`app-of-apps.yaml` 제외 + `csp/kakao-cloud/gitops/apps`) | ArgoCD 기본 load restrictor 에서 kustomize 는 루트 밖 평문 파일을 참조할 수 없고, `gitops/apps` 에 kustomization 을 넣으면 기본 경로가 바뀐다. |

## 구성

- `terraform/` OpenTofu(제공자 `kakaoenterprise/kakaocloud` 0.5.1): `network`·`security`·`compute`·`loadbalancer` 모듈 + 루트 `bastion.tf`.
- `scripts/kakao-up.sh` bastion 경유 부트스트랩, `scripts/kakao-kubeconfig.sh` 레포 로컬 kubeconfig.
- `gitops/` ArgoCD 루트 앱과 `beluga-platform` Kakao 변형(`values-kakao.yaml` 추가).
- 공유 스크립트 파라미터화(Vagrant 기본값 불변): `BELUGA_SRC`, `BELUGA_LB_MODE`, `METALLB_INTERFACE`, `UPSTREAM_DNS`, `BELUGA_PLATFORM_VALUES_EXTRA`, `BELUGA_APP_OF_APPS`, `/etc/beluga/cluster.override.env`, `/etc/default/beluga-proxy`.

## 절차

사전 조건: OpenTofu >= 1.13, `ssh`, `rsync`, `python3`, Kakao Cloud application credential.

1. **먼저 머지.** ArgoCD 는 `github.com/dasomel/beluga` 기본 브랜치(`HEAD`)를 추적한다. 4단계 전에 `values-kakao.yaml` 과 `csp/kakao-cloud/gitops` 가 거기에 있어야 한다.
2. 설정 및 apply(과금 리소스가 생성된다):
   ```bash
   cd csp/kakao-cloud/terraform
   cp terraform.tfvars.example terraform.tfvars   # admin_cidrs 설정, 콘솔에서 image/flavor 이름 확인
   export TF_VAR_application_credential_id=... TF_VAR_application_credential_secret=...
   tofu init && tofu plan && tofu apply
   ```
3. `bash csp/kakao-cloud/scripts/kakao-up.sh` (k3s, Cilium, dnsmasq/CoreDNS, ArgoCD; 멱등, 재실행 가능).
4. `bash csp/kakao-cloud/scripts/kakao-kubeconfig.sh` 후 출력되는 SSH 터널을 열고 `KUBECONFIG=.kube/kakao-config kubectl get nodes`. K8s API 는 공개하지 않는다.
5. 도메인을 NLB 로: `/etc/hosts` 에 `<nlb_public_ip> trino airflow superset catalog s3 argocd sso`(각각 `.kakao.beluga.internal`; Kakao 플랫폼 도메인은 2026-10-17 부터 `kakao.beluga.internal`, Vagrant 는 `local.beluga.internal` 유지). 게이트웨이는 클러스터의 자체서명 내부 CA 를 그대로 쓰므로 Vagrant 와 동일하게 신뢰 처리한다.

삭제: `tofu destroy`. VPC 가 `PENDING_DELETE` 로 남으면 몇 분 기다린 뒤 재생성한다.

## 공인 IP 고정 (D-KAKAO-12)

2026-10-16 라이브 검증 완료("라이브 검증" 참고): bastion 교체 후에도 NIC 가 남고 공인 IP 연결이 유지된다.

고정되는 것:

- Bastion: 공인 IP(`kakaocloud_public_ip.bastion`)는 독립 리소스이며 고정 사설 IP 를 가진 별도 NIC(`kakaocloud_network_interface.bastion`)에 묶인다. VM 을 교체해도 NIC 가 남아 공인 IP 가 같다.
- 게이트웨이 NLB: 공인 IP(`module.loadbalancer.kakaocloud_public_ip.gateway`)는 독립 리소스라 주소는 고정이지만, NLB 교체 후 자동 재연결되지 않는다(아래 참고).
- 노드는 공인 IP 가 없다(D1: 사설 노드 + bastion).

두 `public_ip` 리소스에는 `ignore_changes = [related_resource]` 가 있다. 장치가 교체되면 provider 가 삭제된 옛 장치에 detach 를 호출해 apply 가 실패하기 때문이다.

Bastion VM 교체:

```bash
tofu -chdir=csp/kakao-cloud/terraform apply -replace=kakaocloud_instance.bastion
tofu -chdir=csp/kakao-cloud/terraform apply -refresh-only   # 이후 출력 확인
tofu -chdir=csp/kakao-cloud/terraform output bastion_public_ip   # 이전 값과 같아야 한다
```

주소가 바뀌었거나 SSH 가 안 되면 콘솔에서 공인 IP 가 bastion NIC(`bastion_network_interface_id` 출력)에 연결돼 있는지 확인하고 아니면 재연결한다.

NLB 교체: 주소는 보존되지만 새 NLB 에는 공인 IP 가 없다. apply 후 Kakao Cloud 콘솔에서 기존 공인 IP(`tofu output nlb_public_ip`)를 새 로드밸런서에 재연결하고 `tofu apply -refresh-only` 를 실행한다. 새 IP 를 할당하지 않는다.

`tofu destroy` 는 두 IP 를 모두 해제한다. 교체 이후 `tofu destroy` 를 하기 전에는 먼저 `tofu apply -refresh-only` 를 실행해 state 의 `related_resource.device_id` 를 최신으로 맞춘다(provider Delete 가 state 의 device_id 로 RemovePublicIp 를 호출한다).

전체 destroy 후에도 IP 를 유지하려면 state 에서 먼저 빼고, 다음 `tofu apply` 전에 import 해서 새 IP 가 할당되지 않게 한다.

```bash
cd csp/kakao-cloud/terraform
tofu apply -refresh-only
tofu state rm kakaocloud_public_ip.bastion module.loadbalancer.kakaocloud_public_ip.gateway
tofu destroy
# 다음 배포: 보관한 할당을 먼저 import (공인 IP id; import ID = 공인 IP UUID, 라이브 검증됨)
tofu import kakaocloud_public_ip.bastion <PUBLIC_IP_ID>
tofu import module.loadbalancer.kakaocloud_public_ip.gateway <PUBLIC_IP_ID>
tofu apply
```

`ignore_changes = [related_resource]` 때문에 import 한 IP 는 apply 로 연결되지 않는다. apply 후 콘솔에서 보관한 IP 를 연결하고(bastion IP -> `tofu output -raw bastion_network_interface_id`, NLB IP -> 새 로드밸런서) `tofu apply -refresh-only` 를 실행한 뒤 bastion SSH 를 확인한다. 대안: 한 번의 apply 동안 `ignore_changes` 를 임시로 제거. 설정이 아직 없는 리소스를 참조해 `tofu import` 가 실패하면 먼저 `tofu apply -target=kakaocloud_instance.bastion -target=module.loadbalancer` 를 실행한다(미검증).

D-KAKAO-12 이전 버전으로 apply 한 스택의 마이그레이션: 실제로는 아직 없다. 있다면 이 변경을 apply 할 때 bastion 이 교체되고(subnets 변경) 기존 inline NIC 는 함께 삭제되며 `ignore_changes` 가 재연결을 막는다. apply 후 콘솔에서 기존 bastion 공인 IP 를 `tofu output -raw bastion_network_interface_id` 에 연결하고 `tofu apply -refresh-only` 를 실행한 뒤 bastion SSH 를 확인한다.

## 라이브 검증 (2026-10-16)

첫 실제 배포: tofu 1.x, provider 0.5.1, `kr-central-2-a`, 이미지 `Ubuntu 24.04`, master `t1i.xlarge`, worker `t1i.2xlarge` x3.

- bastion VM 을 `tofu apply -replace=kakaocloud_instance.bastion` 으로 두 번 교체: 공인 IP `210.109.61.102` 불변, NIC 보존, `tofu apply -refresh-only` 후 `related_resource.device_id` 가 새 VM 을 따라갔다(D-KAKAO-12 동작).
- `tofu import <주소> <public_ip_id>` 동작(import ID = 공인 IP UUID).
- NLB 는 클라이언트 소스 IP 를 보존하지 않는다: VPC 전용 규칙으로도 외부 트래픽이 NodePort 에 도달했으므로 `nodeport_source_cidrs` 를 넓힐 필요가 없다.
- NLB 경유 게이트웨이(내부 CA, `--cacert`): sso 302, argocd 200, trino 303, airflow 200, superset 302, catalog 308, s3 403, HTTP 80 -> 301. bastion 에서 NodePort 직접 접근도 같다. Keycloak OIDC discovery 200(realm `beluga`, master). 클러스터 내부 `sso.local.beluga.internal` -> 10.43.0.200 -> 200.
- `tests/run-all.sh` 의 `tests/*.sh` 19개 전부 Kakao 에서 통과.
- 부트스트랩·수렴 시간은 아래 측정표 참고. Keycloak 은 `postgres-main` 이 생길 때까지 crashloop 하다가 모든 앱이 Synced/Healthy 로 수렴한다.
- 삭제: `tofu apply -refresh-only` 후 `tofu destroy` -> 남은 리소스 0.

이번 실행에서 발견해 고친 것: D-KAKAO-13(IGW + attachment, provider 가 붙이지 않음), D-KAKAO-14(0.0.0.0/0 -> IGW 라우트 테이블; 기본 테이블에는 로컬 경로뿐이라 bastion SSH 가 타임아웃), D-KAKAO-15(squid 용 dnsmasq `filter-AAAA`; IPv6 응답으로 CONNECT 503), bastion 오프셋 >= 11.

두 번째 배포(2026-10-16): VPC DHCP DNS `169.254.169.253` 이 모든 VM 에서 타임아웃 났다(dig/ping 실패; SG egress·라우트는 정상, 인터넷 IP 직접 접속은 됨; public 라우트 테이블 `is_main=true` 는 효과 없음). cloud-init `packages`(squid, dnsmasq)가 이름 해석에 실패해 squid 가 뜨지 않았고 `kakao-up.sh` 가 egress 확인에서 실패했다. D-KAKAO-16: bastion `bootcmd` 가 packages 설치 전에 `bastion_upstream_dns`(기본 `1.1.1.1 8.8.8.8`)로 `/etc/systemd/resolved.conf.d/beluga-upstream.conf` 를 쓴다. VPC DNS 도 목록에 남아 dnsmasq `resolv-file` 에 셋 다 실린다. 비용: bastion 질의가 공용 리졸버로도 나간다. VPC DNS 만 쓰려면 `bastion_upstream_dns = []`. `user_data` 변경만으로는 기존 bastion 이 교체되지 않는다: `tofu apply -replace=kakaocloud_instance.bastion`.

측정된 배포 시간(두 번째 배포, 2026-10-16 KST, 프로파일 64, master `t1i.xlarge` 1 + worker `t1i.2xlarge` 3, `kr-central-2-a`):

| 단계 | 시각 | 소요 |
|---|---|---|
| `tofu apply` (리소스 32개) | 09:19:24 -> 09:27:22 | 약 8분 |
| `kakao-up.sh` 1차 (egress 확인에서 실패, VPC DNS 타임아웃; D-KAKAO-16 진단 + bastion DNS 수동 우회 09:28-09:37) | 09:27:33 -> 09:37 | 약 9.5분, 예상 총합에서 제외 |
| `kakao-up.sh` 2차 | 09:37:30 -> 09:58:35 | 21분 05초 |
| - 1/7 노드 대기 | | 8초 |
| - 2/7 전 노드 `/opt/beluga` 로 레포 rsync | | 7분 18초 |
| - 3/7 노드 준비 + k3s | | 56초 |
| - 4/7 Cilium | | 1분 11초 |
| - 5/7 DNS (dnsmasq/split DNS) | | 1분 40초 |
| - 6/7 ArgoCD 및 GitOps 부트스트랩 | | 9분 52초 |
| - 7/7 게이트웨이 확인 | | 1초 미만 |
| 수렴: 모든 파드 Ready 10:06:42; ArgoCD 앱 3개 Synced/Healthy 10:07:21 (`beluga-data` 는 `flink-sql-submit` 훅을 기다린다) | | 부트스트랩 후 약 8분 46초 |
| 전체(apply 시작 -> 완전 수렴) | | 실시간 47분 57초; DNS 우회 제외 약 38분(신규 배포 기대값) |

가장 긴 두 단계인 rsync(약 7분)와 GitOps 부트스트랩(약 10분)이 최적화 후보다.

운영 주의:

- `user_data` 만 바꾸면(예: `bastion_ip_offset`, 프록시 설정) 인스턴스가 교체되지 않는다(plan diff 없음). 노드를 명시적으로 `-replace` 한다.
- bastion 을 교체하면 SSH 호스트 키가 바뀐다. `kakao-up.sh` 재실행 전에 `ssh-keygen -R <bastion_public_ip> -f csp/kakao-cloud/terraform/generated/known_hosts` 로 옛 항목을 지운다.
- `tests/07`, `tests/10` 은 운영 호스트에서 `*.${BASE_DOMAIN}` 을 해석한다(Kakao 는 `BASE_DOMAIN=kakao.beluga.internal` 로 실행, 기본값은 `local.beluga.internal`). 두 클러스터의 도메인이 달라져 Vagrant 항목이 Kakao 를 가리지는 않지만, 이름은 NLB 공인 IP 를 가리키게 하거나 `curl --resolve` 를 써야 한다.
- main 라우트 테이블은 삭제할 수 없고("Deleting the main VPC Route Table is not allowed"), 새 테이블을 `is_main = true` 로 만들어도 기존 서브넷 연결이 옮겨지지 않았다. 그래서 서브넷의 `route_table_id` 로 연결한다. 수동으로 main 을 바꿨다면 VPC 기본 테이블을 먼저 main 으로 되돌린다.

## 비용 경고

bastion + master 1 + worker 3 + NLB + 공인 IP + 부트 볼륨 100GB(기본 master 4 vCPU/8 GiB, worker 8 vCPU/16 GiB)는 계속 과금된다. 쓰지 않을 때는 destroy 한다.

## 이전 Kakao 작업에서 가져온 제공자 동작

- 모듈 단위 `depends_on` 은 그 모듈의 data source 를 apply 시점으로 미뤄 image/flavor ID 를 unknown 으로 만들고 인스턴스/LB 교체를 유발한다. 여기서는 암묵 의존(키 이름 참조)과 LB 모듈의 depends_on 만 쓴다.
- LB 사설 VIP 는 자동 할당이라 노드 고정 IP 를 가져갈 수 있어 LB 모듈은 compute 뒤에 만든다. bastion IP 도 같은 이유로 고정(`bastion_ip_offset`)한다.
- 보안그룹은 허용되지 않은 포트를 거부가 아니라 조용히 DROP 한다 — 느린 타임아웃은 대개 SG 규칙 누락이다.
- NAT 게이트웨이 리소스가 없고, 삭제된 VPC 이름이 `PENDING_DELETE` 로 남을 수 있다.

## 첫 apply 위험 및 수동 단계

1. **flavor/image 이름**은 한 리전/프로젝트에서 라이브 검증됐다(2026-10-16): 기본값 master `t1i.xlarge`, worker `t1i.2xlarge`, `Ubuntu 24.04`. 프로젝트/리전마다 제공 여부가 다를 수 있다. 프로파일 64 에는 4 vCPU/16 GiB worker 가 가장 가깝다. 이름이 없으면 plan 이 precondition 메시지로 실패한다.
2. **NLB 소스 IP.** 31080/31443 SG ingress 는 VPC CIDR 이다. 라이브 검증: NLB 는 클라이언트 IP 를 보존하지 않아 VPC 전용 규칙으로 충분하다. 이후 보존하게 되면 트래픽이 DROP 되므로 그때 `nodeport_source_cidrs` 만 명시 대역으로 넓힌다(0.0.0.0/0, ::/0 는 거부됨; 클러스터 포트는 절대 아님).
3. **bastion IP 오프셋** 기본값은 `.11`이다. `.5`는 Kakao 예약 대역으로 라이브에서 거부됐다(2026-10-16). public IP 를 쓰려면 VPC 에 인터넷 게이트웨이가 필요해 스택이 IGW 를 만들고 붙인다(D-KAKAO-13).
4. **이미지 24.04 vs Vagrant 26.04 박스**: 스크립트는 26.04 에서만 검증됐다.
5. **라이브 검증 완료(2026-10-16)**: squid 443-only CONNECT, NLB 뒤 NodePort, 파드의 `*.local.beluga.internal` → ClusterIP 해석, 게이트웨이 직접/NLB 경유 모두 확인했다. 다른 레지스트리에 대한 CONNECT 정책은 사용 중 새 레지스트리를 추가할 때 다시 확인한다.
6. Service 템플릿 변경으로 `docs/` 의 `apisix-gateway.yaml` 줄 번호 참조가 밀렸다.
7. **Manager GitHub App Secret (ADR-0009 롤아웃 ④)**: Secret은 Git에 없으며 새 클러스터에는 `manager-github-app`(`platform-system`; 키 `app-id`, `installation-id`, `private-key.pem`)이 없다. 재배포할 때마다 소유자가 다시 만들고(`kubectl create secret generic manager-github-app -n platform-system --from-literal=app-id=... --from-literal=installation-id=... --from-file=private-key.pem=<경로>`) `deployment/manager-domain-api`를 재시작한다. 그 전에는 SSO 변경 제출이 503 `GIT_WRITER_UNCONFIGURED`로 답한다. `tests/25-manager-sso-github.sh`로 확인한다.
