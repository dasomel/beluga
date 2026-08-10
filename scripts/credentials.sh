#!/usr/bin/env bash
# Beluga 자격증명 일괄 조회 (D15) — narwhal의 요약 출력 패턴 승계.
#
# 사용법:
#   bash scripts/credentials.sh          # 서비스별 URL·계정·비밀번호를 한 번에 출력
#   bash scripts/credentials.sh --raw    # key=value 형태만 (스크립트/파이프용)
#
# 값은 전부 K8s Secret에서 실시간 조회한다 — 리포에는 실값이 없다(D15).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/env.sh"

RAW=0
[[ "${1:-}" == "--raw" ]] && RAW=1

export KUBECONFIG="${KUBECONFIG:-${BELUGA_ROOT}/.kube/config}"
[[ -f "${KUBECONFIG}" ]] || { log_error "kubeconfig가 없다. 먼저 실행: bash scripts/kubeconfig.sh"; exit 1; }
kubectl get ns beluga-system >/dev/null 2>&1 || { log_error "클러스터에 접속할 수 없다. bash scripts/kubeconfig.sh 로 확인."; exit 1; }

cred() { kubectl -n beluga-system get secret beluga-credentials -o jsonpath="{.data.$1}" 2>/dev/null | base64 -d; }

PG_PASS="$(cred pg-password)"
KC_PASS="$(cred keycloak-admin-password)"
SUPERSET_PASS="$(cred superset-admin-password)"
APISIX_KEY="$(cred apisix-admin-key)"
USER_PASS_ADMIN="$(cred user-password-admin)"
USER_PASS_ENGINEER="$(cred user-password-engineer)"
USER_PASS_ANALYST="$(cred user-password-analyst)"
ARGOCD_PASS="$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)"

if [[ ${RAW} -eq 1 ]]; then
  cat <<EOF
PG_PASSWORD=${PG_PASS}
KEYCLOAK_ADMIN_PASSWORD=${KC_PASS}
SUPERSET_ADMIN_PASSWORD=${SUPERSET_PASS}
APISIX_ADMIN_KEY=${APISIX_KEY}
ARGOCD_ADMIN_PASSWORD=${ARGOCD_PASS}
KEYCLOAK_USER_ADMIN_PASSWORD=${USER_PASS_ADMIN}
KEYCLOAK_USER_ENGINEER_PASSWORD=${USER_PASS_ENGINEER}
KEYCLOAK_USER_ANALYST_PASSWORD=${USER_PASS_ANALYST}
EOF
  exit 0
fi

D="${BASE_DOMAIN:-local.beluga.internal}"
cat <<EOF

==========================================================
 Beluga 자격증명 (D15 — 부트스트랩 시 랜덤 생성)
==========================================================

[웹 UI]  전부 http://<서브도메인>.${D} (포트 80)

  서비스        URL                              계정 / 비밀번호
  ------------  -------------------------------  -----------------------------
  Superset      http://superset.${D}   admin / ${SUPERSET_PASS}
  Airflow       http://airflow.${D}    콘솔 로그 참조 (standalone)
  Keycloak      http://sso.${D}        admin / ${KC_PASS}
  ArgoCD        http://argocd.${D}     admin / ${ARGOCD_PASS:-<미조회>}
  OpenMetadata  http://metadata.${D}   admin (custom-oidc)
  Trino         http://trino.${D}      인증 없음 (dev)
  Flink         http://flink.${D}      인증 없음
  Lakekeeper    http://catalog.${D}    인증 없음 (REST)
  SeaweedFS S3  http://s3.${D}         any / any

[SSO 사용자]  realm 'beluga' (Keycloak SSO)
  계정             비밀번호                      그룹 / 역할
  ---------------  ----------------------------  -----------------------------
  beluga-admin     ${USER_PASS_ADMIN}              admin (Superset Admin 등)
  beluga-engineer  ${USER_PASS_ENGINEER}              engineer (Superset Alpha 등)
  beluga-analyst   ${USER_PASS_ANALYST}              analyst (Superset Gamma 등)

[데이터베이스]  CNPG postgres-main (beluga-data)
  사용자: beluga_admin
  비밀번호: ${PG_PASS}
  DB: shop, beluga_meta, lakekeeper, keycloak, openmetadata

[Kafka]  호스트에서 bootstrap: ${MASTER_IP}:${HOST_PORT_KAFKA:-9094} (인증 없음)

[내부용]  APISIX admin key: ${APISIX_KEY}

원본 Secret 직접 조회:
  kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d
  (키: pg-password, keycloak-admin-password, superset-secret-key,
        superset-admin-password, apisix-admin-key, client-secret-<앱>,
        user-password-admin, user-password-engineer, user-password-analyst)
==========================================================

EOF
