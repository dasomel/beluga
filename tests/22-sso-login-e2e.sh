#!/usr/bin/env bash
# Beluga E2E Test 22: Live SSO & OIDC Authentication Flow Verification
#
# Tests SSO & OIDC integration across Beluga services:
# 1. Superset: Keycloak FAB OAuth2 full authorization code login flow (/login/keycloak) -> /api/v1/me/ verification
# 2. Airflow: Keycloak FAB OAuth2 full authorization code login flow (/auth/login/keycloak) -> /api/v2/dags?limit=1 (401 unauth vs 200 auth)
# 3. Trino: Keycloak OAuth2 Web UI full login flow (/oauth2/start) -> /ui/api/cluster verification
# 4. OpenMetadata: Keycloak confidential OIDC auth config validation (/api/v1/system/config/auth)
# 5. ArgoCD: Native Keycloak OIDC settings validation (/api/v1/settings)
# 6. Lakekeeper Catalog: Gateway OIDC perimeter protection check (/ui -> 302 redirect to Keycloak SSO)
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

log_info "=========================================================="
log_info " [TEST 22] Beluga SSO & OIDC Live Authentication Test"
log_info " Base domain: ${BASE_DOMAIN}"
log_info " Gateway IP:  ${GATEWAY_IP}"
log_info "=========================================================="

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

# -----------------------------------------------------------------------------
# 1. Superset SSO (FAB OAuth2)
# -----------------------------------------------------------------------------
log_info "1. Testing Superset SSO (FAB OAuth2)..."
SUPERSET_JAR="${TMP_DIR}/superset_cookies.txt"
SUPERSET_HOST="superset.${BASE_DOMAIN}"

superset_login_html="$(run_curl "${SUPERSET_HOST}" -c "${SUPERSET_JAR}" -b "${SUPERSET_JAR}" -L "https://${SUPERSET_HOST}/login/keycloak" || true)"
superset_action="$(echo "${superset_login_html}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"

if [[ -z "${superset_action}" ]]; then
  fail "[Superset] Failed to extract Keycloak login form action URL"
else
  # Submit login form to Keycloak (redirects back to Superset callback via -L)
  run_curl "${SUPERSET_HOST}" -c "${SUPERSET_JAR}" -b "${SUPERSET_JAR}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -L "${superset_action}" >/dev/null 2>&1 || true

  # Verify authenticated session via /api/v1/me/
  superset_me="$(run_curl "${SUPERSET_HOST}" -c "${SUPERSET_JAR}" -b "${SUPERSET_JAR}" "https://${SUPERSET_HOST}/api/v1/me/" || true)"
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
AIRFLOW_JAR="${TMP_DIR}/airflow_cookies.txt"
AIRFLOW_HOST="airflow.${BASE_DOMAIN}"

# Airflow 3 FAB OIDC login starts under /auth/login/keycloak or /login/keycloak
airflow_login_html="$(run_curl "${AIRFLOW_HOST}" -c "${AIRFLOW_JAR}" -b "${AIRFLOW_JAR}" -L "https://${AIRFLOW_HOST}/auth/login/keycloak" || true)"
airflow_action="$(echo "${airflow_login_html}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"

if [[ -n "${airflow_action}" ]]; then
  # Submit login form to Keycloak (redirects back to Airflow callback via -L)
  run_curl "${AIRFLOW_HOST}" -c "${AIRFLOW_JAR}" -b "${AIRFLOW_JAR}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -L "${airflow_action}" >/dev/null 2>&1 || true

  # Verify unauthenticated request fails with 401 or 403
  unauth_code="$(run_curl "${AIRFLOW_HOST}" -o /dev/null -w "%{http_code}" "https://${AIRFLOW_HOST}/api/v2/dags?limit=1" || true)"
  if [[ "${unauth_code}" != "401" && "${unauth_code}" != "403" ]]; then
    fail "[Airflow] Unauthenticated /api/v2/dags?limit=1 expected 401/403, got: ${unauth_code}"
  fi

  # Check authenticated access
  airflow_resp="$(run_curl "${AIRFLOW_HOST}" -c "${AIRFLOW_JAR}" -b "${AIRFLOW_JAR}" "https://${AIRFLOW_HOST}/api/v2/dags?limit=1" || true)"
  if echo "${airflow_resp}" | grep -q '"dags"'; then
    log_success "[Airflow] SSO login succeeded; /api/v2/dags confirmed authenticated session"
  else
    fail "[Airflow] SSO session verification failed. Response: ${airflow_resp}"
  fi
