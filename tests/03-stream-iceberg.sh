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
FLINK_JM_PODS=$(kubectl get pods -n streaming -l app=flink-cluster,component=jobmanager --no-headers 2>/dev/null | grep -c "Running" || true)
FLINK_JM_PODS=${FLINK_JM_PODS:-0}
# 선언된 FlinkDeployment(flink-cluster)가 있으면 JobManager 0개는 "건너뜀"이 아니라 실패다 — 크래시루프
# (예: 호스트 정전 뒤 깨진 HA 체크포인트 핸들, 18시간·43회 재시작)가 PASS로 보고된 이력. CR/CRD가 없는
# 프로파일(Flink 미선언)만 건너뛴다. 그 외 kubectl 오류는 선언 여부를 알 수 없으므로 실패로 닫는다.
FLINK_CR_ERR=""
if FLINK_CR_ERR=$(kubectl -n streaming get flinkdeployment flink-cluster -o name 2>&1 >/dev/null); then
  FLINK_DECLARED=1
elif grep -qE 'NotFound|doesn.t have a resource type|no matches for kind' <<<"${FLINK_CR_ERR}"; then
  FLINK_DECLARED=0
else
  log_error "FlinkDeployment 선언 여부를 확인하지 못함: ${FLINK_CR_ERR}"
  exit 1
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
  # `kubectl run --rm -i`는 컨테이너가 attach보다 먼저 끝나면 stdout을 잃거나 두 번 기록해(실측: 5회 중 2회
  # JSON 중복 → 거짓 "#114 중복 잡") 출력이 불안정하다. 정적 파드(restartPolicy Never) 완료를 기다린 뒤
  # `kubectl logs`로 읽고 삭제는 EXIT trap에 맡긴다 (tests/09·12와 같은 패턴).
  # 라벨 beluga-test=03은 어떤 Service/NetworkPolicy도 선택하지 않는다(실측).
  PROBE_POD="flink-jobs-overview-probe-$$"
  trap 'kubectl -n streaming delete pod "${PROBE_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
  # D-FLINK-REST-1: 생성 오류도 아래 phase 검사에서 진단하고 실패한다. 비용: 추가 실패 경로.
  # 탈출구: FlinkDeployment가 미선언인 프로파일만 위 선언 검사에서 건너뛴다.
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

  if [[ "${PHASE}" != "Succeeded" || -z "${PROBE_OUT}" || "${HTTP_CODE}" != "200" ]]; then
    log_error "Flink REST(jobs/overview) 확인 실패: phase=${PHASE:-unknown}, HTTP=${HTTP_CODE:-unknown}, 로그=${PROBE_OUT:-없음} — RUNNING 잡 1개 이상인지 확인하지 못함."
    log_error "원인 확인: kubectl -n streaming logs ${PROBE_POD}; kubectl -n streaming get pods -l app=flink-cluster,component=jobmanager"
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
      log_error "원인 확인: kubectl -n streaming logs ${PROBE_POD}; kubectl -n streaming get pods -l app=flink-cluster,component=jobmanager"
      exit 1
    fi
  fi
else
  log_info "FlinkDeployment 미선언(Flink 없는 프로파일) — 중복 잡 회귀 검사를 건너뜀."
fi

log_success "Flink stream engine & Lakekeeper Iceberg REST Catalog status verified."
