#!/usr/bin/env bash
# Beluga E2E Test 10: SSO/identity 경계 TLS 라이브 회귀 검증 (이슈 #2)
#
# 1) 게이트웨이 HTTP(80)가 200이 아니라 HTTPS로의 리다이렉트(3xx)만 서빙하는지.
# 2) Keycloak issuer가 HTTPS로 서빙되고, 내부 CA로 인증서 체인이 실제로 검증되는지
#    (--cacert 사용 — -k/--insecure로 우회하지 않는다. "무조건 우회 금지" 요구사항 검증).
# 3) 같은 요청을 시스템 기본 신뢰 저장소만으로(내부 CA 없이) 시도하면 반드시 실패하는지
#    — 이 인증서가 공인 CA로 조용히 통과되는 게 아님을 증명한다.
# 4) HTTP(80)→HTTPS 리다이렉트의 Location 헤더가 명시적 포트 없이 https://sso.<domain>/...여야
#    한다 — 게이트웨이가 :9443(내부 컨테이너 포트)을 그대로 흘려보내던 버그의 회귀 검증.
# 5) Superset·Airflow·Trino에서 SSO 로그인을 시작하면 Keycloak의
#    /realms/beluga/protocol/openid-connect/auth로 redirect_uri 파라미터와 함께
#    리다이렉트되는지 — OIDC 클라이언트 설정이 실제로 HTTPS issuer를 바라보는지 실측.
#    redirect_uri 값 자체도 URL-디코드해 명시적 포트가 없는지 검증한다 — 게이트웨이가
#    X-Forwarded-Port(예: 9443)를 그대로 흘려보내 앱이 redirect_uri=https://<app>:9443/...를
#    만들면 Keycloak이 등록된 redirectUri와 불일치해 거부하는 버그의 회귀 검증(실측 확인).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"

# Superset(Flask-AppBuilder)은 /login/<provider>가 표준 로그인 시작 경로.
# Airflow 3의 FAB auth manager는 별도 SPA로 /auth/ 아래에 마운트되어 있음을 실측 확인
# (같은 프로세스의 루트 SPA와 /auth/login/keycloak이 서로 다른 정적 자산 번들을 반환 —
#  2026-08-26, content-length 493 vs 488, 서로 다른 JS 청크 해시).
# macOS 기본 bash(3.2)는 연관 배열(declare -A)을 지원하지 않으므로 "이름:경로" 일반 배열로 관리한다.
# Trino는 /ui/ 접속 시 OAuth2(Task 16)가 즉시 303으로 Keycloak 인증 URL로 보낸다(실측).
SSO_LOGIN_TARGETS=(
  "superset:/login/keycloak"
  "airflow:/auth/login/keycloak"
  "trino:/ui/"
)

# URL-디코드(bash 3.2 호환 — 외부 도구 의존 없이 순수 파라미터 확장 + printf %b 사용).
url_decode() {
  local data="${1//+/ }"
  printf '%b' "${data//%/\\x}"
}

check_sso_login_redirect() {
  local app_name="$1"
  local login_url="$2"
  local header_file http_code location expected_prefix
  local redirect_uri_raw redirect_uri_decoded expected_redirect_prefix

  header_file="$(mktemp)"
  http_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -D "${header_file}" \
    -w '%{http_code}' "${login_url}")
  location=$(grep -i '^location:' "${header_file}" | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//')
  rm -f "${header_file}"

  if [[ ! "${http_code}" =~ ^3[0-9]{2}$ ]]; then
    log_error "${app_name} SSO 로그인 시작(${login_url})이 리다이렉트(3xx)가 아님 (HTTP ${http_code}) — Location: ${location:-없음}"
    return 1
  fi

  expected_prefix="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/auth"
  if [[ "${location}" != "${expected_prefix}"* ]]; then
    log_error "${app_name} SSO 로그인 리다이렉트 대상이 예상과 다름 (기대 prefix: ${expected_prefix}) — 실제: ${location}"
    return 1
  fi

  redirect_uri_raw=$(printf '%s' "${location}" | grep -oE 'redirect_uri=[^&]*' | head -1 | sed -E 's/^redirect_uri=//')
  if [[ -z "${redirect_uri_raw}" ]]; then
    log_error "${app_name} SSO 로그인 리다이렉트에 redirect_uri 파라미터가 없음: ${location}"
    return 1
  fi
  redirect_uri_decoded="$(url_decode "${redirect_uri_raw}")"

  expected_redirect_prefix="https://${app_name}.${BASE_DOMAIN}/"
  if [[ "${redirect_uri_decoded}" != "${expected_redirect_prefix}"* ]]; then
    log_error "${app_name} redirect_uri에 명시적 포트가 섞여 있거나 호스트가 다름 (기대 prefix: ${expected_redirect_prefix}) — 실제: ${redirect_uri_decoded}"
    return 1
  fi

  log_success "${app_name} SSO 로그인 리다이렉트 확인 (HTTP ${http_code}, redirect_uri=${redirect_uri_decoded})."
}

