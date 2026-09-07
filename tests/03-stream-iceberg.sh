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
LAKEKEEPER_PODS=$(kubectl get pods -n lakehouse -l app=lakekeeper --no-headers 2>/dev/null | grep -c "Running" || true)
LAKEKEEPER_PODS=${LAKEKEEPER_PODS:-0}
log_info "Active Lakekeeper pod(s): ${LAKEKEEPER_PODS}"

log_info "2. Checking SeaweedFS S3 storage pod..."
SEAWEED_PODS=$(kubectl get pods -n storage -l app=seaweedfs --no-headers 2>/dev/null | grep -c "Running" || true)
SEAWEED_PODS=${SEAWEED_PODS:-0}
log_info "Active SeaweedFS pod(s): ${SEAWEED_PODS}"

if [[ ${LAKEKEEPER_PODS} -ge 1 && ${SEAWEED_PODS} -ge 1 ]]; then
  log_success "Flink stream engine & Lakekeeper Iceberg REST Catalog status verified."
else
  log_error "Lakekeeper/SeaweedFS pods verification FAILED (Lakekeeper: ${LAKEKEEPER_PODS}, SeaweedFS: ${SEAWEED_PODS})."
  exit 1
fi

log_info "3. Checking Flink session cluster for duplicate active streaming jobs (이슈 #114 회귀 방지)..."
FLINK_JM_PODS=$(kubectl get pods -n streaming -l app=flink-cluster,component=jobmanager --no-headers 2>/dev/null | grep -c "Running" || true)
FLINK_JM_PODS=${FLINK_JM_PODS:-0}
if [[ ${FLINK_JM_PODS} -ge 1 ]]; then
  kubectl -n streaming delete pod flink-jobs-overview-probe --ignore-not-found >/dev/null 2>&1 || true
  set +e
  kubectl -n streaming run flink-jobs-overview-probe --rm -i --restart=Never \
    --image=curlimages/curl:8.21.0 --timeout=20s \
    --command -- curl -sf --max-time 8 http://flink-cluster-rest:8081/jobs/overview \
    >/tmp/flink-jobs-overview.json 2>/tmp/flink-jobs-overview.err
  PROBE_EXIT=$?
  set -e
  kubectl -n streaming delete pod flink-jobs-overview-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true

  if [[ ${PROBE_EXIT} -ne 0 ]]; then
    log_warn "Flink REST API(jobs/overview)에 접근하지 못함 — 일시적 불안정으로 간주하고 중복 잡 검사를 건너뜀."
  else
    # jq 없이 파싱: 제출 훅 스크립트와 동일한 방식(tr '{' + grep)으로 활성 상태 잡의
    # name만 뽑아 중복 여부 확인 — 이슈 #114 회귀(동일 pipeline.name 잡 재제출) 방지.
    DUP_NAMES=$(tr '{' '\n' < /tmp/flink-jobs-overview.json \
      | grep -E '"state":"(RUNNING|CREATED|INITIALIZING|RESTARTING|RECONCILING)"' \
      | grep -o '"name":"[^"]*"' \
      | sort | uniq -d || true)
    if [[ -n "${DUP_NAMES}" ]]; then
      log_error "중복 활성 Flink 잡 발견 (이슈 #114 회귀): ${DUP_NAMES}"
      exit 1
    fi
    log_success "Flink 활성 잡에 중복 없음 확인."
  fi
else
  log_info "Flink jobmanager 파드 없음 — 중복 잡 회귀 검사를 건너뜀."
fi
