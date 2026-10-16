#!/usr/bin/env bash
# Beluga E2E Test 22: Live SSO & OIDC Authentication Flow Verification
#
# Tests SSO & OIDC integration across Beluga services:
# 1. Superset: Keycloak FAB OAuth2 full authorization code login flow (/login/keycloak) -> /api/v1/me/ verification
# 2. Airflow: Keycloak FAB OAuth2 full authorization code login flow (/auth/login/keycloak) -> /api/v2/dags?limit=1 (401 unauth vs 200 auth)
# 3. Trino: Keycloak OAuth2 Web UI full login flow (/oauth2/start) -> /ui/api/cluster verification
# 4. OpenMetadata: Keycloak confidential OIDC auth config validation (/api/v1/system/config/auth, skipped if disabled)
# 5. ArgoCD: Native Keycloak OIDC full login flow (/auth/login -> /auth/callback -> argocd.token -> userinfo & applications 200)
# 6. Lakekeeper Catalog UI: Gateway OIDC full login flow (/ui -> /ui 200 and unauthenticated 302 redirect)
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
    log_warn "[Airflow] Keycloak login action not found on live cluster (requires GitOps sync of standalone fix)"
    fail "[Airflow] SSO login endpoint not ready"
  fi

  # -----------------------------------------------------------------------------
  # 3. Trino SSO (Web UI OAuth2)
  # -----------------------------------------------------------------------------
  log_info "3. Testing Trino SSO (OAuth2 Web UI)..."
  local trino_jar="${TMP_DIR}/trino_cookies.txt"
  local trino_host="trino.${BASE_DOMAIN}"

  local trino_start
  trino_start="$(run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" -L "https://${trino_host}/oauth2/start" || true)"
  local trino_action
  trino_action="$(extract_login_action "${trino_start}")"

  if [[ -n "${trino_action}" ]]; then
    run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" \
      -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
      -L "${trino_action}" >/dev/null 2>&1 || true

    local trino_cluster
    trino_cluster="$(run_curl "${trino_host}" -c "${trino_jar}" -b "${trino_jar}" "https://${trino_host}/ui/api/cluster" || true)"
    if echo "${trino_cluster}" | grep -q "runningQueries"; then
      log_success "[Trino] Web UI OAuth2 SSO login succeeded"
    else
      fail "[Trino] /ui/api/cluster access failed after OAuth2 flow: ${trino_cluster}"
    fi
  else
    log_warn "[Trino] /oauth2/start did not yield Keycloak form (requires GitOps sync of web-ui.authentication.type=oauth2)"
    fail "[Trino] OAuth2 initiation failed"
  fi

  # -----------------------------------------------------------------------------
  # 4. OpenMetadata SSO (Confidential OIDC Flow)
  # -----------------------------------------------------------------------------
  log_info "4. Testing OpenMetadata SSO configuration & OIDC flow..."
  local om_host="metadata.${BASE_DOMAIN}"

  if ! kubectl get deployment openmetadata -n governance >/dev/null 2>&1; then
    log_info "[OpenMetadata] deployment openmetadata not found in namespace governance (profile openmetadata.enabled=false); skipping"
  else
    local om_cfg
    om_cfg="$(run_curl "${om_host}" "https://${om_host}/api/v1/system/config/auth" || true)"
    if echo "${om_cfg}" | grep -q '"clientType":"confidential"' && echo "${om_cfg}" | grep -q '"responseType":"code"'; then
      log_success "[OpenMetadata] auth config confirmed confidential clientType & code responseType (Authorization Code)"
    else
      fail "[OpenMetadata] Unexpected auth config: ${om_cfg}"
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
