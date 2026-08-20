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

log_info "1. Checking Kafka cluster status in namespace streaming..."
KAFKA_PODS=$(kubectl get pods -n streaming -l app.kubernetes.io/name=kafka --no-headers 2>/dev/null | grep -c "Running" || true)
KAFKA_PODS=${KAFKA_PODS:-0}
log_info "Active Kafka broker pod(s): ${KAFKA_PODS}"

log_info "2. Checking Debezium Kafka Connect pod (독립 Deployment, D6)..."
CONNECT_PODS=$(kubectl get pods -n streaming -l app=debezium-connect --no-headers 2>/dev/null | grep -c "Running" || true)
CONNECT_PODS=${CONNECT_PODS:-0}
log_info "Active Debezium Connect pod(s): ${CONNECT_PODS}"

if [[ ${KAFKA_PODS} -ge 1 && ${CONNECT_PODS} -ge 1 ]]; then
  log_success "Strimzi Kafka & Debezium CDC ingestion infrastructure is operational."
else
  log_error "Ingestion pods verification FAILED (Kafka: ${KAFKA_PODS}, Connect: ${CONNECT_PODS})."
  exit 1
fi

log_info "3. Checking shop-cdc connector task state (Connect REST 실조회)..."
TASK_STATE=$(kubectl -n streaming exec deploy/debezium-connect -- \
  curl -sf http://localhost:8083/connectors/shop-cdc/status 2>/dev/null \
  | grep -o '"state":"[A-Z]*"' | sed -n '2p' | cut -d'"' -f4 || true)
log_info "shop-cdc task0 state: ${TASK_STATE:-UNKNOWN}"
if [[ "${TASK_STATE:-}" != "RUNNING" ]]; then
  log_error "shop-cdc connector task is not RUNNING (state: ${TASK_STATE:-UNKNOWN})."
  exit 1
fi

log_info "4. Checking CDC topics exist (Kafka 실조회)..."
CDC_TOPICS=$(kubectl -n streaming exec beluga-kafka-mixed-0 -- \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null \
  | grep -c "^cdc\.shop\." || true)
log_info "cdc.shop.* topics: ${CDC_TOPICS:-0}"
if [[ ${CDC_TOPICS:-0} -lt 2 ]]; then
  log_error "Expected >=2 cdc.shop.* topics (orders, customers), found ${CDC_TOPICS:-0}."
  exit 1
fi
log_success "CDC pipeline verified end-to-end: connector RUNNING, topics present."
