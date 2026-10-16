#!/usr/bin/env bash
# Beluga E2E Test 20: Gateway SSO 및 OIDC 통합 라이브 검증 (D-SSO)
#
# 1) Gateway OIDC 보호 엔드포인트 완주 및 미인증 차단 (302 Redirect to Keycloak):
#    - Flink Dashboard: https://flink.local.beluga.internal/
#    - SeaweedFS Filer: https://filer.local.beluga.internal/
#    - Lakekeeper Catalog UI: https://catalog.local.beluga.internal/ui
#    Keycloak 로그인 완료 및 콜백 토큰 교환 완주(200 OK) 확인, 쿠키 없는 재요청 시 302 리다이렉트 확인.
# 2) Iceberg REST / Management / Health API 경로 SSO 바이패스:
#    - Lakekeeper Health: https://catalog.local.beluga.internal/health -> 200 OK (인증 없이 접근 허용).
# 3) ArgoCD OIDC 로그인 완주 및 구성 확인:
#    - ArgoCD Settings API: https://argocd.local.beluga.internal/api/v1/settings (oidcConfig 선언)
#    - /auth/login -> Keycloak -> /auth/callback 토큰 교환 -> userinfo(loggedIn=true, groups=[admins]) 및 applications 200 OK.
# 4) 게이트웨이 TLS 인증서 체인은 Beluga internal-ca로 검증 (--cacert 필수, -k 금지).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"

# Preflight check for rollout order (Item 6):
# APISIX Deployment requires apisix-oidc-credential and internal CA; verify presence before testing.
if ! kubectl get secret apisix-oidc-credential -n platform-system >/dev/null 2>&1; then
  log_error "Preflight check failed: Secret 'apisix-oidc-credential' not found in namespace platform-system."
  log_error "Required rollout order: run 'scripts/gitops/01-argocd-bootstrap.sh --argocd-oidc-only' BEFORE syncing gateway SSO."
  exit 1
fi

# Reuse test 22 helpers (CA, credentials, run_curl, login verification)
# shellcheck source=tests/22-sso-login-e2e.sh
source "${SCRIPT_DIR}/22-sso-login-e2e.sh"

log_info "=========================================================="
log_info " [TEST 20] Gateway SSO (D-SSO) 라이브 검증 시작..."
log_info " Base domain: ${BASE_DOMAIN}"
log_info " Gateway IP:  ${GATEWAY_IP}"
log_info "=========================================================="

# 1. Gateway OIDC 차단 및 Keycloak 리다이렉트 / 로그인 완주 검증
log_info "1/3: Gateway OIDC 보호 엔드포인트 로그인 완주 및 미인증 차단 검증..."
verify_apisix_oidc_login "flink" "flink.${BASE_DOMAIN}" "/" "/config" '("flink-version"|"features"|"taskmanagers")'
verify_apisix_oidc_login "filer" "filer.${BASE_DOMAIN}" "/" "/" '("Directory"|"<pre>"|"Path")'
verify_apisix_oidc_login "catalog-ui" "catalog.${BASE_DOMAIN}" "/ui" "/ui" '(<!DOCTYPE html>|<html|Lakekeeper)'

# 2. Iceberg REST / Catalog API 바이패스 검증
log_info "2/3: Catalog API (/health) SSO 바이패스 및 200 OK 검증..."
CATALOG_HOST="catalog.${BASE_DOMAIN}"
CATALOG_HEALTH_URL="https://${CATALOG_HOST}/health"

health_status="$(run_curl "${CATALOG_HOST}" -o /dev/null -w "%{http_code}" "${CATALOG_HEALTH_URL}" 2>&1 || true)"
if [ "${health_status}" == "200" ]; then
  log_success "Catalog /health 엔드포인트 200 OK 응답 확인 (SSO 바이패스 정상)."
else
  fail "Catalog /health 엔드포인트가 HTTP 200이 아닌 ${health_status} 반환"
fi

# 3. ArgoCD OIDC 로그인 완주 확인
log_info "3/3: ArgoCD OIDC 로그인 완주 확인..."
verify_argocd_oidc_login "argocd.${BASE_DOMAIN}"

if [ "${FAILED}" -ne 0 ]; then
  log_error "[TEST 20] Gateway SSO 라이브 검증 실패."
  exit 1
fi

log_success "[TEST 20] Gateway SSO 라이브 검증 전체 통과."
