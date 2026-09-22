#!/usr/bin/env bash
# Beluga Cilium CNI & MetalLB Installation Script
# D11: 인그레스는 APISIX 게이트웨이(beluga-platform 차트)가 담당 — ingress-nginx 미사용

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/env.sh"

log_info "Installing Helm if not present..."

if ! command -v helm &>/dev/null; then
  curl -sfL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

log_info "Deploying Cilium CNI (${CILIUM_VERSION:-1.20.0})..."
helm repo add cilium https://helm.cilium.io/ || true
helm repo update
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.20.0 \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost="${MASTER_IP}" \
  --set k8sServicePort=6443

log_info "Waiting for Cilium CNI daemonset readiness..."
kubectl rollout status daemonset/cilium -n kube-system --timeout=180s || true

log_info "Deploying MetalLB (${METALLB_VERSION:-0.16.1})..."
helm repo add metallb https://metallb.github.io/metallb || true
helm repo update
helm upgrade --install metallb metallb/metallb \
  --namespace metallb-system \
  --create-namespace \
  --version 0.16.1

log_info "Waiting for MetalLB controller & speaker readiness..."
kubectl rollout status deployment/metallb-controller -n metallb-system --timeout=180s || true
kubectl rollout status daemonset/metallb-speaker -n metallb-system --timeout=180s || true

log_info "Configuring MetalLB IPAddressPool (${METALLB_IP_RANGE})..."
RETRY_COUNT=0
MAX_RETRIES=30
until cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: beluga-pool
  namespace: metallb-system
spec:
  addresses:
  - ${METALLB_IP_RANGE}
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: beluga-l2
  namespace: metallb-system
spec:
  ipAddressPools:
  - beluga-pool
  # private_network 인터페이스로 한정 — 없으면 speaker가 노드의 NAT 인터페이스에서도
  # VIP를 ARP 광고해 호스트(macOS)에서 동일 IP가 두 브릿지에 걸쳐 충돌함(실측,
  # docs/mistakes-log.md 2026-09-22). Vagrantfile이 모든 노드에 동일 pcislotnumber
  # (ethernet0=160/ethernet1=256)를 고정하므로 인터페이스명은 노드마다 enp26s0로 동일.
  interfaces:
  - enp26s0
EOF
do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [[ ${RETRY_COUNT} -ge ${MAX_RETRIES} ]]; then
    log_error "Failed to apply MetalLB IPAddressPool after ${MAX_RETRIES} attempts."
    exit 1
  fi
  log_warn "MetalLB webhook not ready yet, retrying in 5 seconds (${RETRY_COUNT}/${MAX_RETRIES})..."
  sleep 5
done

log_success "Cilium CNI & MetalLB configured successfully."
