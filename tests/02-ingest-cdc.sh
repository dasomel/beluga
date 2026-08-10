#!/usr/bin/env bash
# Beluga E2E Test 02: Ingestion & Debezium CDC Pipeline Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 02] Verifying Strimzi Kafka & Debezium CDC Pipeline..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

log_info "1. Checking Kafka cluster status in namespace beluga-data..."
KAFKA_PODS=$(kubectl get pods -n beluga-data -l app.kubernetes.io/name=kafka --no-headers 2>/dev/null | grep -c "Running" || true)
KAFKA_PODS=${KAFKA_PODS:-0}
log_info "Active Kafka broker pod(s): ${KAFKA_PODS}"

log_info "2. Checking Debezium Kafka Connect pod..."
CONNECT_PODS=$(kubectl get pods -n beluga-data -l app.kubernetes.io/name=kafka-connect --no-headers 2>/dev/null | grep -c "Running" || true)
CONNECT_PODS=${CONNECT_PODS:-0}
log_info "Active Debezium Connect pod(s): ${CONNECT_PODS}"

if [[ ${KAFKA_PODS} -ge 1 && ${CONNECT_PODS} -ge 1 ]]; then
  log_success "Strimzi Kafka & Debezium CDC ingestion infrastructure is operational."
else
  log_error "Ingestion pods verification FAILED (Kafka: ${KAFKA_PODS}, Connect: ${CONNECT_PODS})."
  exit 1
fi
