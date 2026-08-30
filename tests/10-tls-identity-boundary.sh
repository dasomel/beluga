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
# 5) Superset·Trino에서 SSO 로그인을 시작하면 Keycloak의
#    /realms/beluga/protocol/openid-connect/auth로 redirect_uri 파라미터와 함께
#    리다이렉트되는지 — OIDC 클라이언트 설정이 실제로 HTTPS issuer를 바라보는지 실측.
#    redirect_uri 값 자체도 URL-디코드해 명시적 포트가 없는지 검증한다 — 게이트웨이가
#    X-Forwarded-Port(예: 9443)를 그대로 흘려보내 앱이 redirect_uri=https://<app>:9443/...를
#    만들면 Keycloak이 등록된 redirectUri와 불일치해 거부하는 버그의 회귀 검증(실측 확인).
#    이어서 그 인증 엔드포인트를 실제로 따라가 200 로그인 폼이 뜨는지까지 확인한다 —
#    이슈 #111 실측: 리다이렉트 자체는 정상이어도 Keycloak이 즉시 302로
#    ?error=invalid_scope를 실어 앱으로 되돌리는(로그인 폼까지 도달 못 하는) 결함이 있었다.
# 6) Airflow는 위 5)의 방식으로 검증할 수 없다 — /auth/login/keycloak이 서버사이드 302가
#    아니라 로그인 SPA(200 HTML)를 직접 반환하고, 실제 Keycloak 리다이렉트는 그 안의 JS가
#    브라우저에서 수행해 curl로는 관측 불가능하다(실측, 이슈 #111 검증 중 발견 — 이전에는
#    이 사실을 몰라 SSO_LOGIN_TARGETS에 airflow를 5)와 같은 방식으로 넣어 뒀었고, 그 응답에
#    Location 헤더가 없어 pipefail 아래에서 로그 한 줄 없이 스크립트가 죽는 별도 결함까지
#    있었다). 그래서 airflow의 실제 OIDC client_id/redirect_uri/scope(webserver_config.py의
#    OAUTH_PROVIDERS 설정과 keycloak-clients.yaml의 defaultClientScopes 목표값)로 Keycloak
#    인증 엔드포인트 URL을 직접 구성해, invalid_scope로 되돌아가지 않고 200 로그인 폼이
#    뜨는지를 5)와 동일한 기준으로 확인한다.
# 7) Trino도 5)의 방식으로 검증할 수 없게 됐다 — 이슈 #110(Trino가 oauth2 단독에서
#    oauth2,PASSWORD 복수 스킴으로 전환된 뒤) 실측: /ui/는 이제 즉시 303이 아니라 SPA
#    셸(200 HTML)을 직접 반환하고 실제 인증 협상은 클라이언트가 보호된 API를 호출할 때
#    일어난다. 그래서 보호된 API(POST /v1/statement)를 인증 없이 호출해 401과 함께
#    WWW-Authenticate에 Bearer(oauth2, x_redirect_server가 실제 Keycloak 인증 URL)와
#    Basic(PASSWORD) 두 스킴이 모두 실려 오는지로 대체 검증한다 — 데이터 API 자체는
#    여전히 인증 없이 통과되지 않음을 증명하는 것이 핵심이다(SPA 셸의 200은 정적 자산일
#    뿐 데이터 노출이 아님, 실측 확인).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"

# Superset(Flask-AppBuilder)은 /login/<provider>가 표준 로그인 시작 경로.
# macOS 기본 bash(3.2)는 연관 배열(declare -A)을 지원하지 않으므로 "이름:경로" 일반 배열로 관리한다.
# Trino·Airflow는 여기 없다 — 파일 헤더 6)·7)번 참고, 별도 방식으로 검증한다
# (Trino는 이슈 #110로 /ui/가 더 이상 서버사이드 리다이렉트를 하지 않는다).
SSO_LOGIN_TARGETS=(
  "superset:/login/keycloak"
)

# URL-디코드(bash 3.2 호환 — 외부 도구 의존 없이 순수 파라미터 확장 + printf %b 사용).
url_decode() {
  local data="${1//+/ }"
  printf '%b' "${data//%/\\x}"
}

# URL-인코드(bash 3.2 호환 — RFC 3986 unreserved만 통과, 나머지는 %XX).
url_encode() {
  local string="$1" length pos c encoded=""
  length=${#string}
  for (( pos=0; pos<length; pos++ )); do
    c="${string:pos:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) encoded+="$c" ;;
      *) encoded+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$encoded"
}