else
  # If /auth/login/keycloak did not return Keycloak login form (e.g. before cluster rollout)
  log_warn "[Airflow] Keycloak login action not found on live cluster (requires GitOps sync of standalone fix)"
  fail "[Airflow] SSO login endpoint not ready"
fi

# -----------------------------------------------------------------------------
# 3. Trino SSO (Web UI OAuth2)
# -----------------------------------------------------------------------------
log_info "3. Testing Trino SSO (OAuth2 Web UI)..."
TRINO_JAR="${TMP_DIR}/trino_cookies.txt"
TRINO_HOST="trino.${BASE_DOMAIN}"

trino_start="$(run_curl "${TRINO_HOST}" -c "${TRINO_JAR}" -b "${TRINO_JAR}" -L "https://${TRINO_HOST}/oauth2/start" || true)"
trino_action="$(echo "${trino_start}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"

if [[ -n "${trino_action}" ]]; then
  run_curl "${TRINO_HOST}" -c "${TRINO_JAR}" -b "${TRINO_JAR}" \
    -d "username=${ADMIN_USER}" --data-urlencode "password@${PASS_FILE}" -d "credentialId=" \
    -L "${trino_action}" >/dev/null 2>&1 || true

  trino_cluster="$(run_curl "${TRINO_HOST}" -c "${TRINO_JAR}" -b "${TRINO_JAR}" "https://${TRINO_HOST}/ui/api/cluster" || true)"
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
OM_HOST="metadata.${BASE_DOMAIN}"

om_cfg="$(run_curl "${OM_HOST}" "https://${OM_HOST}/api/v1/system/config/auth" || true)"
if echo "${om_cfg}" | grep -q '"clientType":"confidential"'; then
  log_success "[OpenMetadata] auth config confirmed confidential clientType (PKCE/Authorization Code)"
else
  fail "[OpenMetadata] Unexpected auth config: ${om_cfg}"
fi

# -----------------------------------------------------------------------------
# 5. ArgoCD SSO (Native OIDC)
# -----------------------------------------------------------------------------
log_info "5. Testing ArgoCD OIDC configuration..."
ARGOCD_HOST="argocd.${BASE_DOMAIN}"

argocd_settings="$(run_curl "${ARGOCD_HOST}" "https://${ARGOCD_HOST}/api/v1/settings" || true)"
if echo "${argocd_settings}" | grep -q '"oidcConfig"'; then
  log_success "[ArgoCD] Native OIDC configuration confirmed in Settings API"
else
  fail "[ArgoCD] OIDC configuration missing in Settings API: ${argocd_settings}"
fi

# -----------------------------------------------------------------------------
# 6. Lakekeeper Catalog UI (OIDC Client & Perimeter Protection)
# -----------------------------------------------------------------------------
log_info "6. Testing Lakekeeper Catalog UI OIDC endpoints..."
CATALOG_HOST="catalog.${BASE_DOMAIN}"

# Gateway OIDC verification (perimeter)
cat_headers="$(run_curl "${CATALOG_HOST}" -I "https://${CATALOG_HOST}/ui" 2>&1 || true)"
if echo "${cat_headers}" | grep -q "302" && echo "${cat_headers}" | grep -q "sso.${BASE_DOMAIN}"; then
  log_success "[Lakekeeper] /ui perimeter protected by Gateway OIDC redirect"
else
  fail "[Lakekeeper] /ui unauthenticated access did not redirect to SSO"
fi

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