log_info "[TEST 10] SSO/identity 경계 TLS 검증..."

log_info "1/5: HTTP(80)는 200이 아니라 HTTPS 리다이렉트만 서빙해야 한다..."
HTTP_HEADER_FILE="$(mktemp)"
HTTP_CODE=$(curl -s -o /dev/null --max-time 10 -D "${HTTP_HEADER_FILE}" -w '%{http_code}' \
  "http://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration")
if [[ ! "${HTTP_CODE}" =~ ^3[0-9]{2}$ ]]; then
  log_error "HTTP(80) 요청이 리다이렉트(3xx)가 아님 — 평문으로 응답 중일 수 있음 (HTTP ${HTTP_CODE})"
  exit 1
fi
log_success "HTTP(80) → 리다이렉트 확인 (HTTP ${HTTP_CODE})."

CA_CRT_FILE="$(mktemp)"
trap 'rm -f "${CA_CRT_FILE}" "${HTTP_HEADER_FILE}"' EXIT
kubectl -n cert-manager get secret beluga-internal-ca-secret -o jsonpath='{.data.ca\.crt}' | base64 -d > "${CA_CRT_FILE}"

log_info "2/5: HTTPS issuer가 내부 CA로 인증서 체인 검증에 실제로 통과하는지 확인..."
HTTPS_CODE=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -w '%{http_code}' \
  "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration")
if [[ "${HTTPS_CODE}" != "200" ]]; then
  log_error "--cacert로 체인 검증 후에도 200이 아님 (HTTP ${HTTPS_CODE}) — 인증서/CA 배선 문제 의심"
  exit 1
fi
log_success "내부 CA로 인증서 체인 검증 통과 (HTTP ${HTTPS_CODE})."

log_info "3/5: 내부 CA 없이(시스템 기본 신뢰 저장소만) 요청하면 반드시 실패해야 한다..."
set +e
curl -s -o /dev/null --max-time 10 "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration"
NO_CA_EXIT=$?
set -e
if [[ ${NO_CA_EXIT} -eq 0 ]]; then
  log_error "내부 CA 없이도 인증서 검증이 통과함 — 공인 CA로 서명됐거나 검증이 실제로 집행되지 않음"
  exit 1
fi
log_success "내부 CA 없이는 인증서 검증 실패(exit=${NO_CA_EXIT}) — 이 인증서가 실제로 내부 CA에 묶여 있음 확인."

log_info "4/5: HTTP(80)→HTTPS 리다이렉트 Location 헤더에 명시적 포트가 없어야 한다 (:9443 버그 회귀)..."
LOCATION_HEADER=$(grep -i '^location:' "${HTTP_HEADER_FILE}" | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//')
EXPECTED_LOCATION_PREFIX="https://sso.${BASE_DOMAIN}/"
if [[ "${LOCATION_HEADER}" != "${EXPECTED_LOCATION_PREFIX}"* ]]; then
  log_error "Location 헤더가 포트 없는 https://sso.${BASE_DOMAIN}/...가 아님 — 실제: ${LOCATION_HEADER:-없음}"
  exit 1
fi
log_success "Location 헤더에 명시적 포트 없음 확인: ${LOCATION_HEADER}"

log_info "5/5: Superset·Airflow·Trino SSO 로그인 시작이 Keycloak 인증 엔드포인트로(포트 없는 redirect_uri로) 리다이렉트되는지 확인..."
for TARGET in "${SSO_LOGIN_TARGETS[@]}"; do
  APP_NAME="${TARGET%%:*}"
  LOGIN_PATH="${TARGET#*:}"
  check_sso_login_redirect "${APP_NAME}" "https://${APP_NAME}.${BASE_DOMAIN}${LOGIN_PATH}"
done

log_success "[TEST 10] SSO/identity 경계 TLS 검증 통과."
