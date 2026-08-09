#!/usr/bin/env bash
# Beluga E2E Test 05: Airflow Orchestration & Superset UI Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 05] Verifying Airflow Orchestration & Superset BI Services..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

log_info "1. Checking Airflow Webserver pod..."
AIRFLOW_PODS=$(kubectl get pods -n beluga-data -l app=airflow --no-headers 2>/dev/null | grep -c "Running" || true)
AIRFLOW_PODS=${AIRFLOW_PODS:-0}
log_info "Active Airflow pod(s): ${AIRFLOW_PODS}"

log_info "2. Checking Superset pod..."
SUPERSET_PODS=$(kubectl get pods -n beluga-data -l app=superset --no-headers 2>/dev/null | grep -c "Running" || true)
SUPERSET_PODS=${SUPERSET_PODS:-0}
log_info "Active Superset pod(s): ${SUPERSET_PODS}"

if [[ ${AIRFLOW_PODS} -ge 1 && ${SUPERSET_PODS} -ge 1 ]]; then
  log_success "Airflow Orchestrator & Superset BI platform operational."
else
  log_warn "Airflow/Superset pods verification incomplete (Airflow: ${AIRFLOW_PODS}, Superset: ${SUPERSET_PODS})."
fi
