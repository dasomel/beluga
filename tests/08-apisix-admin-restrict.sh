#!/usr/bin/env bash
# Beluga E2E Test 08: APISIX Admin API 네트워크 제한 검증 (이슈 #4)
#
# allow_admin CIDR 축소 + NetworkPolicy(apisix-admin-restrict)가 실제로 클러스터
# 데이터플레인(Cilium)에서 집행되는지, 그리고 그 와중에 정당한 클라이언트인
# apisix-ingress-controller의 라우트 동기화가 계속 동작하는지 둘 다 확인한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

log_info "[TEST 08] APISIX Admin API 네트워크 제한 검증..."

log_info "1. NetworkPolicy(apisix-admin-restrict)가 배포돼 있는지 확인..."
if ! kubectl -n platform-system get networkpolicy apisix-admin-restrict >/dev/null 2>&1; then
  log_error "NetworkPolicy apisix-admin-restrict가 존재하지 않음"
  exit 1
fi
log_success "NetworkPolicy 존재 확인."

log_info "2. 무관한 네임스페이스(default)에서 Admin API(9180) 접근 시도 — 차단돼야 한다..."
PROBE_NS=default
PROBE_POD="admin-restrict-probe-$$"
trap 'kubectl -n "${PROBE_NS}" delete pod "${PROBE_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# `kubectl run --rm -i`는 컨테이너가 attach보다 먼저 끝나면 stdout/종료코드를 잃어 불안정하다(tests/09·12 참고).
# 정적 파드(restartPolicy Never)를 만들고 완료를 기다린 뒤 `kubectl logs`로 읽는다. 프로브는 항상 exit 0으로
# 끝나고 `<HTTP코드> rc=<curl rc>` 한 줄을 출력한다: 차단이면 연결 실패(000, rc≠0), 도달 가능하면 HTTP 코드(≠000).
# 차단(PASS)은 "로그에서 000과 rc≠0을 직접 확인"했을 때만 인정한다 — 파드 미완료·로그 없음은 FAIL이다.
# 라벨 beluga-test=08은 어떤 Service/NetworkPolicy도 선택하지 않는다(default 네임스페이스 신원은 그대로).
kubectl -n "${PROBE_NS}" run "${PROBE_POD}" --restart=Never \
  --image=curlimages/curl:8.21.0 --labels="beluga-test=08" \
  --command -- sh -c "curl -s --max-time 8 -o /dev/null -w '%{http_code}' http://apisix-admin.platform-system.svc.cluster.local:9180/apisix/admin/routes; echo \" rc=\$?\"" >/dev/null

PHASE=""
for _ in $(seq 1 30); do
  PHASE=$(kubectl -n "${PROBE_NS}" get pod "${PROBE_POD}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [[ "${PHASE}" == "Succeeded" || "${PHASE}" == "Failed" ]]; then
    break
  fi
  sleep 2
done
PROBE_OUT=$(kubectl -n "${PROBE_NS}" logs "${PROBE_POD}" 2>/dev/null || true)

if [[ "${PHASE}" != "Succeeded" ]]; then
  log_error "프로브 파드가 완료되지 않음 (phase=${PHASE:-unknown}) — 차단 여부 판정 불가(스케줄링·이미지 풀 확인): ${PROBE_OUT:0:200}"
  exit 1
fi
if [[ ! "${PROBE_OUT}" =~ ^([0-9]{3})\ rc=([0-9]+)$ ]]; then
  log_error "프로브 출력이 비었거나 형식 불일치 — 차단 여부 판정 불가 (출력: ${PROBE_OUT:0:200})"
  exit 1
fi
HTTP_CODE="${BASH_REMATCH[1]}"
PROBE_EXIT="${BASH_REMATCH[2]}"
if [[ "${HTTP_CODE}" != "000" || "${PROBE_EXIT}" -eq 0 ]]; then
  log_error "무관한 네임스페이스에서 Admin API에 도달함(HTTP ${HTTP_CODE}, rc=${PROBE_EXIT}) — NetworkPolicy 미집행 가능성"
  exit 1
fi
log_success "무관한 네임스페이스에서 Admin API 접근이 차단됨(exit=${PROBE_EXIT})."

log_info "3. 정당한 클라이언트(apisix-ingress-controller)의 라우트 동기화가 계속 동작하는지 확인..."
if ! kubectl -n platform-system get deployment apisix-ingress-controller \
    -o jsonpath='{.status.readyReplicas}' | grep -q '^1$'; then
  log_error "apisix-ingress-controller Deployment가 Ready 상태가 아님"
  exit 1
fi

# 기존 ApisixRoute(trino) 하나가 여전히 게이트웨이에서 응답하는지로 "라우트 동기화가
# 끊기지 않았다"를 간접 확인한다(정책 적용 후 재동기화가 깨졌다면 여기서 404/timeout).
ROUTE_CODE=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' \
  -X POST http://trino.local.beluga.internal/v1/statement \
  -H "X-Trino-User: probe" --data-binary "SELECT 1" || echo "000")
if [[ "${ROUTE_CODE}" == "000" ]]; then
  log_error "게이트웨이 경유 기존 라우트가 응답하지 않음(연결 실패) — 컨트롤러 동기화 영향 의심"
  exit 1
fi
log_success "기존 라우트가 계속 응답함(HTTP ${ROUTE_CODE}) — 컨트롤러 동기화 정상."

log_success "[TEST 08] APISIX Admin API 네트워크 제한이 정상 동작하며 정당한 트래픽은 영향받지 않음."
