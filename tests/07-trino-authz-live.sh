#!/usr/bin/env bash
# Trino OPA default-deny 컷오버(Task 14) 라이브 회귀 검증 — 최종 리뷰 I-2
#
# beluga/CLAUDE.md의 "모든 검증은 tests/ 하위 스크립트로 실상태를 조회해 확인한다"
# 규율에 따라, 이 체인에서 가장 되돌리기 어려운 변경(default allow := false 컷오버)에
# 대한 자동 회귀 커버리지가 하나도 없던 공백을 메운다. 아래 4개 케이스는 이 수정
# 웨이브 진행 중 라이브 클러스터에서 이미 수동으로 확인된 흐름을 스크립트로 옮긴 것이다.
#
# 비밀번호/클라이언트 시크릿은 절대 curl argv나 -d로 넘기지 않는다 — ps나 kubectl exec
# API 호출 감사 로그에 그대로 노출된다(06-authz-defaults.sh와 동일한 원칙). form 본문을
# 셸 변수로 만들어 --data-binary @-로 stdin을 통해서만 전달한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
# 이슈 #2: 게이트웨이 전역 HTTP→HTTPS 301 전환으로 http:// 호출은 POST 본문이 유실되거나
# (curl은 -L 없이는 301을 따라가지 않음) 내부 CA 미신뢰로 실패한다 — https + --cacert로 전환.
TRINO_BASE="https://trino.${BASE_DOMAIN}"
SSO_TOKEN_URL="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/token"

log_info "[TEST 07] Trino OPA default-deny 라이브 회귀 검증..."

CA_CRT_FILE="$(mktemp)"
kubectl -n cert-manager get secret beluga-internal-ca-secret -o jsonpath='{.data.ca\.crt}' | base64 -d > "${CA_CRT_FILE}"

ANALYST_PASS=$(kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.user-password-analyst}' | base64 -d)
TRINO_SECRET=$(kubectl -n iam get secret keycloak-client-secrets -o jsonpath='{.data.trino}' | base64 -d)

get_token() {
  # ROPC 그랜트. 비밀번호·클라이언트 시크릿은 form 본문을 stdin으로만 전달한다.
  local form
  form="client_id=trino&client_secret=${TRINO_SECRET}&grant_type=password&username=beluga-analyst&password=${ANALYST_PASS}&scope=openid"
  printf '%s' "${form}" | curl -s -X POST --cacert "${CA_CRT_FILE}" "${SSO_TOKEN_URL}" \
    -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))"
}

# $1: 토큰, $2: SQL, $3: 결과를 쓸 파일 경로(누적 data 배열), 반환: stdout에 최종 error(JSON, 없으면 "null")
run_query() {
  local token="$1" sql="$2" data_out="$3"
  local resp next url
  local page_file="${data_out}.page"
  echo "[]" > "${data_out}"
  resp=$(curl -s -X POST --cacert "${CA_CRT_FILE}" "${TRINO_BASE}/v1/statement" \
    -H "Authorization: Bearer ${token}" -H "X-Trino-User: beluga-analyst" \
    --data-binary "${sql}")
  printf '%s' "${resp}" > "${page_file}"
  next=$(python3 -c "import json; print(json.load(open('${page_file}')).get('nextUri') or '')")
  local error
  error=$(python3 -c "import json; print(json.dumps(json.load(open('${page_file}')).get('error')))")

  while [[ -n "${next}" ]]; do
    # Trino가 nextUri에 실어 보내는 :9080 같은 내부 포트는 클러스터 밖에서 접근 불가 —
    # local.beluga.internal 뒤의 포트 부분만 제거하고 경로는 그대로 따라간다.
    url=$(echo "${next}" | sed -E 's/(local\.beluga\.internal):[0-9]+/\1/')
    resp=$(curl -s -X GET --cacert "${CA_CRT_FILE}" "${url}" -H "Authorization: Bearer ${token}" -H "X-Trino-User: beluga-analyst")
    printf '%s' "${resp}" > "${page_file}"
    error=$(python3 -c "import json; print(json.dumps(json.load(open('${page_file}')).get('error')))")
    # 각 페이지의 data를 누적한다 — 마지막 페이지는 성공해도 보통 data: null이라
    # 마지막 페이지만 보면 성공한 쿼리도 빈 것처럼 보인다.
    python3 -c "
import json
existing = json.load(open('${data_out}'))
page = json.load(open('${page_file}'))
new = page.get('data') or []
existing.extend(new)
json.dump(existing, open('${data_out}', 'w'))
"
    next=$(python3 -c "import json; print(json.load(open('${page_file}')).get('nextUri') or '')")
  done
  rm -f "${page_file}"
  echo "${error}"
}

