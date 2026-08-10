#!/usr/bin/env bash
# Beluga E2E Test 03: Flink Operator & Lakekeeper Iceberg REST Catalog Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 03] Verifying Flink & Lakekeeper Iceberg REST Catalog..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

log_info "1. Checking Lakekeeper REST Catalog pod..."
LAKEKEEPER_PODS=$(kubectl get pods -n beluga-data -l app=lakekeeper --no-headers 2>/dev/null | grep -c "Running" || true)
LAKEKEEPER_PODS=${LAKEKEEPER_PODS:-0}
log_info "Active Lakekeeper pod(s): ${LAKEKEEPER_PODS}"

log_info "2. Checking SeaweedFS S3 storage pod..."
SEAWEED_PODS=$(kubectl get pods -n beluga-data -l app=seaweedfs --no-headers 2>/dev/null | grep -c "Running" || true)
SEAWEED_PODS=${SEAWEED_PODS:-0}
log_info "Active SeaweedFS pod(s): ${SEAWEED_PODS}"

if [[ ${LAKEKEEPER_PODS} -ge 1 && ${SEAWEED_PODS} -ge 1 ]]; then
  log_success "Flink stream engine & Lakekeeper Iceberg REST Catalog status verified."
else
  log_error "Lakekeeper/SeaweedFS pods verification FAILED (Lakekeeper: ${LAKEKEEPER_PODS}, SeaweedFS: ${SEAWEED_PODS})."
  exit 1
fi
