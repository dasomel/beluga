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

PROBE_NS=platform-system
PROBE_POD="admin-route-count-probe-$$"
trap 'kubectl -n "${PROBE_NS}" delete pod "${PROBE_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

# `kubectl run --rm -i`는 컨테이너가 attach보다 먼저 끝나면 stdout을 잃고(실측: 10회 중 3회 rc=1),
# 정상 출력에도 "pod ... deleted" 안내가 섞인다. 정적 파드(restartPolicy Never) 완료를 기다린 뒤
# `kubectl logs`로 읽고 삭제는 EXIT trap에 맡겨 출력 캡처와 파드 생명주기를 분리한다 (tests/09와 같은 패턴).
# 프로브는 HTTP 코드를 마지막 줄에 덧붙여 "무응답 / HTTP 오류 / 개수 불일치"를 구분한다.
# 라벨 app=apisix-ingress-controller는 어떤 Service도 선택하지 않음(실측)이라 엔드포인트에 섞이지 않는다.
kubectl -n "${PROBE_NS}" run "${PROBE_POD}" --restart=Never \
  --image=curlimages/curl:8.21.0 \
  --labels="app=apisix-ingress-controller,beluga-test=12" \
  --command -- sh -c "curl -s --max-time 8 -w '\n%{http_code}' -H 'X-API-KEY: ${ADMIN_KEY}' http://apisix-admin.platform-system.svc.cluster.local:9180/apisix/admin/routes" >/dev/null

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
  log_error "프로브 파드가 완료되지 않음 (phase=${PHASE:-unknown}) — curl 실패(rc≠0)·스케줄링·이미지 풀 확인 필요: ${PROBE_OUT:0:200}"
  exit 1
fi
if [[ -z "${PROBE_OUT}" ]]; then
  log_error "프로브 파드는 Succeeded인데 로그가 비어 있음 — kubectl logs 수집 실패"
  exit 1
fi
HTTP_CODE="${PROBE_OUT##*$'\n'}"
RAW_ROUTES="${PROBE_OUT%$'\n'*}"
if [[ "${HTTP_CODE}" != "200" ]]; then
  log_error "Admin API가 HTTP ${HTTP_CODE}를 반환 (200 아님) — 응답: ${RAW_ROUTES:0:200}"
  exit 1
fi

LIVE_COUNT=$(printf '%s' "${RAW_ROUTES}" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(len(d.get("list", d.get("node", {}).get("nodes", []))))
except Exception:
    print(-1)' 2>/dev/null || echo "-1")

if [[ "${LIVE_COUNT}" == "-1" ]]; then
  log_error "Admin API가 HTTP 200이지만 응답 JSON 파싱 실패"
  exit 1
fi
log_info "   Admin API 실측 라우트 수: ${LIVE_COUNT}"

if [[ "${LIVE_COUNT}" -lt "${CR_COUNT}" ]]; then
  log_error "실측 라우트(${LIVE_COUNT})가 선언된 CR(${CR_COUNT})보다 적음 — 컨트롤러 재동기화가 멈춘 디싱크 상태(이슈 #109 재발 의심)"
  exit 1
fi

log_success "[TEST 12] 라우트 CR(${CR_COUNT})과 Admin API 실측(${LIVE_COUNT})이 정합함."
