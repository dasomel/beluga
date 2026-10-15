#!/usr/bin/env bash
# Kakao Cloud 부트스트랩 (scripts/up.sh 의 클라우드 대응).
# 전제: `tofu apply` 가 끝나 VM/NLB/bastion 이 떠 있다(csp/kakao-cloud/README.md).
# 하는 일: bastion 경유로 레포를 각 노드 /opt/beluga 로 rsync → 기존 scripts/cluster/*.sh 와
#          scripts/gitops/01-argocd-bootstrap.sh 를 Vagrant 와 같은 순서로 실행한다.
# 하지 않는 일: 클라우드 리소스 생성/삭제, 호스트 /etc/hosts 변경(hosts 안내만 출력).
#
# 멱등: 단계별로 재실행해도 안전하다(k3s install.sh, helm upgrade --install, kubectl apply).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib-kakao.sh"

require_cmds tofu ssh rsync python3
load_tofu_outputs

# D-KAKAO-10: 프로파일은 64 로 고정한다. 클라우드에는 "호스트 RAM 자동 감지"가 없고 VM 크기는
# terraform 변수가 정한다. (cloud-init 이 /etc/beluga/cluster.override.env 에 BELUGA_PROFILE=64 를 쓴다.)
export BELUGA_PROFILE=64

log_info "=========================================================="
log_info " Beluga on Kakao Cloud — bootstrap (profile ${BELUGA_PROFILE})"
log_info " bastion: ${BASTION_PUBLIC_IP} | master: ${MASTER_IP} | workers: ${WORKER_COUNT}"
log_info " proxy:   ${PROXY_URL} | gateway ClusterIP: ${APISIX_CLUSTER_IP}"
log_info "=========================================================="

WORKERS=("${NODES[@]:1}")

log_info "1/7 Waiting for bastion and nodes (ssh + cloud-init)..."
wait_for_ssh master-1 90
for node in "${NODES[@]}"; do
  wait_for_ssh "${node}" 90
  init_tries=0
  until ssh_host "${node}" test -f /var/lib/cloud/beluga-init-done 2>/dev/null; do
    init_tries=$((init_tries + 1))
    if [[ ${init_tries} -ge 60 ]]; then
      log_error "${node}: cloud-init did not finish after 60 attempts (10s apart) — check /var/log/cloud-init-output.log on the node"
      exit 1
    fi
    log_info "  ${node}: cloud-init still running (${init_tries}/60)..."
    sleep 10
  done
done

log_info "   Checking the egress path (bastion squid) from master-1..."
if ! ssh_host master-1 curl -fsS -o /dev/null --max-time 20 --proxy "${PROXY_URL}" https://get.k3s.io; then
  log_error "master-1 cannot reach the internet through ${PROXY_URL}. Check: bastion squid ('systemctl status squid' on beluga-bastion) and the bastion SG (3128 from the VPC)."
  exit 1
fi

log_info "2/7 Syncing repository to /opt/beluga on every node..."
# 노드 이미지에 rsync/dnsutils 가 없을 수 있다(apt 는 cloud-init 이 깐 프록시 설정을 쓴다).
for node in "${NODES[@]}"; do
  ssh_host "${node}" "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync dnsutils >/dev/null"
done
# csp/ 전체가 아니라 gitops 오버레이만 보낸다: csp/kakao-cloud/terraform 에는 생성된 개인키와
# 프로바이더 바이너리가 있어 노드로 가면 안 된다. -R 이 상대 경로(csp/kakao-cloud/gitops)를 보존한다.
# .kube 는 노드가 만든 토큰/kubeconfig 가 들어 있어 --delete 대상에서 제외한다.
cd "${BELUGA_ROOT}"
for node in "${NODES[@]}"; do
  rsync -azR --delete \
    --exclude='.kube' \
    -e "ssh -F ${SSH_CONFIG} -o BatchMode=yes" \
    ./scripts ./configs ./gitops ./csp/kakao-cloud/gitops \
    "${node}:${REMOTE_SRC}/"
done

# 원격 공통 환경: BELUGA_SRC (Vagrant 의 /vagrant 대응)
SRC_ENV="BELUGA_SRC=${REMOTE_SRC}"

log_info "3/7 Node preparation + k3s on master-1, then workers..."
remote_root master-1 "${SRC_ENV}" bash "${REMOTE_SRC}/scripts/cluster/01-node-prep.sh"
remote_root master-1 "${SRC_ENV}" bash "${REMOTE_SRC}/scripts/cluster/02-k8s-init.sh"

