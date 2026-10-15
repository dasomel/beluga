#!/usr/bin/env bash
# Beluga K8s Initialization Script (K3s v1.36 base with Cilium CNI)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/env.sh"

NODE_ENV_FILE="/etc/beluga/node.env"
if [[ -f "${NODE_ENV_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${NODE_ENV_FILE}"
else
  log_error "/etc/beluga/node.env not found. Run this script inside a Vagrant node."
  exit 1
fi

# D-KAKAO-5: 소스/토큰 인계 디렉터리. Vagrant는 /vagrant 동기화 폴더(기본값, 동작 불변),
# 클라우드는 kakao-up.sh 가 레포를 /opt/beluga 로 rsync 하므로 BELUGA_SRC=/opt/beluga.
BELUGA_SRC="${BELUGA_SRC:-/vagrant}"

log_info "Initializing Kubernetes node (${NODE_NAME}, Role: ${ROLE}, IP: ${NODE_IP})..."

# Cilium provides kube-proxy replacement via eBPF. Disable K3s ServiceLB, Flannel,
# and kube-proxy so there is a single Service datapath instead of competing implementations.
# K3s uses its server-side component flag to disable kube-proxy. With kube-proxy absent,
# use the cluster egress selector so the API server can still reach service endpoints.
K3S_EXEC_FLAGS="--flannel-backend=none --disable-network-policy --disable=traefik --disable=servicelb --disable-kube-proxy --egress-selector-mode=cluster --node-ip=${NODE_IP}"

if [[ "${ROLE}" == "master" ]]; then
  log_info "Installing K3s Control Plane on master..."
  # 채널 고정 — 미고정 설치는 재현 불가 드리프트 (1.36.3이 소리 없이 설치된 실측 사례)
  curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL="v${K8S_VERSION}" K3S_NODE_NAME="${NODE_NAME}" INSTALL_K3S_EXEC="${K3S_EXEC_FLAGS}" sh -

  sudo mkdir -p ~/.kube
  sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
  sudo chown "$(id -u)":"$(id -g)" ~/.kube/config
  chmod 600 ~/.kube/config

  # Copy kubeconfig for host access if mounted
  if [[ -d "${BELUGA_SRC}" ]]; then
    mkdir -p "${BELUGA_SRC}/.kube"
    # D-KAKAO-11: 클러스터 관리자 kubeconfig/조인 토큰은 클라우드(BELUGA_SRC != /vagrant)에서만
    # 0600으로 쓴다. Vagrant는 호스트(macOS)가 동기화 폴더에서 이 파일을 읽어야 하므로 기존 권한 유지.
    if [[ "${BELUGA_SRC}" != "/vagrant" ]]; then
      (umask 077; sed "s/127.0.0.1/${MASTER_IP}/g" /etc/rancher/k3s/k3s.yaml > "${BELUGA_SRC}/.kube/config")
    else
      sed "s/127.0.0.1/${MASTER_IP}/g" /etc/rancher/k3s/k3s.yaml > "${BELUGA_SRC}/.kube/config"
    fi
  fi

  # Store K3s join token
  K3S_TOKEN=$(sudo cat /var/lib/rancher/k3s/server/node-token)
  if [[ -d "${BELUGA_SRC}" ]]; then
    if [[ "${BELUGA_SRC}" != "/vagrant" ]]; then
      (umask 077; echo "${K3S_TOKEN}" > "${BELUGA_SRC}/.kube/node-token")
    else
      echo "${K3S_TOKEN}" > "${BELUGA_SRC}/.kube/node-token"
    fi
  fi

  log_success "Master node ${NODE_NAME} initialized."
else
  log_info "Joining worker node ${NODE_NAME} to master (${MASTER_IP})..."
  if [[ -f "${BELUGA_SRC}/.kube/node-token" ]]; then
    K3S_TOKEN=$(cat "${BELUGA_SRC}/.kube/node-token")
  else
    log_error "K3s node-token not found in ${BELUGA_SRC}/.kube/node-token"
    exit 1
  fi

  curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL="v${K8S_VERSION}" K3S_URL="https://${MASTER_IP}:6443" K3S_TOKEN="${K3S_TOKEN}" K3S_NODE_NAME="${NODE_NAME}" INSTALL_K3S_EXEC="--node-ip=${NODE_IP}" sh -
  log_success "Worker node ${NODE_NAME} joined."
fi
