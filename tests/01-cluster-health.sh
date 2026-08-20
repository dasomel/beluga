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
  log_error "Expected 4 nodes (1 master + 3 workers), found ${NODE_COUNT}."
  exit 1
else
  log_success "All 4 cluster nodes are Ready."
fi

log_info "2. Checking system pods..."
FAILED_PODS=$(kubectl get pods -A --no-headers 2>/dev/null | grep -v -c -E "Running|Completed" || true)
FAILED_PODS=${FAILED_PODS:-0}

if [[ ${FAILED_PODS} -eq 0 ]]; then
  log_success "All Kubernetes pods are Running or Completed."
else
  log_error "Found ${FAILED_PODS} pod(s) not in Running/Completed state:"
  FAIL_GATE=1
  kubectl get pods -A --no-headers 2>/dev/null | grep -v -E "Running|Completed" || true
fi

log_info "3. Checking Service datapath ownership..."
if kubectl get pods -n kube-system --no-headers 2>/dev/null | grep -q 'cilium-'; then
  log_success "Cilium is deployed in kube-system."
else
  log_error "Cilium pods were not found in kube-system."
  FAIL_GATE=1
fi

if kubectl get pods -A --no-headers 2>/dev/null | grep -qE '(^|[[:space:]])kube-proxy(-|[[:space:]])'; then
  log_error "kube-proxy pods are present; Cilium kube-proxy replacement is not exclusive."
  kubectl get pods -A -o wide | grep -E '(^|[[:space:]])kube-proxy(-|[[:space:]])' || true
  FAIL_GATE=1
else
  log_success "No kube-proxy pods found; Cilium owns the Service datapath."
fi

# 실패는 그대로 종료 코드로 전파 — 성공 하드코딩 금지 (§7)
if [[ ${FAIL_GATE:-0} -eq 1 ]]; then
  exit 1
fi
log_success "[TEST 01] Cluster health verification passed."