check_sso_login_redirect() {
  local app_name="$1"
  local login_url="$2"
  local header_file http_code location expected_prefix
  local redirect_uri_raw redirect_uri_decoded expected_redirect_prefix

  header_file="$(mktemp)"
  http_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -D "${header_file}" \
    -w '%{http_code}' "${login_url}")
  # airflow처럼 응답에 Location 헤더가 아예 없으면 grep이 매치 실패(exit 1)로 끝나고,
  # set -o pipefail 아래에서는 이 대입 자체가 실패해 script가 로그 한 줄 없이 죽는다
  # (실측: airflow SPA 라우트가 200 HTML을 직접 반환해 재현) — `|| true`로 "매치 없음"을
  # 빈 문자열로 흡수하고, 판정은 아래 http_code 검사가 담당하게 한다.
  location=$( (grep -i '^location:' "${header_file}" | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//') || true)
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

  redirect_uri_raw=$( (printf '%s' "${location}" | grep -oE 'redirect_uri=[^&]*' | head -1 | sed -E 's/^redirect_uri=//') || true)
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

  # 이슈 #111 회귀: 리다이렉트 자체(위 검증들)는 정상이어도 realm의 client-scope 구성이
  # 어긋나 있으면 Keycloak이 이 인증 엔드포인트에서 즉시 302 ?error=invalid_scope로
  # redirect_uri에 되돌린다 — 로그인 폼(200)까지 실제로 도달하는지 따라가서 확인한다.
  local auth_http_code
  auth_http_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -w '%{http_code}' "${location}")
  if [[ "${auth_http_code}" != "200" ]]; then
    log_error "${app_name} Keycloak 인증 엔드포인트가 200 로그인 폼을 반환하지 않음 (HTTP ${auth_http_code}) — client-scope 미구성(invalid_scope) 등 realm 결함 의심. URL: ${location}"
    return 1
  fi

  log_success "${app_name} SSO 로그인 리다이렉트 확인 (HTTP ${http_code}, redirect_uri=${redirect_uri_decoded}), 인증 엔드포인트 200 로그인 폼 확인."
}

# 파일 헤더 6)·SSO_LOGIN_TARGETS 옆 주석 참고 — airflow는 로그인 시작이 서버사이드 302가
# 아니라 SPA(200 HTML)라 curl로 리다이렉트를 따라갈 수 없다. 그래서 Keycloak 인증
# 엔드포인트 URL을 여기서 직접 구성해(client_id/redirect_uri/scope는 webserver_config.py의
# OAUTH_PROVIDERS 설정·keycloak-clients.yaml의 defaultClientScopes 목표값과 일치해야
# 회귀를 잡는다) invalid_scope로 되돌아가지 않고 200 로그인 폼이 뜨는지 확인한다.
check_airflow_auth_scope() {
  local redirect_uri auth_url auth_http_code
  redirect_uri="$(url_encode "https://airflow.${BASE_DOMAIN}/auth/oauth-authorized/keycloak")"
  auth_url="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/auth?response_type=code&client_id=airflow&redirect_uri=${redirect_uri}&scope=openid+email+profile"

  auth_http_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -w '%{http_code}' "${auth_url}")
  if [[ "${auth_http_code}" != "200" ]]; then
    log_error "airflow Keycloak 인증 엔드포인트가 200 로그인 폼을 반환하지 않음 (HTTP ${auth_http_code}) — client-scope 미구성(invalid_scope) 등 realm 결함 의심. URL: ${auth_url}"
    return 1
  fi
  log_success "airflow Keycloak 인증 엔드포인트 200 로그인 폼 확인 (client_id=airflow, scope=openid email profile)."
}

