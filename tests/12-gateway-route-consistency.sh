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

log_info "2. Admin API 실측 라우트 수 조회 (break-glass 절차: apisix-gateway.yaml의 allow_admin CIDR은 애플리케이션 레벨 소스 IP 검사라 kubectl port-forward의 127.0.0.1 출발지는 통과 못 한다 — apisix-ingress-controller 라벨을 빌린 임시 디버그 파드로 조회)..."
ADMIN_KEY=$(kubectl -n platform-system get secret apisix-admin-credential -o jsonpath='{.data.key}' | base64 -d)

trap 'kubectl -n platform-system delete pod admin-route-count-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# kubectl run --rm은 정상 종료 시에도 "pod ... deleted" 안내를 stdout에 한 줄 더 얹고
# (실측) 파드 자체는 "Succeeded"라도 --rm 래퍼가 0이 아닌 종료 코드를 반환하는 경우가
# 있어(실측), set -o pipefail과 결합하면 JSON은 정상 출력됐는데도 뒤에 오탐 폴백이 또
# 붙는다 — kubectl 호출과 파싱을 분리하고 kubectl 자체의 실패는 무시한다.
set +e
RAW_ROUTES=$(kubectl -n platform-system run admin-route-count-probe --rm -i --restart=Never \
  --image=curlimages/curl:8.21.0 --timeout=30s \
  --overrides='{"metadata":{"labels":{"app":"apisix-ingress-controller"}}}' \
  --command -- curl -sf --max-time 8 -H "X-API-KEY: ${ADMIN_KEY}" \
  http://apisix-admin.platform-system.svc.cluster.local:9180/apisix/admin/routes 2>/dev/null | head -1)
set -e

LIVE_COUNT=$(printf '%s' "${RAW_ROUTES}" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(len(d.get("list", d.get("node", {}).get("nodes", []))))
except Exception:
    print(-1)' 2>/dev/null || echo "-1")

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
