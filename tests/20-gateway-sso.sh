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
# 3) allowedGroups(D-MSSO-14) 그룹 게이트 — gitops/values/sso.yaml의 flink/filer allowedGroups=[admins, engineers]:
#    - flink: beluga-admin 200(위 로그인 완주), beluga-engineer 200, beluga-analyst 403(본문 "Forbidden: group not allowed")
#    - filer: beluga-engineer 200, beluga-analyst 403
#    비밀번호는 Secret iam/keycloak-user-passwords의 engineer/analyst 키에서 0600 임시파일로 읽는다(출력 금지).
# 4) ArgoCD OIDC 로그인 완주 및 구성 확인:
#    - ArgoCD Settings API: https://argocd.local.beluga.internal/api/v1/settings (oidcConfig 선언)
#    - /auth/login -> Keycloak -> /auth/callback 토큰 교환 -> userinfo(loggedIn=true, groups=[admins]) 및 applications 200 OK.
# 5) 게이트웨이 TLS 인증서 체인은 Beluga internal-ca로 검증 (--cacert 필수, -k 금지).
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
log_info "1/4: Gateway OIDC 보호 엔드포인트 로그인 완주 및 미인증 차단 검증..."
verify_apisix_oidc_login "flink" "flink.${BASE_DOMAIN}" "/" "/config" '("flink-version"|"features"|"taskmanagers")'
verify_apisix_oidc_login "filer" "filer.${BASE_DOMAIN}" "/" "/" 'SeaweedFS'
verify_apisix_oidc_login "catalog-ui" "catalog.${BASE_DOMAIN}" "/ui/" "/ui/" '(<!DOCTYPE html>|<html|Lakekeeper)'

# 2. Iceberg REST / Catalog API 바이패스 검증
log_info "2/4: Catalog API (/health) SSO 바이패스 및 200 OK 검증..."
CATALOG_HOST="catalog.${BASE_DOMAIN}"
CATALOG_HEALTH_URL="https://${CATALOG_HOST}/health"

health_status="$(run_curl "${CATALOG_HOST}" -o /dev/null -w "%{http_code}" "${CATALOG_HEALTH_URL}" 2>&1 || true)"
if [ "${health_status}" == "200" ]; then
  log_success "Catalog /health 엔드포인트 200 OK 응답 확인 (SSO 바이패스 정상)."
else
  fail "Catalog /health 엔드포인트가 HTTP 200이 아닌 ${health_status} 반환"
fi

# 3. allowedGroups 그룹 게이트 (D-MSSO-14): 로그인은 성공하지만 그룹이 허용 목록 밖이면 게이트웨이가 403
# verify_group_gate <이름> <호스트> <경로> <사용자> <Secret 키> <기대 HTTP 코드>
verify_group_gate() {
  local name="$1" host="$2" path="$3" user="$4" key="$5" want="$6"
  local jar="${TMP_DIR}/${name}_${user}_cookies.txt" pass_file="${TMP_DIR}/${user}.pass"
  rm -f "${jar}"

  local pw
  pw="$(kubectl get secret -n iam keycloak-user-passwords -o jsonpath="{.data.${key}}" | base64 -d)"
  if [[ -z "${pw}" ]]; then
    fail "[${name}] Secret keycloak-user-passwords 키 '${key}' 비밀번호 조회 실패"
    return 1
  fi
  printf '%s' "${pw}" > "${pass_file}"
  chmod 600 "${pass_file}"

  local login_html action
  login_html="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L "https://${host}${path}" 2>&1 || true)"
  action="$(extract_login_action "${login_html}")"
  if [[ -z "${action}" ]]; then
    fail "[${name}/${user}] Keycloak 로그인 폼 action URL 추출 실패"
    return 1
  fi
  run_curl "${host}" -c "${jar}" -b "${jar}" \
    -d "username=${user}" --data-urlencode "password@${pass_file}" -d "credentialId=" \
    -L "${action}" >/dev/null 2>&1 || true

  local body_file="${TMP_DIR}/${name}_${user}.body" code
  code="$(run_curl "${host}" -c "${jar}" -b "${jar}" -L -o "${body_file}" -w "%{http_code}" "https://${host}${path}" 2>&1 || true)"
  if [[ "${code}" != "${want}" ]]; then
    fail "[${name}/${user}] 그룹 게이트: HTTP ${code} (기대 ${want})"
    return 1
  fi
  if [[ "${want}" == "403" ]] && ! grep -q 'Forbidden: group not allowed' "${body_file}"; then
    fail "[${name}/${user}] 403 응답 본문에 'Forbidden: group not allowed' 없음 (게이트웨이가 아닌 다른 계층의 403 가능)"
    return 1
  fi
  log_success "[${name}/${user}] 그룹 게이트 HTTP ${code} 확인"
}

log_info "3/4: allowedGroups 그룹 게이트(admins, engineers 허용 / analysts 차단) 검증..."
verify_group_gate "flink" "flink.${BASE_DOMAIN}" "/config" "beluga-engineer" "engineer" "200"
verify_group_gate "flink" "flink.${BASE_DOMAIN}" "/config" "beluga-analyst" "analyst" "403"
verify_group_gate "filer" "filer.${BASE_DOMAIN}" "/" "beluga-engineer" "engineer" "200"
verify_group_gate "filer" "filer.${BASE_DOMAIN}" "/" "beluga-analyst" "analyst" "403"

# 4. ArgoCD OIDC 로그인 완주 확인
log_info "4/4: ArgoCD OIDC 로그인 완주 확인..."
verify_argocd_oidc_login "argocd.${BASE_DOMAIN}"

if [ "${FAILED}" -ne 0 ]; then
  log_error "[TEST 20] Gateway SSO 라이브 검증 실패."
  exit 1
fi

log_success "[TEST 20] Gateway SSO 라이브 검증 전체 통과."