# 파일 헤더 7) 참고 — 이슈 #110 이후 Trino /ui/는 SPA 셸을 직접(200) 반환해 5)의 리다이렉트
# 추적 방식이 통하지 않는다. 대신 보호된 데이터 API가 인증 없이는 여전히 거부되는지,
# 그리고 그 401 응답에 oauth2(Bearer)·PASSWORD(Basic) 두 스킴이 모두 광고되는지 확인한다.
check_trino_auth_scheme() {
  local header_file http_code www_auth initiate_url initiate_code location

  header_file="$(mktemp)"
  http_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -D "${header_file}" \
    -w '%{http_code}' -X POST "https://trino.${BASE_DOMAIN}/v1/statement" \
    -H "X-Trino-User: probe" --data-binary "SELECT 1")
  www_auth=$(grep -i '^www-authenticate:' "${header_file}" || true)
  rm -f "${header_file}"

  if [[ "${http_code}" != "401" ]]; then
    log_error "trino 보호된 API(POST /v1/statement)가 인증 없이 401이 아님 (HTTP ${http_code}) — 데이터 API 인증 우회 의심"
    return 1
  fi
  if ! printf '%s' "${www_auth}" | grep -qi 'basic realm="trino"'; then
    log_error "trino 401 응답의 WWW-Authenticate에 PASSWORD(Basic) 스킴이 없음 — 이슈 #110 서비스 연결 인증 경로 회귀 의심: ${www_auth}"
    return 1
  fi

  # oauth2(Bearer) 챌린지의 x_redirect_server는 Keycloak을 직접 가리키지 않고 Trino
  # 자신의 부트스트랩 엔드포인트(/oauth2/token/initiate/...)다 — 그 한 홉을 실제로
  # 따라가야 최종적으로 sso.<domain>에 도달하는지 검증된다(실측 확인).
  initiate_url=$(printf '%s' "${www_auth}" | grep -oE 'x_redirect_server="[^"]*"' | head -1 | sed -E 's/^x_redirect_server="//; s/"$//')
  if [[ -z "${initiate_url}" || "${initiate_url}" != "https://trino.${BASE_DOMAIN}/"* ]]; then
    log_error "trino 401 응답의 WWW-Authenticate에 oauth2(Bearer x_redirect_server, trino.${BASE_DOMAIN} 자체 부트스트랩 엔드포인트)가 없거나 호스트가 다름: ${www_auth}"
    return 1
  fi

  header_file="$(mktemp)"
  initiate_code=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -D "${header_file}" \
    -w '%{http_code}' "${initiate_url}")
  location=$( (grep -i '^location:' "${header_file}" | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//') || true)
  rm -f "${header_file}"

  if [[ ! "${initiate_code}" =~ ^3[0-9]{2}$ ]] || [[ "${location}" != "https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/auth"* ]]; then
    log_error "trino oauth2 부트스트랩 엔드포인트가 sso.${BASE_DOMAIN} 인증 URL로 리다이렉트하지 않음 (HTTP ${initiate_code}) — Location: ${location:-없음}"
    return 1
  fi

  log_success "trino 보호된 API가 인증 없이는 401이며, oauth2(→ sso.${BASE_DOMAIN})·PASSWORD 두 스킴이 모두 광고됨."
}

log_info "[TEST 10] SSO/identity 경계 TLS 검증..."

log_info "1/7: HTTP(80)는 200이 아니라 HTTPS 리다이렉트만 서빙해야 한다..."
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

log_info "2/7: HTTPS issuer가 내부 CA로 인증서 체인 검증에 실제로 통과하는지 확인..."
HTTPS_CODE=$(curl -s -o /dev/null --max-time 10 --cacert "${CA_CRT_FILE}" -w '%{http_code}' \
  "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration")
if [[ "${HTTPS_CODE}" != "200" ]]; then
  log_error "--cacert로 체인 검증 후에도 200이 아님 (HTTP ${HTTPS_CODE}) — 인증서/CA 배선 문제 의심"
  exit 1
fi
log_success "내부 CA로 인증서 체인 검증 통과 (HTTP ${HTTPS_CODE})."

log_info "3/7: 내부 CA 없이(시스템 기본 신뢰 저장소만) 요청하면 반드시 실패해야 한다..."
set +e
curl -s -o /dev/null --max-time 10 "https://sso.${BASE_DOMAIN}/realms/beluga/.well-known/openid-configuration"
NO_CA_EXIT=$?
set -e
if [[ ${NO_CA_EXIT} -eq 0 ]]; then
  log_error "내부 CA 없이도 인증서 검증이 통과함 — 공인 CA로 서명됐거나 검증이 실제로 집행되지 않음"
  exit 1
fi
log_success "내부 CA 없이는 인증서 검증 실패(exit=${NO_CA_EXIT}) — 이 인증서가 실제로 내부 CA에 묶여 있음 확인."

log_info "4/7: HTTP(80)→HTTPS 리다이렉트 Location 헤더에 명시적 포트가 없어야 한다 (:9443 버그 회귀)..."
LOCATION_HEADER=$( (grep -i '^location:' "${HTTP_HEADER_FILE}" | tail -1 | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//') || true)
EXPECTED_LOCATION_PREFIX="https://sso.${BASE_DOMAIN}/"
if [[ "${LOCATION_HEADER}" != "${EXPECTED_LOCATION_PREFIX}"* ]]; then
  log_error "Location 헤더가 포트 없는 https://sso.${BASE_DOMAIN}/...가 아님 — 실제: ${LOCATION_HEADER:-없음}"
  exit 1
fi
log_success "Location 헤더에 명시적 포트 없음 확인: ${LOCATION_HEADER}"

log_info "5/7: Superset SSO 로그인 시작이 Keycloak 인증 엔드포인트로(포트 없는 redirect_uri로) 리다이렉트되는지 확인..."
for TARGET in "${SSO_LOGIN_TARGETS[@]}"; do
  APP_NAME="${TARGET%%:*}"
  LOGIN_PATH="${TARGET#*:}"
  check_sso_login_redirect "${APP_NAME}" "https://${APP_NAME}.${BASE_DOMAIN}${LOGIN_PATH}"
done

log_info "6/7: Airflow(SPA 로그인이라 서버사이드 리다이렉트가 없음) — Keycloak 인증 엔드포인트를 직접 구성해 200 로그인 폼 확인..."
check_airflow_auth_scope

log_info "7/7: Trino(이슈 #110 이후 /ui/도 SPA 셸) — 보호된 데이터 API의 401/WWW-Authenticate로 확인..."
check_trino_auth_scheme

log_success "[TEST 10] SSO/identity 경계 TLS 검증 통과."
