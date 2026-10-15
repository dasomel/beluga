# Beluga on Kakao Cloud

[English](README.md) | 한국어

Vagrant 경로와 같은 토폴로지(`master-1`(.10) + `worker-1..3`(.21-.23), 프로파일 64)로 Kakao Cloud 위에
Beluga(k3s + Cilium + ArgoCD GitOps)를 배포한다. **상태: 코드와 정적 검증만.** 실제 Kakao Cloud
프로젝트에는 한 번도 적용하지 않았다("첫 apply 위험" 참고).

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
| D-KAKAO-2 | `apisix-gateway` 고정 ClusterIP `10.43.0.200`, dnsmasq 가 `*.local.beluga.internal` 을 이 IP로 응답 | 클러스터/노드 안에서 도메인이 Service 로 직접 풀려 공인 NLB IP 헤어핀이 필요 없다. `10.43.0.0/16` 은 k3s 기본값(`02-k8s-init.sh` 가 바꾸지 않음). `gitops/charts/beluga-platform/values-kakao.yaml` 의 `apisix.service.clusterIP` 와 같아야 한다. |
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
5. 도메인을 NLB 로: `/etc/hosts` 에 `<nlb_public_ip> trino airflow superset catalog s3 argocd sso`(각각 `.local.beluga.internal`). 게이트웨이는 클러스터의 자체서명 내부 CA 를 그대로 쓰므로 Vagrant 와 동일하게 신뢰 처리한다.

삭제: `tofu destroy`. VPC 가 `PENDING_DELETE` 로 남으면 몇 분 기다린 뒤 재생성한다.

## 비용 경고

bastion + master 1 + worker 3 + NLB + 공인 IP + 부트 볼륨 100GB(기본 master 4 vCPU/8 GiB, worker 8 vCPU/16 GiB)는 계속 과금된다. 쓰지 않을 때는 destroy 한다.

## 이전 Kakao 작업에서 가져온 제공자 동작

- 모듈 단위 `depends_on` 은 그 모듈의 data source 를 apply 시점으로 미뤄 image/flavor ID 를 unknown 으로 만들고 인스턴스/LB 교체를 유발한다. 여기서는 암묵 의존(키 이름 참조)과 LB 모듈의 depends_on 만 쓴다.
- LB 사설 VIP 는 자동 할당이라 노드 고정 IP 를 가져갈 수 있어 LB 모듈은 compute 뒤에 만든다. bastion IP 도 같은 이유로 고정(`bastion_ip_offset`)한다.
- 보안그룹은 허용되지 않은 포트를 거부가 아니라 조용히 DROP 한다 — 느린 타임아웃은 대개 SG 규칙 누락이다.
- NAT 게이트웨이 리소스가 없고, 삭제된 VPC 이름이 `PENDING_DELETE` 로 남을 수 있다.

## 첫 apply 위험 및 수동 단계

1. **flavor/image 이름은 미검증.** 기본값(master `t1i.xlarge`, worker `t1i.2xlarge`, `Ubuntu 24.04`)은 다른 프로젝트의 명명 관례를 따른 것이다. 프로파일 64 에는 4 vCPU/16 GiB worker 가 가장 가깝다. 이름이 없으면 plan 이 precondition 메시지로 실패한다.
2. **NLB 소스 IP.** 31080/31443 SG ingress 는 VPC CIDR 이다. NLB 가 클라이언트 IP 를 보존하면 트래픽이 DROP 되므로 `nodeport_source_cidrs` 만 명시 대역으로 넓힌다(0.0.0.0/0, ::/0 는 거부됨; 클러스터 포트는 절대 아님).
3. **bastion IP 오프셋**(`.5`)이 Kakao 예약 대역일 수 있다. 생성 실패 시 `bastion_ip_offset` 변경.
4. **이미지 24.04 vs Vagrant 26.04 박스**: 스크립트는 26.04 에서만 검증됐다.
5. **라이브 미검증**: squid 의 443-only CONNECT 정책이 모든 레지스트리에 통하는지, NLB 뒤 Cilium NodePort, 파드의 `*.local.beluga.internal` → ClusterIP 해석, DNS 테스트 파드의 프록시 경유 `busybox` 풀. 게이트웨이는 직접(NodePort)과 NLB 경유 둘 다 확인한다(`tests/` 라이브 스위트, `docs/access-guide.md`).
6. Service 템플릿 변경으로 `docs/` 의 `apisix-gateway.yaml` 줄 번호 참조가 밀렸다.
