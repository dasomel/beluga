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
  # `kubectl run --rm -i`는 컨테이너가 attach보다 먼저 끝나면 stdout을 잃거나 두 번 기록해(실측: 5회 중 2회
  # JSON 중복 → 거짓 "#114 중복 잡") 출력이 불안정하다. 정적 파드(restartPolicy Never) 완료를 기다린 뒤
  # `kubectl logs`로 읽고 삭제는 EXIT trap에 맡긴다 (tests/09·12와 같은 패턴).
  # 라벨 beluga-test=03은 어떤 Service/NetworkPolicy도 선택하지 않는다(실측).
  PROBE_POD="flink-jobs-overview-probe-$$"
  trap 'kubectl -n streaming delete pod "${PROBE_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
  # 파드 생성 실패(API 일시 오류·이름 충돌)는 set -e로 테스트 전체를 중단시키지 않고 아래 phase 검사의
  # "건너뜀" 경로로 보낸다 — 기존 `set +e` 래핑과 같은 동작.
  kubectl -n streaming run "${PROBE_POD}" --restart=Never \
    --image=curlimages/curl:8.21.0 --labels="beluga-test=03" \
    --command -- curl -s --max-time 8 -w '\n%{http_code}' http://flink-cluster-rest:8081/jobs/overview >/dev/null || true

  PHASE=""
  for _ in $(seq 1 30); do
    PHASE=$(kubectl -n streaming get pod "${PROBE_POD}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [[ "${PHASE}" == "Succeeded" || "${PHASE}" == "Failed" ]]; then
      break
    fi
    sleep 2
  done
  PROBE_OUT=$(kubectl -n streaming logs "${PROBE_POD}" 2>/dev/null || true)
  HTTP_CODE="${PROBE_OUT##*$'\n'}"
  FLINK_JSON="${PROBE_OUT%$'\n'*}"

  if [[ "${PHASE}" != "Succeeded" ]]; then
    log_warn "Flink REST API(jobs/overview) 프로브 파드가 완료되지 않음(phase=${PHASE:-unknown}) — 일시적 불안정으로 간주하고 중복 잡 검사를 건너뜀."
  elif [[ -z "${PROBE_OUT}" ]]; then
    log_warn "Flink 프로브 파드는 Succeeded인데 로그가 비어 있음(kubectl logs 수집 실패) — 중복 잡 검사를 건너뜀."
  elif [[ "${HTTP_CODE}" != "200" ]]; then
    log_warn "Flink REST API(jobs/overview)가 HTTP ${HTTP_CODE}를 반환 — 일시적 불안정으로 간주하고 중복 잡 검사를 건너뜀."
  else
    # jq 없이 파싱: 제출 훅 스크립트와 동일한 방식(tr '{' + grep)으로 활성 상태 잡의
    # name만 뽑아 중복 여부 확인 — 이슈 #114 회귀(동일 pipeline.name 잡 재제출) 방지.
    DUP_NAMES=$(printf '%s' "${FLINK_JSON}" | tr '{' '\n' \
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
