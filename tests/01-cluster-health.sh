#!/usr/bin/env bash
# Beluga E2E Test 01: Cluster & Pod Health Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 01] Verifying Kubernetes Cluster Nodes & Core Pods..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ ! -f "${KUBECONFIG_PATH}" ]]; then
  log_error "Kubeconfig file not found at ${KUBECONFIG_PATH}."
  exit 1
fi

export KUBECONFIG="${KUBECONFIG_PATH}"

log_info "1. Checking K8s node status..."
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | grep -c "Ready" || echo 0)
log_info "Found ${NODE_COUNT} Ready node(s)."

if [[ ${NODE_COUNT} -lt 4 ]]; then
  log_warn "Expected 4 nodes (1 master + 3 workers), found ${NODE_COUNT}."
else
  log_success "All 4 cluster nodes are Ready."
fi

log_info "2. Checking system pods..."
FAILED_PODS=$(kubectl get pods -A --no-headers 2>/dev/null | grep -vEc "Running|Completed" || echo 0)

if [[ ${FAILED_PODS} -eq 0 ]]; then
  log_success "All Kubernetes pods are Running or Completed."
else
  log_warn "Found ${FAILED_PODS} pod(s) not in Running/Completed state:"
  kubectl get pods -A --no-headers | grep -vE "Running|Completed" || true
fi
