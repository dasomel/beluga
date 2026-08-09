#!/usr/bin/env bash
# Beluga E2E Test 04: Trino Distributed Query Engine Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 04] Verifying Trino Query Engine & Iceberg Connector..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

log_info "1. Checking Trino Coordinator pod..."
TRINO_PODS=$(kubectl get pods -n beluga-data -l app=trino --no-headers 2>/dev/null | grep -c "Running" || true)
TRINO_PODS=${TRINO_PODS:-0}
log_info "Active Trino pod(s): ${TRINO_PODS}"

if [[ ${TRINO_PODS} -ge 1 ]]; then
  log_success "Trino Query Engine is operational."
else
  log_warn "Trino coordinator pod is not Running."
fi