TOKEN=$(get_token)
if [[ -z "${TOKEN}" ]]; then
  log_error "beluga-analyst 토큰 발급 실패 — Keycloak ROPC 그랜트 확인 필요"
  exit 1
fi

TMPDIR_T=$(mktemp -d)
trap 'rm -rf "${TMPDIR_T}" "${CA_CRT_FILE}"' EXIT

# 케이스 1: SHOW TABLES FROM iceberg.lake — 성공 + orders 포함
log_info "1/4: SHOW TABLES FROM iceberg.lake (analyst)..."
ERR1=$(run_query "${TOKEN}" "SHOW TABLES FROM iceberg.lake" "${TMPDIR_T}/c1.json")
TABLE_COUNT=$(python3 -c "import json; print(len(json.load(open('${TMPDIR_T}/c1.json'))))")
HAS_ORDERS=$(python3 -c "
import json
rows = json.load(open('${TMPDIR_T}/c1.json'))
print('yes' if any(r and r[0] == 'orders' for r in rows) else 'no')
")
if [[ "${ERR1}" != "null" ]] || [[ "${TABLE_COUNT}" -eq 0 ]] || [[ "${HAS_ORDERS}" != "yes" ]]; then
  log_error "SHOW TABLES 실패 또는 orders 누락 (error=${ERR1}, count=${TABLE_COUNT}, has_orders=${HAS_ORDERS})"
  exit 1
fi
log_success "1/4 통과 — 테이블 ${TABLE_COUNT}개, orders 포함"

# 케이스 2: SELECT * FROM iceberg.lake.orders LIMIT 1 — 성공 + 행 1개 이상
log_info "2/4: SELECT * FROM iceberg.lake.orders LIMIT 1 (analyst)..."
ERR2=$(run_query "${TOKEN}" "SELECT * FROM iceberg.lake.orders LIMIT 1" "${TMPDIR_T}/c2.json")
ROW_COUNT2=$(python3 -c "import json; print(len(json.load(open('${TMPDIR_T}/c2.json'))))")
if [[ "${ERR2}" != "null" ]] || [[ "${ROW_COUNT2}" -eq 0 ]]; then
  log_error "orders SELECT 실패 (error=${ERR2}, rows=${ROW_COUNT2})"
  exit 1
fi
log_success "2/4 통과 — orders에서 행 ${ROW_COUNT2}개 조회됨"

# 케이스 3: SELECT * FROM iceberg.lake.customers LIMIT 1 — 거부(Access Denied류 에러)
log_info "3/4: SELECT * FROM iceberg.lake.customers LIMIT 1 (analyst, 거부 기대)..."
ERR3=$(run_query "${TOKEN}" "SELECT * FROM iceberg.lake.customers LIMIT 1" "${TMPDIR_T}/c3.json")
if [[ "${ERR3}" == "null" ]]; then
  log_error "customers SELECT가 거부되지 않음 — default allow := false 컷오버 회귀"
  exit 1
fi
log_success "3/4 통과 — customers SELECT 거부됨 (error=${ERR3})"

# 케이스 4: 토큰 없이 X-Trino-User 자칭 — HTTP 401 (403이 아님: 게이트웨이 차단이 아니라
# 인증 자체가 거부되어야 하는 신호)
log_info "4/4: 토큰 없이 X-Trino-User: admin 자칭 (401 기대)..."
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST --cacert "${CA_CRT_FILE}" "${TRINO_BASE}/v1/statement" \
  -H "X-Trino-User: admin" --data-binary "SELECT 1")
if [[ "${HTTP_CODE}" != "401" ]]; then
  log_error "예상치 못한 HTTP 코드: ${HTTP_CODE} (401 기대) — OAuth2 인증 강제 회귀 가능성"
  exit 1
fi
log_success "4/4 통과 — 인증 없는 요청이 401로 거부됨"

log_success "[TEST 07] Trino OPA default-deny 라이브 회귀 4/4 통과."
