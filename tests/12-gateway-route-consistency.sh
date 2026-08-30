#!/usr/bin/env bash
# Beluga E2E Test 12: 게이트웨이 라우트 상태 정합성 검증 (이슈 #109)
#
# apisix-etcd가 상태를 잃으면(재기동 등) ApisixRoute CR은 그대로인데 실제 APISIX
# Admin API의 라우트가 0개(또는 CR보다 적음)로 남는 조용한 디싱크가 재발할 수 있다.
# CR 선언 수와 Admin API 실측 라우트 수를 직접 대조해, 겉보기엔 컨트롤러가 Running이어도
# 실제로는 재동기화가 멈춘 상태(이슈 #109의 근본 증상)를 탐지한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

log_info "[TEST 12] 게이트웨이 라우트 상태 정합성 검증..."

CR_COUNT=$(kubectl get apisixroute -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
log_info "1. 선언된 ApisixRoute CR 수: ${CR_COUNT}"
if [[ "${CR_COUNT}" -eq 0 ]]; then
  log_error "ApisixRoute CR이 0개 — 배포 자체가 안 된 것으로 보여 이 테스트로 판정 불가"
  exit 1
fi

log_info "2. Admin API 포트포워드로 실제 라우트 수 조회 (NetworkPolicy는 파드 간 트래픽만 제한 — break-glass 절차와 동일)..."
ADMIN_KEY=$(kubectl -n platform-system get secret apisix-admin-credential -o jsonpath='{.data.key}' | base64 -d)

kubectl -n platform-system port-forward deploy/apisix-ingress-controller 19180:9180 >/tmp/apisix-admin-pf.log 2>&1 &
PF_PID=$!
trap 'kill ${PF_PID} >/dev/null 2>&1 || true' EXIT
sleep 3

LIVE_COUNT=$(curl -sf --max-time 8 -H "X-API-KEY: ${ADMIN_KEY}" \
  http://127.0.0.1:19180/apisix/admin/routes 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("list", d.get("node", {}).get("nodes", []))))' 2>/dev/null || echo "-1")

kill "${PF_PID}" >/dev/null 2>&1 || true
trap - EXIT

if [[ "${LIVE_COUNT}" == "-1" ]]; then
  log_error "Admin API 조회 실패 — apisix-ingress-controller 파드/포트포워드 상태 확인 필요"
  exit 1
fi
log_info "   Admin API 실측 라우트 수: ${LIVE_COUNT}"

if [[ "${LIVE_COUNT}" -lt "${CR_COUNT}" ]]; then
  log_error "실측 라우트(${LIVE_COUNT})가 선언된 CR(${CR_COUNT})보다 적음 — 컨트롤러 재동기화가 멈춘 디싱크 상태(이슈 #109 재발 의심)"
  exit 1
fi

log_success "[TEST 12] 라우트 CR(${CR_COUNT})과 Admin API 실측(${LIVE_COUNT})이 정합함."