# 조인 토큰: master 가 ${REMOTE_SRC}/.kube/node-token 에 썼다. 워커의 같은 경로로 옮긴다
# (Vagrant 는 /vagrant 공유 폴더가 이 역할). 토큰은 로그에 찍지 않는다.
for worker in "${WORKERS[@]}"; do
  ssh_host master-1 sudo cat "${REMOTE_SRC}/.kube/node-token" \
    | ssh_host "${worker}" "umask 077; sudo tee ${REMOTE_SRC}/.kube/node-token >/dev/null"
  remote_root "${worker}" "${SRC_ENV}" bash "${REMOTE_SRC}/scripts/cluster/01-node-prep.sh"
  remote_root "${worker}" "${SRC_ENV}" bash "${REMOTE_SRC}/scripts/cluster/02-k8s-init.sh"
done

log_info "4/7 Installing CNI (Cilium) — BELUGA_LB_MODE=nodeport (no MetalLB)..."
remote_root master-1 "${SRC_ENV}" BELUGA_LB_MODE=nodeport bash "${REMOTE_SRC}/scripts/cluster/03-cni-metallb.sh"

log_info "5/7 Configuring DNS (dnsmasq on master-1, split DNS on workers)..."
# VPC DHCP DNS 를 상류로 쓴다: 노드 resolv.conf 는 systemd-resolved 스텁(127.0.0.53)뿐이라
# 10-dnsmasq.sh 의 자동 감지가 비고, 기본 폴백 8.8.8.8 은 NAT 없는 사설 서브넷에서 도달할 수 없다(D-KAKAO-8).
UPSTREAM_DNS="$(ssh_host master-1 "grep -E '^nameserver' /run/systemd/resolve/resolv.conf | awk '{print \$2}' | grep -v -E '^127\.' | tr '\n' ' '" || true)"
UPSTREAM_DNS="${UPSTREAM_DNS% }"
if [[ -z "${UPSTREAM_DNS}" ]]; then
  log_warn "VPC DNS servers not detected on master-1; dnsmasq will fall back to 8.8.8.8 (unreachable without NAT — external names resolve only via the squid proxy)."
fi
remote_root master-1 "${SRC_ENV}" "UPSTREAM_DNS=${UPSTREAM_DNS}" bash "${REMOTE_SRC}/scripts/cluster/10-dnsmasq.sh"
for worker in "${WORKERS[@]}"; do
  remote_root "${worker}" "${SRC_ENV}" bash "${REMOTE_SRC}/scripts/cluster/10-worker-dns.sh"
done

log_info "6/7 Bootstrapping ArgoCD & GitOps (Kakao overlay)..."
# ArgoCD 는 GitHub 의 HEAD(기본 브랜치)를 추적한다. values-kakao.yaml 과 csp/kakao-cloud/gitops 가
# 아직 기본 브랜치에 없으면 beluga-platform Application 이 동기화에 실패한다 → README "머지 선행".
remote_root master-1 "${SRC_ENV}" \
  "BELUGA_PLATFORM_VALUES_EXTRA=${REMOTE_SRC}/gitops/charts/beluga-platform/values-kakao.yaml" \
  "BELUGA_APP_OF_APPS=${REMOTE_SRC}/csp/kakao-cloud/gitops/app-of-apps-kakao.yaml" \
  bash "${REMOTE_SRC}/scripts/gitops/01-argocd-bootstrap.sh"

log_info "7/7 Verifying the gateway entry path from the operator side..."
if curl -sk --max-time 10 -o /dev/null -w '%{http_code}\n' --resolve "argocd.${BASE_DOMAIN}:443:${NLB_PUBLIC_IP}" "https://argocd.${BASE_DOMAIN}/" 2>/dev/null; then
  log_info "   (HTTP status above is informational; 404 until APISIX routes sync is normal)"
else
  log_warn "   NLB ${NLB_PUBLIC_IP}:443 not answering yet — NLB health checks / routes may still be converging."
fi

log_success "=========================================================="
log_success " Beluga on Kakao Cloud — bootstrap finished"
log_success " 1) kubeconfig:  bash csp/kakao-cloud/scripts/kakao-kubeconfig.sh"
log_success " 2) /etc/hosts:  ${NLB_PUBLIC_IP} trino airflow superset catalog s3 argocd sso (each .${BASE_DOMAIN})"
log_success " 3) CA trust:    the gateway uses the cluster's self-signed internal CA (unchanged)"
log_success "=========================================================="
