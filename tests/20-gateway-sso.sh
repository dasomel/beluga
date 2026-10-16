#!/usr/bin/env bash
# Beluga E2E Test 20: Gateway SSO 및 OIDC 통합 라이브 검증 (D-SSO)
#
# 1) Gateway OIDC 보호 엔드포인트 익명 접근 차단 (302 Redirect to Keycloak):
#    - Flink Dashboard: https://flink.local.beluga.internal/
#    - SeaweedFS Filer: https://filer.local.beluga.internal/
#    - Lakekeeper Catalog UI: https://catalog.local.beluga.internal/ui
#    모두 미인증 GET 요청 시 Keycloak /realms/beluga/protocol/openid-connect/auth 로 302 리다이렉트.
# 2) Iceberg REST / Management / Health API 경로 SSO 바이패스:
#    - Lakekeeper Health: https://catalog.local.beluga.internal/health -> 200 OK (인증 없이 접근 허용).
# 3) ArgoCD OIDC 구성 확인:
#    - ArgoCD Settings API: https://argocd.local.beluga.internal/api/v1/settings
#    - 응답 JSON에 oidcConfig가 활성화되어 있는지 확인.
# 4) 게이트웨이 TLS 인증서 체인은 Beluga internal-ca로 검증 (--cacert 필수, -k 금지).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"

# Internal CA 추출 (cert-manager beluga-internal-ca-secret)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
CA_CERT="${TMP_DIR}/ca.crt"

if ! kubectl get secret beluga-internal-ca-secret -n cert-manager -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d > "${CA_CERT}"; then
  # 클러스터 접근 불가 시 리포지토리 내 기본 CA 또는 번들 확인
  if [ -f "${SCRIPT_DIR}/../.certs/ca.crt" ]; then
    cp "${SCRIPT_DIR}/../.certs/ca.crt" "${CA_CERT}"
  else
    log_warn "Internal CA secret not reachable via kubectl; attempting live gateway test using system store if available"
  fi
fi

CURL_OPTS=(-s -S)
if [ -s "${CA_CERT}" ]; then
  CURL_OPTS+=(--cacert "${CA_CERT}")
fi

FAILED=0
fail() {
  log_error "$*"
  FAILED=1
}

# Preflight check for rollout order (Item 6):
# APISIX Deployment requires apisix-oidc-credential and internal CA; verify presence before testing.
if ! kubectl get secret apisix-oidc-credential -n platform-system >/dev/null 2>&1; then
  log_error "Preflight check failed: Secret 'apisix-oidc-credential' not found in namespace platform-system."
  log_error "Required rollout order: run 'scripts/gitops/01-argocd-bootstrap.sh --argocd-oidc-only' BEFORE syncing gateway SSO."
  exit 1
fi

log_info "[TEST 20] Gateway SSO (D-SSO) 라이브 검증 시작..."

# 1. Gateway OIDC 차단 및 Keycloak 리다이렉트 검증
PROTECTED_ENDPOINTS=(
  "flink:https://flink.${BASE_DOMAIN}/"
  "filer:https://filer.${BASE_DOMAIN}/"
  "catalog-ui:https://catalog.${BASE_DOMAIN}/ui"
)

for target in "${PROTECTED_ENDPOINTS[@]}"; do
  name="${target%%:*}"
  url="${target#*:}"
  host="$(echo "${url}" | awk -F[/:] '{print $4}')"

  log_info "1/3: [${name}] 미인증 접근 시 Keycloak 302 리다이렉트 검증 (${url})..."
  resp_headers="$(curl "${CURL_OPTS[@]}" -I --resolve "${host}:443:${GATEWAY_IP}" "${url}" 2>&1 || true)"
  status_code="$(echo "${resp_headers}" | awk '/^HTTP\/[12](\.[0-9])? / {print $2}' | tail -n1)"
  location="$(echo "${resp_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"

  if [ "${status_code}" != "302" ]; then
    fail "[${name}] 미인증 접근이 302가 아닌 HTTP ${status_code} 반환"
  else
    log_success "[${name}] HTTP 302 응답 확인."
  fi

  if [[ "${location}" == *"sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/auth"* ]]; then
    log_success "[${name}] Location 헤더가 Keycloak OIDC 엔드포인트를 올바르게 가리킴: ${location}"
  else
    fail "[${name}] Location 헤더가 Keycloak auth URL이 아님: ${location}"
  fi
done

# 2. Iceberg REST / Catalog API 바이패스 검증
log_info "2/3: Catalog API (/health) SSO 바이패스 및 200 OK 검증..."
CATALOG_HOST="catalog.${BASE_DOMAIN}"
CATALOG_HEALTH_URL="https://${CATALOG_HOST}/health"

health_status="$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" --resolve "${CATALOG_HOST}:443:${GATEWAY_IP}" "${CATALOG_HEALTH_URL}" 2>&1 || true)"
if [ "${health_status}" == "200" ]; then
  log_success "Catalog /health 엔드포인트 200 OK 응답 확인 (SSO 바이패스 정상)."
else
  fail "Catalog /health 엔드포인트가 HTTP 200이 아닌 ${health_status} 반환"
fi

# 3. ArgoCD OIDC 설정 확인
log_info "3/3: ArgoCD OIDC 구성 확인..."
ARGOCD_HOST="argocd.${BASE_DOMAIN}"
ARGOCD_SETTINGS_URL="https://${ARGOCD_HOST}/api/v1/settings"

argocd_settings="$(curl "${CURL_OPTS[@]}" --resolve "${ARGOCD_HOST}:443:${GATEWAY_IP}" "${ARGOCD_SETTINGS_URL}" 2>&1 || true)"
if echo "${argocd_settings}" | grep -q '"oidcConfig"'; then
  log_success "ArgoCD Settings API에서 oidcConfig 선언 확인."
else
  fail "ArgoCD Settings API 응답에 oidcConfig 설정이 없음: ${argocd_settings}"
fi

if [ "${FAILED}" -ne 0 ]; then
  log_error "[TEST 20] Gateway SSO 라이브 검증 실패."
  exit 1
fi

log_success "[TEST 20] Gateway SSO 라이브 검증 전체 통과."
