#!/usr/bin/env bash
# Beluga Cilium CNI & MetalLB Installation Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/env.sh"

log_info "Installing Helm & Cilium CLI if not present..."

if ! command -v helm &>/dev/null; then
  curl -sfL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

log_info "Deploying Cilium CNI (${CILIUM_VERSION:-1.16.5})..."
helm repo add cilium https://helm.cilium.io/ || true
helm repo update
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.16.5 \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true

log_info "Deploying MetalLB (${METALLB_VERSION:-0.14.9})..."
helm repo add metallb https://metallb.github.io/metallb || true
helm repo update
helm upgrade --install metallb metallb/metallb \
  --namespace metallb-system \
  --create-namespace \
  --version 0.14.9

log_info "Configuring MetalLB IPAddressPool (${METALLB_IP_RANGE})..."
cat <<EOF | kubectl apply -f -
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
EOF

log_success "Cilium CNI & MetalLB installed and configured successfully."
