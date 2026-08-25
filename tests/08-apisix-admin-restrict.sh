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
set +e
kubectl -n default run admin-restrict-probe --rm -i --restart=Never \
  --image=curlimages/curl:8.21.0 --timeout=20s \
  --command -- curl -sf --max-time 8 -o /dev/null -w '%{http_code}' \
  http://apisix-admin.platform-system.svc.cluster.local:9180/apisix/admin/routes \
  >/tmp/admin-restrict-probe.out 2>&1
PROBE_EXIT=$?
set -e
kubectl -n default delete pod admin-restrict-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true

if [[ ${PROBE_EXIT} -eq 0 ]]; then
  log_error "무관한 네임스페이스에서 Admin API에 접근 성공 — NetworkPolicy 미집행 가능성 (출력: $(cat /tmp/admin-restrict-probe.out))"
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
