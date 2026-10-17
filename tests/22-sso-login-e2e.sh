#!/usr/bin/env bash
# Beluga E2E Test 22: Live SSO & OIDC Authentication Flow Verification
#
# Tests SSO & OIDC integration across Beluga services:
# 1. Superset: Keycloak FAB OAuth2 full authorization code login flow (/login/keycloak) -> /api/v1/me/ verification
# 2. Airflow: Keycloak FAB OAuth2 full authorization code login flow (/auth/login/keycloak) -> /api/v2/dags?limit=1 (401 unauth vs 200 auth)
# 3. Trino: Keycloak OAuth2 Web UI full login flow (/ui/ -> Keycloak -> /oauth2/callback) -> /ui/api/cluster verification (401 unauth vs 200 auth)
# 4. OpenMetadata: Keycloak confidential OIDC auth config & login flow (/api/v1/auth/login -> Keycloak -> /callback -> Bearer token /api/v1/users/loggedInUser)
# 5. ArgoCD: Native Keycloak OIDC full login flow (/auth/login -> /auth/callback -> argocd.token -> userinfo & applications 200)
# 6. Lakekeeper Catalog UI: Gateway OIDC full login flow (/ui -> /ui 200 and unauthenticated 302 redirect)
# 7. Beluga Manager (ADR-0009 rollout 2b): public client beluga-manager, Authorization Code + PKCE S256 reproduced with curl
#    (code_verifier/challenge -> login form -> callback code -> token endpoint without client_secret) -> bearer
#    /api/v1/sso 200 (source.kind github, commitSha) vs 401 without/with a tampered token; web root 200 with CSP
#

# Passwords are read dynamically from Kubernetes Secret iam/keycloak-user-passwords into a 0600 tempfile and NEVER printed.
# Network routing uses BELUGA_GATEWAY_IP for curl --resolve across all relevant hosts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

CA_CERT="${TMP_DIR}/ca.crt"
if ! kubectl get secret beluga-internal-ca-secret -n cert-manager -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d > "${CA_CERT}"; then
  if [ -f "${SCRIPT_DIR}/../.certs/ca.crt" ]; then
    cp "${SCRIPT_DIR}/../.certs/ca.crt" "${CA_CERT}"
  else
    log_error "Internal CA certificate not found; cannot verify TLS without internal CA"
    exit 1
  fi
fi

if [ ! -s "${CA_CERT}" ]; then
  log_error "Internal CA certificate is empty; cannot verify TLS"
  exit 1
fi
CURL_SSL=(--cacert "${CA_CERT}")

# Fetch test credentials securely into a private temporary file (never exposed in argv/ps)
if ! kubectl get secret -n iam keycloak-user-passwords >/dev/null 2>&1; then
  log_error "Secret keycloak-user-passwords not found in namespace iam"
  exit 1
fi

ADMIN_PASS="$(kubectl get secret -n iam keycloak-user-passwords -o jsonpath='{.data.admin}' | base64 -d)"
if [[ -z "${ADMIN_PASS}" ]]; then
  log_error "Failed to retrieve admin password from Secret keycloak-user-passwords"
  exit 1
fi

PASS_FILE="${TMP_DIR}/admin.pass"
printf '%s' "${ADMIN_PASS}" > "${PASS_FILE}"
chmod 600 "${PASS_FILE}"

# 보안: 응답 HTML에서 뽑은 폼 action으로 비밀번호를 POST하므로, Keycloak 로그인 액션
# 엔드포인트(https://sso.<domain>/realms/<realm>/login-actions/)가 아니면 빈 값을 돌려
# 호출부가 실패하게 한다(변조된 응답이 자격증명을 다른 호스트로 보내는 것을 막는다).
extract_login_action() {
  local html="$1" action
  action="$(printf '%s' "${html}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"
  case "${action}" in
    "https://sso.${BASE_DOMAIN}/realms/beluga/login-actions/"*) printf '%s' "${action}" ;;
    *) [[ -n "${action}" ]] && log_error "Keycloak 외 폼 action 거부: ${action%%\?*}" >&2 ; printf '' ;;
  esac
}

ADMIN_USER="beluga-admin"
FAILED=0

fail() {
  log_error "$*"
  FAILED=1
}

