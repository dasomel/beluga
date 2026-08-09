#!/usr/bin/env bash
# Beluga E2E Test 01: Cluster & Pod Health Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 01] Verifying Kubernetes Cluster Nodes & Core Pods..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

log_info "1. Checking K8s node status..."
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | grep -c "Ready" || true)
NODE_COUNT=${NODE_COUNT:-0}
log_info "Found ${NODE_COUNT} Ready node(s)."

if [[ ${NODE_COUNT} -lt 4 ]]; then
  log_warn "Expected 4 nodes (1 master + 3 workers), found ${NODE_COUNT}."
else
  log_success "All 4 cluster nodes are Ready."
fi

log_info "2. Checking system pods..."
FAILED_PODS=$(kubectl get pods -A --no-headers 2>/dev/null | grep -v -c -E "Running|Completed" || true)
FAILED_PODS=${FAILED_PODS:-0}

if [[ ${FAILED_PODS} -eq 0 ]]; then
  log_success "All Kubernetes pods are Running or Completed."
else
  log_warn "Found ${FAILED_PODS} pod(s) not in Running/Completed state:"
  kubectl get pods -A --no-headers 2>/dev/null | grep -v -E "Running|Completed" || true
fi
