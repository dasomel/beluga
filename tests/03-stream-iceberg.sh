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
  log_info "Lakekeeper/SeaweedFS pods are Running; Flink status is verified in step 3."
else
  log_error "Lakekeeper/SeaweedFS pods verification FAILED (Lakekeeper: ${LAKEKEEPER_PODS}, SeaweedFS: ${SEAWEED_PODS})."
  exit 1
fi

log_info "3. Checking Flink session cluster for duplicate active streaming jobs (이슈 #114 회귀 방지)..."
# D-FLINK-DECL-1: CRD만 없을 때 건너뛴다. CR/namespace NotFound는 선언된 플랫폼의 장애다.
# 비용: cluster-scoped CRD 조회 권한; 탈출구: 실제 Flink 비활성 토글 도입 시 선언 계약을 갱신한다.
# 현재 차트는 FlinkDeployment를 항상 렌더하며 flink.sqlJobsEnabled는 제출 훅만 제어한다.
if ! FLINK_CRD=$(kubectl get crd flinkdeployments.flink.apache.org --ignore-not-found -o name 2>&1); then
  log_error "Flink CRD 선언 여부를 확인하지 못함: ${FLINK_CRD}"
  exit 1
fi
FLINK_DECLARED=0
FLINK_JM_PODS=0
if [[ -n "${FLINK_CRD}" ]]; then
  FLINK_DECLARED=1
  if ! FLINK_CR_ERR=$(kubectl -n streaming get flinkdeployment flink-cluster -o name 2>&1); then
    log_error "Flink CRD가 선언돼 있는데 FlinkDeployment를 확인하지 못함: ${FLINK_CR_ERR}"
    exit 1
  fi
  FLINK_JM_PODS=$(kubectl get pods -n streaming -l app=flink-cluster,component=jobmanager --no-headers 2>/dev/null | grep -c "Running" || true)
  FLINK_JM_PODS=${FLINK_JM_PODS:-0}
fi
if [[ ${FLINK_DECLARED} -eq 1 && ${FLINK_JM_PODS} -lt 1 ]]; then
  JM_STATUS=$(kubectl get pods -n streaming -l app=flink-cluster,component=jobmanager \
    -o jsonpath='{range .items[*]}{.metadata.name}{" restarts="}{.status.containerStatuses[0].restartCount}{" phase="}{.status.phase}{"\n"}{end}' 2>/dev/null || true)
  JM_POD=$(head -1 <<<"${JM_STATUS}" | cut -d' ' -f1)
  log_error "FlinkDeployment flink-cluster가 선언돼 있는데 Running JobManager 파드가 없음: ${JM_STATUS:-파드 없음}"
  log_error "원인 확인: kubectl -n streaming logs ${JM_POD:-<jobmanager-pod>} --previous"
  exit 1
fi
if [[ ${FLINK_DECLARED} -eq 1 ]]; then
  # D-FLINK-REST-2: JobManager 내부 localhost로 조회해 ingress 허용 대상을 테스트용으로 넓히지 않는다.
  # 비용: JobManager 이미지의 curl 및 pods/exec 권한 필요; 탈출구: 이미지 변경 시 조회 도구를 함께 갱신한다.
  JM_POD=$(kubectl -n streaming get pods -l app=flink-cluster,component=jobmanager \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  REST_OUT=""
  EXEC_RC=1
  if [[ -n "${JM_POD}" ]]; then
    EXEC_RC=0
    REST_OUT=$(kubectl -n streaming exec "${JM_POD}" -- curl -s --max-time 8 -o - \
      -w '\n%{http_code}' http://localhost:8081/jobs/overview) || EXEC_RC=$?
  fi
  HTTP_CODE="${REST_OUT##*$'\n'}"
  FLINK_JSON="${REST_OUT%$'\n'*}"

  if [[ ${EXEC_RC} -ne 0 || -z "${REST_OUT}" || "${HTTP_CODE}" != "200" ]]; then
    log_error "Flink REST(jobs/overview) 확인 실패: exec rc=${EXEC_RC}, HTTP=${HTTP_CODE:-unknown}, 응답=${REST_OUT:-없음} — RUNNING 잡 1개 이상인지 확인하지 못함."
    log_error "원인 확인: kubectl -n streaming logs ${JM_POD:-<jobmanager-pod>}; kubectl -n streaming get pods -l app=flink-cluster,component=jobmanager"
    exit 1
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
    # 선언된 Flink는 RUNNING 잡이 1개 이상이어야 한다 (JobManager만 떠 있고 잡이 없는 상태도 장애).
    RUNNING_JOBS=$( (printf '%s' "${FLINK_JSON}" | grep -o '"state":"RUNNING"' | wc -l | tr -d ' ') || true)
    if [[ ${FLINK_DECLARED} -eq 1 && ${RUNNING_JOBS} -lt 1 ]]; then
      log_error "Flink REST(jobs/overview)가 RUNNING 잡 0개를 보고함 — 스트리밍 잡이 실행 중이지 않음: ${FLINK_JSON}"
      log_error "원인 확인: kubectl -n streaming logs ${JM_POD:-<jobmanager-pod>}; kubectl -n streaming get pods -l app=flink-cluster,component=jobmanager"
      exit 1
    fi
  fi
else
  log_info "FlinkDeployment 미선언(Flink 없는 프로파일) — 중복 잡 회귀 검사를 건너뜀."
fi

log_success "Flink stream engine & Lakekeeper Iceberg REST Catalog status verified."