RESOLVE_ARGS=(
  --resolve "sso.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "superset.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "airflow.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "trino.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "metadata.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "argocd.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "catalog.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "filer.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "flink.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "s3.${BASE_DOMAIN}:443:${GATEWAY_IP}"
  --resolve "manager.${BASE_DOMAIN}:443:${GATEWAY_IP}"
)

run_curl() {
  local host="$1"
  shift
  curl -s -S "${CURL_SSL[@]}" --resolve "${host}:443:${GATEWAY_IP}" "${RESOLVE_ARGS[@]}" "$@"
}

verify_apisix_oidc_login() {
  local name="$1"
  local host="$2"
  local initial_path="$3"
  local verify_path="$4"
  local content_regex="$5"
  local jar="${TMP_DIR}/${name}_cookies.txt"
  rm -f "${jar}"

  log_info "[${name}] APISIX openid-connect OIDC 로그인 완주 검증 시작..."

  # 1. 앱 URL GET -> Keycloak authorize 로 이동하여 로그인 폼 수신
  local login_html
  login_html="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L "https://${host}${initial_path}" 2>&1 || true)"
  local action
  action="$(extract_login_action "${login_html}")"

  if [[ -z "${action}" ]]; then
    fail "[${name}] Keycloak 로그인 폼 action URL 추출 실패"
    return 1
  fi

  # 2. Keycloak 로그인 폼 POST (관리자 사용자, 비밀번호는 0600 임시파일 --data-urlencode password@file)
  #    -> Keycloak이 https://<host>/.apisix/redirect?code=... 로 302 리다이렉트
  #    -> APISIX가 토큰 교환 완주 및 세션 쿠키 발급 후 최종 앱 페이지로 리다이렉트 (-L)
  run_curl "${host}" -c "${jar}" -b "${jar}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -L "${action}" >/dev/null 2>&1 || true

  # 3. 최종 앱 페이지 HTTP 200 및 콘텐츠 검증 (-L로 앱 내부 리다이렉트 추적)
  local app_code app_resp
  app_code="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L -o /dev/null -w "%{http_code}" "https://${host}${verify_path}" 2>&1 || true)"
  app_resp="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L "https://${host}${verify_path}" 2>&1 || true)"

  if [[ "${app_code}" == "200" ]] && echo "${app_resp}" | grep -qE "${content_regex}"; then
    log_success "[${name}] APISIX openid-connect 로그인 완주: ${verify_path} 200 OK 및 콘텐츠 검증 성공"
  else
    fail "[${name}] APISIX openid-connect 로그인 완주 실패: HTTP ${app_code}, 기대 패턴 '${content_regex}' 불일치"
    return 1
  fi

  # 4. 쿠키 없이 다시 요청하면 302 리다이렉트인지 확인
  local unauth_headers unauth_code unauth_loc
  unauth_headers="$(run_curl "${host}" -I "https://${host}${verify_path}" 2>&1 || true)"
  unauth_code="$(echo "${unauth_headers}" | awk '/^HTTP\/[12](\.[0-9])? / {print $2}' | tail -n1)"
  unauth_loc="$(echo "${unauth_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"

  if [[ "${unauth_code}" == "302" ]] && [[ "${unauth_loc}" == *"sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/auth"* ]]; then
    log_success "[${name}] 쿠키 미포함 재요청 시 HTTP 302 Keycloak 리다이렉트 정상 확인"
  else
    fail "[${name}] 쿠키 미포함 재요청이 302 Keycloak 리다이렉트가 아님 (HTTP ${unauth_code}, Location: ${unauth_loc})"
    return 1
  fi
}

verify_argocd_oidc_login() {
  local host="$1"
  local jar="${TMP_DIR}/argocd_cookies.txt"
  rm -f "${jar}"

  log_info "[ArgoCD] Native OIDC 로그인 완주 검증 시작..."

  # 1. /auth/login -> Keycloak authorize 로 이동하여 로그인 폼 수신
  local login_html
  login_html="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L "https://${host}/auth/login" 2>&1 || true)"
  local action
  action="$(extract_login_action "${login_html}")"

  if [[ -z "${action}" ]]; then
    fail "[ArgoCD] Keycloak 로그인 폼 action URL 추출 실패"
    return 1
  fi

  # 2. Keycloak 로그인 폼 POST (관리자 사용자, 비밀번호는 0600 임시파일 --data-urlencode password@file)
  #    -> Keycloak이 https://<host>/auth/callback?code=... 로 302 리다이렉트
  #    -> ArgoCD가 코드 교환 후 argocd.token 세션 쿠키 발급
  run_curl "${host}" -c "${jar}" -b "${jar}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -L "${action}" >/dev/null 2>&1 || true

  # 3. argocd.token 쿠키 획득 확인
  if grep -q "argocd.token" "${jar}" 2>/dev/null; then
    log_success "[ArgoCD] /auth/callback 완료 후 argocd.token 쿠키 획득 확인"
  else
    fail "[ArgoCD] /auth/callback 완료 후 argocd.token 쿠키 획득 실패"
    return 1
  fi

  # 4. /api/v1/session/userinfo 에서 loggedIn true 및 groups에 admins 포함 확인
  local userinfo_resp
  userinfo_resp="$(run_curl "${host}" -b "${jar}" "https://${host}/api/v1/session/userinfo" 2>&1 || true)"
  if echo "${userinfo_resp}" | grep -q '"loggedIn":true' && echo "${userinfo_resp}" | grep -q 'admins'; then
    log_success "[ArgoCD] /api/v1/session/userinfo 확인 성공 (loggedIn: true, groups: admins)"
  else
    fail "[ArgoCD] /api/v1/session/userinfo 확인 실패: ${userinfo_resp}"
    return 1
  fi

  # 5. /api/v1/applications 200 확인
  local apps_code
  apps_code="$(run_curl "${host}" -b "${jar}" -o /dev/null -w "%{http_code}" "https://${host}/api/v1/applications" 2>&1 || true)"
  if [[ "${apps_code}" == "200" ]]; then
    log_success "[ArgoCD] /api/v1/applications 접근 성공 (HTTP 200)"
  else
    fail "[ArgoCD] /api/v1/applications 접근 실패 (HTTP ${apps_code})"
    return 1
  fi
}

# Beluga Manager: Authorization Code + PKCE (S256) against the public client beluga-manager, then bearer calls.
# Secrets (code, verifier, tokens) never go to argv/stdout: form bodies and the Authorization header live in 0600 files.
verify_manager_pkce_login() {
  local host="manager.${BASE_DOMAIN}"
  local sso="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect"
  local redirect_uri="https://${host}/auth/callback"
  local jar="${TMP_DIR}/manager_cookies.txt"
  rm -f "${jar}"

  log_info "[Manager] PKCE 로그인 완주 검증 시작 (public client beluga-manager, S256)..."

  # 0. 웹 루트와 런타임 설정: 200, CSP connect-src에 sso 오리진, config.json은 groups 스코프를 요청하지 않는다
  local web_headers web_code web_csp cfg_json
  web_headers="$(run_curl "${host}" -D - -o /dev/null "https://${host}/" 2>&1 || true)"
  web_code="$(printf '%s' "${web_headers}" | awk '/^HTTP\/[12](\.[0-9])? / {print $2}' | tail -n1)"
  web_csp="$(printf '%s' "${web_headers}" | awk -F': ' 'tolower($1)=="content-security-policy" {print $2}' | tr -d '\r')"
  if [[ "${web_code}" == "200" && "${web_csp}" == *"connect-src 'self' https://sso.${BASE_DOMAIN};"* ]]; then
    log_success "[Manager] 웹 루트 200 및 CSP connect-src ('self' https://sso.${BASE_DOMAIN}) 확인"
  else
    fail "[Manager] 웹 루트/CSP 확인 실패: HTTP ${web_code}, CSP: ${web_csp}"
  fi
  cfg_json="$(run_curl "${host}" "https://${host}/config.json" 2>&1 || true)"
  if printf '%s' "${cfg_json}" | python3 -c '
import json, sys
c = json.load(sys.stdin)["oidc"]
assert c["clientId"] == "beluga-manager" and c["redirectPath"] == "/auth/callback"
assert c["issuer"] == "https://sso.'"${BASE_DOMAIN}"'/realms/beluga"
assert "groups" not in c["scope"].split()
' 2>/dev/null; then
    log_success "[Manager] /config.json oidc 설정 확인 (issuer, clientId, redirectPath, groups 미요청)"
  else
    fail "[Manager] /config.json oidc 설정 불일치: ${cfg_json}"
  fi
  local cb_code
  cb_code="$(run_curl "${host}" -o /dev/null -w "%{http_code}" "https://${host}/auth/callback" 2>&1 || true)"
  if [[ "${cb_code}" == "200" ]]; then
    log_success "[Manager] /auth/callback SPA 폴백 200"
  else
    fail "[Manager] /auth/callback SPA 폴백 기대 200, 실제 ${cb_code}"
  fi

  # 1. 토큰 없이 API: 401 (health는 공개)
  local unauth_code health_code
  unauth_code="$(run_curl "${host}" -o /dev/null -w "%{http_code}" "https://${host}/api/v1/sso" 2>&1 || true)"
  health_code="$(run_curl "${host}" -o /dev/null -w "%{http_code}" "https://${host}/api/v1/health" 2>&1 || true)"
  if [[ "${unauth_code}" == "401" && "${health_code}" == "200" ]]; then
    log_success "[Manager] 토큰 없는 /api/v1/sso 401, 공개 /api/v1/health 200"
  else
    fail "[Manager] 무토큰 /api/v1/sso 기대 401(실제 ${unauth_code}), /api/v1/health 기대 200(실제 ${health_code})"
  fi

  # 2. PKCE 파라미터 생성 (RFC 7636: verifier 43-128자 unreserved, challenge = BASE64URL(SHA256(verifier)))
  local verifier challenge state nonce
  verifier="$(openssl rand -base64 64 | tr -d '=+/\n' | cut -c1-64)"
  challenge="$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  state="$(openssl rand -hex 12)"
  nonce="$(openssl rand -hex 12)"
  if [[ ${#verifier} -lt 43 || -z "${challenge}" ]]; then
    fail "[Manager] PKCE verifier/challenge 생성 실패"
    return 1
  fi
  local redirect_enc="https%3A%2F%2F${host}%2Fauth%2Fcallback"
  local base_query="client_id=beluga-manager&response_type=code&scope=openid%20profile%20email&redirect_uri=${redirect_enc}&state=${state}&nonce=${nonce}"

  # 3. PKCE 미사용 authorize 요청은 거부되어야 한다 (S256 강제): 로그인 폼이 아니라 error 리다이렉트/400
  local nopkce_headers nopkce_loc nopkce_code
  nopkce_headers="$(run_curl "${host}" -D - -o /dev/null "${sso}/auth?${base_query}" 2>&1 || true)"
  nopkce_code="$(printf '%s' "${nopkce_headers}" | awk '/^HTTP\/[12](\.[0-9])? / {print $2}' | tail -n1)"
  nopkce_loc="$(printf '%s' "${nopkce_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"
  if [[ "${nopkce_code}" == "400" ]] || [[ "${nopkce_loc}" == "${redirect_uri}"*"error="* ]]; then
    log_success "[Manager] code_challenge 없는 authorize 요청 거부 확인 (PKCE S256 강제, HTTP ${nopkce_code})"
  else
    fail "[Manager] code_challenge 없는 authorize 요청이 거부되지 않음 (HTTP ${nopkce_code}, Location: ${nopkce_loc%%\?*})"
  fi

  # 4. authorize (PKCE) -> 로그인 폼 -> 자격증명 POST -> 콜백 Location에서 code 획득
  local login_html action
  login_html="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L "${sso}/auth?${base_query}&code_challenge=${challenge}&code_challenge_method=S256" 2>&1 || true)"
  action="$(extract_login_action "${login_html}")"
  if [[ -z "${action}" ]]; then
    fail "[Manager] Keycloak 로그인 폼 action URL 추출 실패 (authorize 요청이 거부됐을 수 있음)"
    return 1
  fi
  local post_headers cb_loc code cb_state
  post_headers="$(run_curl "${host}" -c "${jar}" -b "${jar}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -i "${action}" 2>&1 || true)"
  cb_loc="$(printf '%s' "${post_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"
  if [[ "${cb_loc}" != "${redirect_uri}?"* ]]; then
    fail "[Manager] 로그인 후 콜백 리다이렉트가 redirect_uri와 다름: ${cb_loc%%\?*}"
    return 1
  fi
  code="$(printf '%s' "${cb_loc}" | sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p')"
  cb_state="$(printf '%s' "${cb_loc}" | sed -n 's/.*[?&]state=\([^&#]*\).*/\1/p')"
  if [[ -z "${code}" || "${cb_state}" != "${state}" ]]; then
    fail "[Manager] 콜백에서 code 추출 실패 또는 state 불일치"
    return 1
  fi
  log_success "[Manager] 콜백 redirect_uri 일치 및 state 확인, authorization code 획득"

  # 5. 토큰 교환: public client이므로 client_secret 없이 code + code_verifier만. 본문은 0600 파일로 전달한다.
  local form_file="${TMP_DIR}/manager_token_form.txt" token_json="${TMP_DIR}/manager_token.json"
  (umask 077 && printf 'grant_type=authorization_code&client_id=beluga-manager&code=%s&redirect_uri=%s&code_verifier=%s' \
    "${code}" "${redirect_enc}" "${verifier}" > "${form_file}")
  local token_code
  token_code="$(run_curl "${host}" -o "${token_json}" -w "%{http_code}" \
    -H "Content-Type: application/x-www-form-urlencoded" --data-binary "@${form_file}" "${sso}/token" 2>&1 || true)"
  rm -f "${form_file}"
  if [[ "${token_code}" != "200" ]]; then
    fail "[Manager] PKCE 토큰 교환 실패 (HTTP ${token_code}; client_secret 없이 code+verifier로 교환되어야 함)"
    rm -f "${token_json}"
    return 1
  fi

  # 6. access token을 0600 헤더 파일로 옮기고 클레임(aud, groups)만 확인한다 (토큰 값은 출력하지 않는다)
  local auth_header_file="${TMP_DIR}/manager_auth_header.txt" bad_header_file="${TMP_DIR}/manager_bad_header.txt"
  if ! TOKEN_JSON="${token_json}" EXPECT_NONCE="${nonce}" AUTH_HEADER="${auth_header_file}" BAD_HEADER="${bad_header_file}" python3 -c '
import base64, json, os
resp = json.load(open(os.environ["TOKEN_JSON"]))
tok = resp["access_token"]
idp = resp["id_token"].split(".")[1]
assert json.loads(base64.urlsafe_b64decode(idp + "=" * (-len(idp) % 4))).get("nonce") == os.environ["EXPECT_NONCE"], "id_token nonce mismatch"
head, payload, sig = tok.split(".")
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
aud = claims.get("aud")
aud = [aud] if isinstance(aud, str) else (aud or [])
assert claims.get("sub"), "access token lacks sub (oidc-sub-mapper)"
assert "beluga-manager" in aud, "aud lacks beluga-manager"
assert "/admins" in claims.get("groups", []), "groups lacks /admins (full.path mapper)"
flip = "A" if sig[0] != "A" else "B"
for path, value in ((os.environ["AUTH_HEADER"], tok), (os.environ["BAD_HEADER"], head + "." + payload + "." + flip + sig[1:])):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("Authorization: Bearer " + value + "\n")
print("claims ok: id_token nonce matches, sub present, aud contains beluga-manager, groups contains /admins")
'; then
    fail "[Manager] access token 클레임 검증 실패 (aud 또는 groups(/admins) 매퍼 확인)"
    rm -f "${token_json}" "${auth_header_file}" "${bad_header_file}"
    return 1
  fi
  rm -f "${token_json}"
  log_success "[Manager] 토큰 클레임 확인: id_token nonce 일치, sub 존재, aud=beluga-manager, groups에 /admins"

  # 7. 베어러로 /api/v1/sso: 200 + source.kind github + 40자 commitSha, 변조 토큰은 401
  local sso_code sso_body bad_code
  sso_body="$(run_curl "${host}" -H "@${auth_header_file}" -w "\n%{http_code}" "https://${host}/api/v1/sso" 2>&1 || true)"
  sso_code="$(printf '%s' "${sso_body}" | tail -n1)"
  if [[ "${sso_code}" == "200" ]] && printf '%s' "${sso_body}" | sed '$d' | python3 -c '
import json, re, sys
r = json.load(sys.stdin)
assert r["source"]["kind"] == "github", r["source"].get("kind")
assert re.fullmatch(r"[0-9a-f]{40}", r["source"]["commitSha"])
'; then
    log_success "[Manager] bearer /api/v1/sso 200: source.kind=github, commitSha 존재"
  else
    fail "[Manager] bearer /api/v1/sso 검증 실패 (HTTP ${sso_code}; GitHub 읽기 어댑터/JWKS/내부 CA 확인)"
  fi
  bad_code="$(run_curl "${host}" -H "@${bad_header_file}" -o /dev/null -w "%{http_code}" "https://${host}/api/v1/sso" 2>&1 || true)"
  if [[ "${bad_code}" == "401" ]]; then
    log_success "[Manager] 서명 변조 토큰 /api/v1/sso 401 확인"
  else
    fail "[Manager] 서명 변조 토큰 기대 401, 실제 ${bad_code}"
  fi
  rm -f "${auth_header_file}" "${bad_header_file}"
}

run_test_22_suite() {
  log_info "=========================================================="
  log_info " [TEST 22] Beluga SSO & OIDC Live Authentication Test"
  log_info " Base domain: ${BASE_DOMAIN}"
  log_info " Gateway IP:  ${GATEWAY_IP}"
  log_info "=========================================================="

  # -----------------------------------------------------------------------------
  # 1. Superset SSO (FAB OAuth2)
  # -----------------------------------------------------------------------------
  log_info "1. Testing Superset SSO (FAB OAuth2)..."
  local superset_jar="${TMP_DIR}/superset_cookies.txt"
  local superset_host="superset.${BASE_DOMAIN}"

  local superset_login_html
  superset_login_html="$(run_curl "${superset_host}" -c "${superset_jar}" -b "${superset_jar}" -L "https://${superset_host}/login/keycloak" || true)"
  local superset_action
  superset_action="$(extract_login_action "${superset_login_html}")"

  if [[ -z "${superset_action}" ]]; then
    fail "[Superset] Failed to extract Keycloak login form action URL"
  else
    run_curl "${superset_host}" -c "${superset_jar}" -b "${superset_jar}" \
      -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
      -L "${superset_action}" >/dev/null 2>&1 || true

    local superset_me
    superset_me="$(run_curl "${superset_host}" -c "${superset_jar}" -b "${superset_jar}" "https://${superset_host}/api/v1/me/" || true)"
    if echo "${superset_me}" | grep -q "\"username\":\"${ADMIN_USER}\""; then
      log_success "[Superset] SSO login succeeded; /api/v1/me/ confirmed username='${ADMIN_USER}'"
    else
      fail "[Superset] SSO verification failed. Response: ${superset_me}"
    fi
  fi

  # -----------------------------------------------------------------------------
  # 2. Airflow SSO (FAB OAuth2)
  # -----------------------------------------------------------------------------
  log_info "2. Testing Airflow SSO (FAB OAuth2)..."
  local airflow_jar="${TMP_DIR}/airflow_cookies.txt"
  local airflow_host="airflow.${BASE_DOMAIN}"

  local airflow_login_html
  airflow_login_html="$(run_curl "${airflow_host}" -c "${airflow_jar}" -b "${airflow_jar}" -L "https://${airflow_host}/auth/login/keycloak" || true)"
  local airflow_action
  airflow_action="$(extract_login_action "${airflow_login_html}")"

  if [[ -n "${airflow_action}" ]]; then
    run_curl "${airflow_host}" -c "${airflow_jar}" -b "${airflow_jar}" \
      -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
      -L "${airflow_action}" >/dev/null 2>&1 || true

    local unauth_code
    unauth_code="$(run_curl "${airflow_host}" -o /dev/null -w "%{http_code}" "https://${airflow_host}/api/v2/dags?limit=1" || true)"
    if [[ "${unauth_code}" != "401" && "${unauth_code}" != "403" ]]; then
      fail "[Airflow] Unauthenticated /api/v2/dags?limit=1 expected 401/403, got: ${unauth_code}"
    fi

    local airflow_resp
    airflow_resp="$(run_curl "${airflow_host}" -c "${airflow_jar}" -b "${airflow_jar}" "https://${airflow_host}/api/v2/dags?limit=1" || true)"
    if echo "${airflow_resp}" | grep -q '"dags"'; then
      log_success "[Airflow] SSO login succeeded; /api/v2/dags confirmed authenticated session"
    else
      fail "[Airflow] SSO session verification failed. Response: ${airflow_resp}"
    fi
  else
    log_warn "[Airflow] Keycloak login action not found on live cluster (requires GitOps sync of Airflow OIDC configuration)"
    fail "[Airflow] SSO login endpoint not ready"
  fi

  # -----------------------------------------------------------------------------
  # 3. Trino SSO (Web UI OAuth2)
  # -----------------------------------------------------------------------------
  log_info "3. Testing Trino SSO (OAuth2 Web UI)..."
  local trino_jar="${TMP_DIR}/trino_cookies.txt"
  local trino_host="trino.${BASE_DOMAIN}"
  rm -f "${trino_jar}"

  local unauth_trino_code
  unauth_trino_code="$(run_curl "${trino_host}" -o /dev/null -w "%{http_code}" "https://${trino_host}/ui/api/cluster" 2>&1 || true)"
  if [[ "${unauth_trino_code}" == "401" ]]; then
    log_success "[Trino] Unauthenticated /ui/api/cluster returned HTTP 401 as expected"
  else
    fail "[Trino] Unauthenticated /ui/api/cluster expected 401, got: ${unauth_trino_code}"
  fi

  local trino_start
  trino_start="$(run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" -L "https://${trino_host}/ui/" 2>&1 || true)"
  local trino_action
  trino_action="$(extract_login_action "${trino_start}")"

  if [[ -n "${trino_action}" ]]; then
    run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" \
      -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
      -L "${trino_action}" >/dev/null 2>&1 || true

    local trino_cluster_code trino_cluster
    trino_cluster_code="$(run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" -o /dev/null -w "%{http_code}" "https://${trino_host}/ui/api/cluster" 2>&1 || true)"
    trino_cluster="$(run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" "https://${trino_host}/ui/api/cluster" 2>&1 || true)"
    if [[ "${trino_cluster_code}" == "200" ]] && echo "${trino_cluster}" | grep -q '"nodeVersion"'; then
      log_success "[Trino] Web UI OAuth2 SSO login succeeded; /ui/api/cluster returned 200 OK"
    else
      fail "[Trino] /ui/api/cluster access failed after OAuth2 flow: HTTP ${trino_cluster_code}, body: ${trino_cluster}"
    fi
  else
    fail "[Trino] /ui/ did not yield Keycloak login form"
  fi

  # -----------------------------------------------------------------------------
  # 4. OpenMetadata SSO (Confidential OIDC Flow)
  # -----------------------------------------------------------------------------
  log_info "4. Testing OpenMetadata SSO configuration & OIDC flow..."
  local om_host="metadata.${BASE_DOMAIN}"

  local om_dep_err om_dep_status=0
  om_dep_err="$(kubectl get deployment openmetadata -n governance 2>&1)" || om_dep_status=$?
  if [[ "${om_dep_status}" -ne 0 ]]; then
    if echo "${om_dep_err}" | grep -qiE 'NotFound|"openmetadata" not found'; then
      log_info "[OpenMetadata] deployment openmetadata not found in namespace governance (profile openmetadata.enabled=false); skipping"
    else
      fail "[OpenMetadata] Failed to query deployment openmetadata: ${om_dep_err}"
    fi
  else
    local om_cfg
    om_cfg="$(run_curl "${om_host}" "https://${om_host}/api/v1/system/config/auth" 2>&1 || true)"
    if echo "${om_cfg}" | grep -q '"clientType":"confidential"'; then
      log_success "[OpenMetadata] auth config confirmed confidential clientType"
    else
      fail "[OpenMetadata] Unexpected auth config: ${om_cfg}"
    fi

    local unauth_om_code
    unauth_om_code="$(run_curl "${om_host}" -o /dev/null -w "%{http_code}" "https://${om_host}/api/v1/users/loggedInUser" 2>&1 || true)"
    if [[ "${unauth_om_code}" == "401" ]]; then
      log_success "[OpenMetadata] Unauthenticated /api/v1/users/loggedInUser returned HTTP 401 as expected"
    else
      fail "[OpenMetadata] Unauthenticated /api/v1/users/loggedInUser expected 401, got: ${unauth_om_code}"
    fi

    local om_jar="${TMP_DIR}/om_cookies.txt"
    rm -f "${om_jar}"

    local om_login_html
    om_login_html="$(run_curl "${om_host}" -c "${om_jar}" -b "${om_jar}" -L "https://${om_host}/api/v1/auth/login?redirectUri=https://${om_host}/" 2>&1 || true)"
    local om_action
    om_action="$(extract_login_action "${om_login_html}")"

    if [[ -z "${om_action}" ]]; then
      fail "[OpenMetadata] Failed to extract Keycloak login form action URL"
    else
      local kc_headers kc_redirect_loc
      kc_headers="$(run_curl "${om_host}" -c "${om_jar}" -b "${om_jar}" \
        -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
        -i "${om_action}" 2>&1 || true)"
      kc_redirect_loc="$(echo "${kc_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"

      if [[ -z "${kc_redirect_loc}" ]]; then
        fail "[OpenMetadata] Keycloak login did not return redirect Location to OM callback"
      else
        local cb_headers cb_redirect_loc
        cb_headers="$(run_curl "${om_host}" -c "${om_jar}" -b "${om_jar}" -i "${kc_redirect_loc}" 2>&1 || true)"
        cb_redirect_loc="$(echo "${cb_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"

        local id_token
        id_token="$(printf '%s' "${cb_redirect_loc}" | sed -n 's/.*[?&#]id_token=\([^&#]*\).*/\1/p')"

        if [[ -z "${id_token}" ]]; then
          fail "[OpenMetadata] Failed to extract id_token from callback redirect URL: ${cb_redirect_loc%%\?*}"
        else
          local auth_header_file="${TMP_DIR}/om_auth_header.txt"
          rm -f "${auth_header_file}"
          (umask 077 && printf 'Authorization: Bearer %s\n' "${id_token}" > "${auth_header_file}")
          chmod 0600 "${auth_header_file}"
          local user_code user_resp
          user_code="$(run_curl "${om_host}" -H "@${auth_header_file}" -o /dev/null -w "%{http_code}" "https://${om_host}/api/v1/users/loggedInUser" 2>&1 || true)"
          user_resp="$(run_curl "${om_host}" -H "@${auth_header_file}" "https://${om_host}/api/v1/users/loggedInUser" 2>&1 || true)"
          rm -f "${auth_header_file}"

          if [[ "${user_code}" == "200" ]] && echo "${user_resp}" | grep -q "\"name\":\"${ADMIN_USER}\""; then
            log_success "[OpenMetadata] OIDC confidential login succeeded; /api/v1/users/loggedInUser confirmed name='${ADMIN_USER}'"
          else
            fail "[OpenMetadata] /api/v1/users/loggedInUser verification failed: HTTP ${user_code}, body: ${user_resp}"
          fi
        fi
      fi
    fi
  fi

  # -----------------------------------------------------------------------------
  # 5. ArgoCD SSO (Native OIDC)
  # -----------------------------------------------------------------------------
  log_info "5. Testing ArgoCD OIDC configuration & full login flow..."
  local argocd_host="argocd.${BASE_DOMAIN}"
  local argocd_settings
  argocd_settings="$(run_curl "${argocd_host}" "https://${argocd_host}/api/v1/settings" || true)"
  if echo "${argocd_settings}" | grep -q '"oidcConfig"'; then
    log_success "[ArgoCD] Native OIDC configuration confirmed in Settings API"
  else
    fail "[ArgoCD] OIDC configuration missing in Settings API: ${argocd_settings}"
  fi
  verify_argocd_oidc_login "${argocd_host}"

  # -----------------------------------------------------------------------------
  # 6. Lakekeeper Catalog UI (OIDC Client & Perimeter Protection)
  # -----------------------------------------------------------------------------
  log_info "6. Testing Lakekeeper Catalog UI OIDC endpoints..."
  local catalog_host="catalog.${BASE_DOMAIN}"
  verify_apisix_oidc_login "catalog-ui" "${catalog_host}" "/ui/" "/ui/" '(<!DOCTYPE html>|<html|Lakekeeper)'

  # -----------------------------------------------------------------------------
  # 7. Beluga Manager (public client, PKCE S256, bearer JWT)
  # -----------------------------------------------------------------------------
  log_info "7. Testing Beluga Manager PKCE login & bearer API..."
  verify_manager_pkce_login || true

  # -----------------------------------------------------------------------------
  # Result Summary
  # -----------------------------------------------------------------------------
  if [ "${FAILED}" -ne 0 ]; then
    log_error "=========================================================="
    log_error " [TEST 22] SSO Live Authentication verification FAILED."
    log_error "=========================================================="
    exit 1
  fi

  log_success "=========================================================="
  log_success " [TEST 22] All SSO & OIDC Authentication flows verified."
  log_success "=========================================================="
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_test_22_suite
fi
