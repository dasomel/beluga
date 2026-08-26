#!/usr/bin/env bash
# Beluga E2E Test 10: SSO/identity 경계 TLS 라이브 회귀 검증 (이슈 #2)
#
# 1) 게이트웨이 HTTP(80)가 200이 아니라 HTTPS로의 리다이렉트(3xx)만 서빙하는지.
# 2) Keycloak issuer가 HTTPS로 서빙되고, 내부 CA로 인증서 체인이 실제로 검증되는지
#    (--cacert 사용 — -k/--insecure로 우회하지 않는다. "무조건 우회 금지" 요구사항 검증).
# 3) 같은 요청을 시스템 기본 신뢰 저장소만으로(내부 CA 없이) 시도하면 반드시 실패하는지
#    — 이 인증서가 공인 CA로 조용히 통과되는 게 아님을 증명한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"

log_info "[TEST 10] SSO/identity 경계 TLS 검증..."

log_info "1/3: HTTP(80)는 200이 아니라 HTTPS 리다이렉트만 서빙해야 한다..."
HTTP_CODE=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "http://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration")
if [[ ! "${HTTP_CODE}" =~ ^3[0-9]{2}$ ]]; then
  log_error "HTTP(80) 요청이 리다이렉트(3xx)가 아님 — 평문으로 응답 중일 수 있음 (HTTP ${HTTP_CODE})"
  exit 1
fi
log_success "HTTP(80) → 리다이렉트 확인 (HTTP ${HTTP_CODE})."

CA_CRT_FILE="$(mktemp)"
trap 'rm -f "${CA_CRT_FILE}"' EXIT
kubectl -n cert-manager get secret beluga-internal-ca-secret -o jsonpath='{.data.ca\.crt}' | base64 -d > "${CA_CRT_FILE}"

log_info "2/3: HTTPS issuer가 내부 CA로 인증서 체인 검증에 실제로 통과하는지 확인..."
HTTPS_CODE=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -w '%{http_code}' \
  "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration")
if [[ "${HTTPS_CODE}" != "200" ]]; then
  log_error "--cacert로 체인 검증 후에도 200이 아님 (HTTP ${HTTPS_CODE}) — 인증서/CA 배선 문제 의심"
  exit 1
fi
log_success "내부 CA로 인증서 체인 검증 통과 (HTTP ${HTTPS_CODE})."

log_info "3/3: 내부 CA 없이(시스템 기본 신뢰 저장소만) 요청하면 반드시 실패해야 한다..."
set +e
curl -s -o /dev/null --max-time 10 "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration"
NO_CA_EXIT=$?
set -e
if [[ ${NO_CA_EXIT} -eq 0 ]]; then
  log_error "내부 CA 없이도 인증서 검증이 통과함 — 공인 CA로 서명됐거나 검증이 실제로 집행되지 않음"
  exit 1
fi
log_success "내부 CA 없이는 인증서 검증 실패(exit=${NO_CA_EXIT}) — 이 인증서가 실제로 내부 CA에 묶여 있음 확인."

log_success "[TEST 10] SSO/identity 경계 TLS 검증 통과."
