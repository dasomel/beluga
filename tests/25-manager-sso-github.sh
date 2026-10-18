#!/usr/bin/env bash
# Beluga E2E Test 25: Manager GitHub writer / ArgoCD reader 라이브 검증 (ADR-0009 롤아웃 ④, D-MSSO-15/16/17/18/19)
#
# 항상(비파괴):
#  1) ServiceAccount manager-domain-api의 권한이 get 하나뿐이다: kubectl auth can-i --as=<SA> 로
#     argocd Application beluga-data/beluga-platform get = yes, 다른 이름 get = no, list = no, platform-system Secret get = no
#  2) Deployment는 serviceAccountName=manager-domain-api, automountServiceAccountToken=false, kube-api 볼륨을 쓴다
#  3) GET /sso/change-requests/contract 의 gitWriterConfigured 가 Secret manager-github-app 존재 여부와 일치
# Secret manager-github-app 없음(소유자 작업 전): 제출이 503 GIT_WRITER_UNCONFIGURED, PR 부분은 SKIP 하고 exit 0.
# Secret 있음 + --create-pr: 실제 PR을 만든다(flink allowedGroups에서 analysts 토글, admins 유지) ->
#   201 pr_open, head ref ^sso/flink-[0-9a-f]{12}$, 같은 Idempotency-Key 재생은 같은 id, 취소 -> PR closed + stage failed.
#   --create-pr 없이는 PR을 만들지 않는다(Secret이 있어도 제출 호출 자체를 하지 않는다).
# 어떤 경우에도 머지하지 않는다. 비밀번호/토큰은 0600 임시파일로만 다루고 출력하지 않는다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"
NS=platform-system
SA="system:serviceaccount:${NS}:manager-domain-api"
HOST="manager.${BASE_DOMAIN}"
API="https://${HOST}/api/v1"

CREATE_PR=0
for arg in "$@"; do
  case "${arg}" in
    --create-pr) CREATE_PR=1 ;;
    *) echo "usage: $0 [--create-pr]" >&2; exit 2 ;;
  esac
done

TMP_DIR="$(mktemp -d)"
CREATED_ID=""
CANCELLED=0
ADMIN_HDR="${TMP_DIR}/admin.hdr"
# 중간 실패에도 이 실행이 만든 열린 요청은 취소한다(잠금이 남지 않도록). 취소 실패는 수동 정리 안내를 남긴다.
cleanup() {
  if [[ -n "${CREATED_ID}" && "${CANCELLED}" == "0" && -s "${ADMIN_HDR}" ]]; then
    log_warn "trap: 이 실행이 만든 요청 ${CREATED_ID} 취소 시도..."
    curl -s -S --max-time 30 -o /dev/null -X POST -H "@${ADMIN_HDR}" -H "Content-Type: application/json" \
      --cacert "${TMP_DIR}/ca.crt" --resolve "${HOST}:443:${GATEWAY_IP}" -d '{"reason":"tests/25 cleanup"}' \
      "${API}/sso/change-requests/${CREATED_ID}/cancel" || log_error "취소 실패: 요청 ${CREATED_ID}를 수동 취소(Manager UI 또는 API)하라"
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

FAILED=0
fail() { log_error "$*"; FAILED=1; }

CA_CERT="${TMP_DIR}/ca.crt"
if ! kubectl get secret beluga-internal-ca-secret -n cert-manager -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d > "${CA_CERT}" || [[ ! -s "${CA_CERT}" ]]; then
  if [[ -f "${SCRIPT_DIR}/../.certs/ca.crt" ]]; then
    cp "${SCRIPT_DIR}/../.certs/ca.crt" "${CA_CERT}"
  else
    log_error "Internal CA certificate not found; cannot verify TLS"
    exit 1
  fi
fi

run_curl() {
  curl -s -S --max-time 30 --cacert "${CA_CERT}" \
    --resolve "sso.${BASE_DOMAIN}:443:${GATEWAY_IP}" --resolve "${HOST}:443:${GATEWAY_IP}" "$@"
}

extract_login_action() {
  local html="$1" action
  action="$(printf '%s' "${html}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"
  case "${action}" in
    "https://sso.${BASE_DOMAIN}/realms/beluga/login-actions/"*) printf '%s' "${action}" ;;
    *) printf '' ;;
  esac
}

# login_bearer <keycloak-user> <secret-key> <header-file>: tests/22 verify_manager_pkce_login와 같은 PKCE(S256) 흐름.
# 결과는 "Authorization: Bearer ..." 한 줄을 담은 0600 파일이다. 비밀번호는 0600 파일에서 --data-urlencode password@file.
login_bearer() {
  local user="$1" key="$2" header_file="$3"
  local sso="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect"
  local redirect_uri="https://${HOST}/auth/callback"
  local redirect_enc="https%3A%2F%2F${HOST}%2Fauth%2Fcallback"
  local jar="${TMP_DIR}/jar_${key}.txt" pass_file="${TMP_DIR}/${key}.pass"
  rm -f "${jar}"
  (umask 077 && kubectl get secret -n iam keycloak-user-passwords -o "jsonpath={.data.${key}}" | base64 -d > "${pass_file}")
  if [[ ! -s "${pass_file}" ]]; then
    fail "Secret iam/keycloak-user-passwords 키 ${key} 없음"
    return 1
  fi

  local verifier challenge state nonce
  verifier="$(openssl rand -base64 64 | tr -d '=+/\n' | cut -c1-64)"
  challenge="$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  state="$(openssl rand -hex 12)"
  nonce="$(openssl rand -hex 12)"

  local login_html action
  login_html="$(run_curl -c "${jar}" -b "${jar}" -L "${sso}/auth?client_id=beluga-manager&response_type=code&scope=openid%20profile%20email&redirect_uri=${redirect_enc}&state=${state}&nonce=${nonce}&code_challenge=${challenge}&code_challenge_method=S256" 2>&1 || true)"
  action="$(extract_login_action "${login_html}")"
  if [[ -z "${action}" ]]; then
    fail "[${user}] Keycloak 로그인 폼 action 추출 실패"
    return 1
  fi
  local post_headers cb_loc code
  post_headers="$(run_curl -c "${jar}" -b "${jar}" -d "username=${user}" --data-urlencode "password@${pass_file}" -d "credentialId=" -i "${action}" 2>&1 || true)"
  cb_loc="$(printf '%s' "${post_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"
  code="$(printf '%s' "${cb_loc}" | sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p')"
  if [[ "${cb_loc}" != "${redirect_uri}?"* || -z "${code}" ]]; then
    fail "[${user}] 로그인 후 authorization code 획득 실패"
    return 1
  fi

  local form_file="${TMP_DIR}/token_form_${key}.txt" token_json="${TMP_DIR}/token_${key}.json" token_code
  (umask 077 && printf 'grant_type=authorization_code&client_id=beluga-manager&code=%s&redirect_uri=%s&code_verifier=%s' \
    "${code}" "${redirect_enc}" "${verifier}" > "${form_file}")
  token_code="$(run_curl -o "${token_json}" -w "%{http_code}" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-binary "@${form_file}" "${sso}/token" 2>&1 || true)"
  rm -f "${form_file}" "${pass_file}"
  if [[ "${token_code}" != "200" ]]; then
    fail "[${user}] PKCE 토큰 교환 실패 (HTTP ${token_code})"
    rm -f "${token_json}"
    return 1
  fi
  TOKEN_JSON="${token_json}" HEADER_FILE="${header_file}" python3 -c '
import json, os
tok = json.load(open(os.environ["TOKEN_JSON"]))["access_token"]
fd = os.open(os.environ["HEADER_FILE"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("Authorization: Bearer " + tok + "\n")
'
  rm -f "${token_json}"
  log_success "[${user}] PKCE 로그인 완료, bearer 획득 (값 미출력)"
}

# api <outfile> <curl-args...>: 응답 본문은 outfile, 상태 코드는 stdout
api() {
  local out="$1"
  shift
  run_curl -o "${out}" -w "%{http_code}" "$@" 2>/dev/null || printf '000'
}

# json_get <file> <dotted.path>: 본문에서 값을 뽑는다(없거나 파싱 실패면 빈 문자열). 경로는 인자로만 해석한다(eval 없음).
json_get() {
  F="$1" python3 -c '
import json, os, sys
try:
    v = json.load(open(os.environ["F"]))
    for k in sys.argv[1].split("."):
        v = v[k]
    print(v if v is not None else "")
except Exception:
    print("")
' "$2"
}

# expect <label> <want-status> <want-code|-> <outfile> <got-status>
expect() {
  local label="$1" want="$2" want_code="$3" out="$4" got="$5" code
  code="$(json_get "${out}" error.code)"
  if [[ "${got}" == "${want}" && ( "${want_code}" == "-" || "${code}" == "${want_code}" ) ]]; then
    log_success "${label}: HTTP ${got}${code:+ ${code}}"
  else
    fail "${label}: 기대 HTTP ${want} ${want_code}, 실제 HTTP ${got} ${code}"
  fi
}

# post_body <file> <endpoint> <group...>: 요청 본문 JSON(baseBlobSha는 BASE_BLOB가 있을 때만)
post_body() {
  local file="$1" endpoint="$2"
  shift 2
  BLOB="${BASE_BLOB:-}" python3 -c '
import json, os, sys
body = {"endpoint": sys.argv[1], "allowedGroups": sys.argv[2:]}
if os.environ["BLOB"]:
    body["baseBlobSha"] = os.environ["BLOB"]
json.dump(body, sys.stdout)
' "${endpoint}" "$@" > "${file}"
}

# can_i <expect yes|no> <label> <kubectl auth can-i args...>: SA를 가장해 권한을 실측한다(가장 권한이 없으면 실패로 보고).
can_i() {
  local want="$1" label="$2" got rc=0
  shift 2
  got="$(kubectl auth can-i --as="${SA}" "$@" 2>&1)" || rc=$?
  got="$(printf '%s' "${got}" | tail -n1)"
  if [[ "${got}" == "${want}" ]]; then
    log_success "1 ${label}: ${got}"
  else
    fail "1 ${label}: 기대 ${want}, 실제 '${got}' (rc=${rc})"
  fi
}

log_info "=========================================================="
log_info " [TEST 25] Manager GitHub writer / ArgoCD reader (ADR-0009 ④)"
log_info " Manager: ${HOST} (gateway ${GATEWAY_IP}), create-pr: ${CREATE_PR}"
log_info "=========================================================="

# 1) Role은 get 전용 (D-MSSO-16)
can_i yes "get applications beluga-data" get applications.argoproj.io/beluga-data -n argocd
can_i yes "get applications beluga-platform" get applications.argoproj.io/beluga-platform -n argocd
can_i no "get applications 다른 이름" get applications.argoproj.io/not-allowed -n argocd
can_i no "list applications" list applications.argoproj.io -n argocd
can_i no "update applications beluga-data" update applications.argoproj.io/beluga-data -n argocd
can_i no "get secrets in ${NS}" get secrets -n "${NS}"

# 2) Deployment 배선
dep_json="${TMP_DIR}/dep.json"
kubectl -n "${NS}" get deployment manager-domain-api -o json > "${dep_json}"
if F="${dep_json}" python3 -c '
import json, os
p = json.load(open(os.environ["F"]))["spec"]["template"]["spec"]
assert p["serviceAccountName"] == "manager-domain-api"
assert p.get("automountServiceAccountToken") is False
vols = {v["name"] for v in p["volumes"]}
assert {"kube-api", "github-app"} <= vols
# D-MSSO-15a: 키 파일은 0440 + fsGroup 1000 (③에서 검증된 manager-db-password 패턴)이라 uid 1000이 읽는다
key = next(v for v in p["volumes"] if v["name"] == "github-app")["secret"]
assert key["defaultMode"] == 0o440, key
assert p["securityContext"]["fsGroup"] == 1000
'; then
  log_success "2 Deployment: serviceAccountName=manager-domain-api, automount=false, kube-api/github-app 볼륨"
else
  fail "2 Deployment 배선이 계약과 다르다"
fi

login_bearer beluga-admin admin "${ADMIN_HDR}" || { log_error "admin 로그인 실패, 중단"; exit 1; }

SECRET_PRESENT=0
if kubectl -n "${NS}" get secret manager-github-app >/dev/null 2>&1; then SECRET_PRESENT=1; fi
log_info "Secret manager-github-app: $([[ "${SECRET_PRESENT}" == "1" ]] && echo 존재 || echo 없음)"

# 3) contract 엔드포인트
CONTRACT="${TMP_DIR}/contract.json"
RESP="${TMP_DIR}/resp.json"
BODY="${TMP_DIR}/body.json"
JSON_H=(-H "Content-Type: application/json")
code="$(api "${CONTRACT}" -H "@${ADMIN_HDR}" "${API}/sso/change-requests/contract")"
WRITER_FLAG="$(json_get "${CONTRACT}" gitWriterConfigured)"
want_flag="False"
[[ "${SECRET_PRESENT}" == "1" ]] && want_flag="True"
if [[ "${code}" == "200" && "${WRITER_FLAG}" == "${want_flag}" ]]; then
  log_success "3 contract: HTTP 200, gitWriterConfigured=${WRITER_FLAG} (Secret 존재 여부와 일치)"
else
  fail "3 contract: HTTP ${code}, gitWriterConfigured='${WRITER_FLAG}' (기대 ${want_flag})"
fi
BASE_BLOB="$(json_get "${CONTRACT}" baseBlobSha)"

# 변경안: flink allowedGroups에서 analysts 토글(admins는 항상 유지). 현재 값은 contract.current.flink.
read -r -a CUR_GROUPS <<< "$(F="${CONTRACT}" python3 -c '
import json, os
c = json.load(open(os.environ["F"]))
print(" ".join(c["current"].get("flink") or []))
')"
if [[ ${#CUR_GROUPS[@]} -eq 0 ]]; then
  log_error "contract.current.flink 가 비어 있어 테스트 전제가 깨졌다"
  exit 1
fi
NEW_GROUPS=()
HAS_ANALYSTS=0
for g in "${CUR_GROUPS[@]}"; do
  if [[ "${g}" == "analysts" ]]; then HAS_ANALYSTS=1; else NEW_GROUPS+=("${g}"); fi
done
[[ "${HAS_ANALYSTS}" == "0" ]] && NEW_GROUPS+=("analysts")

IDEM_KEY="$(openssl rand -hex 16)"
SUBMIT_URL="${API}/sso/change-requests"

if [[ "${SECRET_PRESENT}" == "0" ]]; then
  # 4) writer 미구성: 제출 503, PR 부분 SKIP
  post_body "${BODY}" flink "${NEW_GROUPS[@]}"
  code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" -H "Idempotency-Key: ${IDEM_KEY}" --data-binary "@${BODY}" "${SUBMIT_URL}")"
  expect "4 writer 미구성 제출" 503 GIT_WRITER_UNCONFIGURED "${RESP}" "${code}"
  log_warn "SKIP: PR 생성/재생/취소 부분 — Secret manager-github-app 없음(소유자 작업 전, ADR-0009 Owner manual tasks)"
elif [[ "${CREATE_PR}" == "0" ]]; then
  log_warn "SKIP: PR 생성/재생/취소 부분 — Secret은 있으나 --create-pr 없음(기본은 PR을 만들지 않는다)"
else
  # 4) 실제 PR 흐름 (D-MSSO-19)
  PREVIEW_JSON="${TMP_DIR}/preview.json"
  post_body "${BODY}" flink "${NEW_GROUPS[@]}"
  code="$(api "${PREVIEW_JSON}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${SUBMIT_URL}?dryRun=true")"
  expect "4a 미리보기" 200 - "${PREVIEW_JSON}" "${code}"
  BASE_BLOB="$(json_get "${PREVIEW_JSON}" baseBlobSha)"
  post_body "${BODY}" flink "${NEW_GROUPS[@]}"
  code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" -H "Idempotency-Key: ${IDEM_KEY}" --data-binary "@${BODY}" "${SUBMIT_URL}")"
  CREATED_ID="$(json_get "${RESP}" id)"
  STAGE="$(json_get "${RESP}" stage)"
  BRANCH="$(json_get "${RESP}" branch)"
  PR_NUMBER="$(json_get "${RESP}" pr.number)"
  if [[ "${code}" =~ ^20[01]$ && "${STAGE}" == "pr_open" && -n "${CREATED_ID}" && "${BRANCH}" =~ ^sso/flink-[0-9a-f]{12}$ && "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
    log_success "4b 제출: HTTP ${code}, stage pr_open, branch ${BRANCH}, PR #${PR_NUMBER}"
  else
    fail "4b 제출 기대 pr_open + 브랜치 형식, 실제 HTTP ${code} stage='${STAGE}' branch='${BRANCH}' pr='${PR_NUMBER}'"
  fi

  # 같은 키 재생 -> 같은 id
  code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" -H "Idempotency-Key: ${IDEM_KEY}" --data-binary "@${BODY}" "${SUBMIT_URL}")"
  if [[ "${code}" == "200" && "$(json_get "${RESP}" id)" == "${CREATED_ID}" ]]; then
    log_success "4c 같은 Idempotency-Key 재생: 같은 id"
  else
    fail "4c 재생 기대 HTTP 200 + 같은 id, 실제 HTTP ${code} id='$(json_get "${RESP}" id)'"
  fi

  # 열린 요청 목록에 보인다
  code="$(api "${RESP}" -H "@${ADMIN_HDR}" "${SUBMIT_URL}?status=open")"
  if [[ "${code}" == "200" ]] && F="${RESP}" ID="${CREATED_ID}" python3 -c '
import json, os
assert any(i["id"] == os.environ["ID"] for i in json.load(open(os.environ["F"]))["items"])
'; then
    log_success "4d GET ?status=open 에 요청이 있다"
  else
    fail "4d GET ?status=open 에 요청이 없다 (HTTP ${code})"
  fi

  # 취소 -> failed, PR closed
  code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" -d '{"reason":"tests/25 cleanup"}' "${SUBMIT_URL}/${CREATED_ID}/cancel")"
  if [[ "${code}" == "200" && "$(json_get "${RESP}" stage)" == "failed" ]]; then
    CANCELLED=1
    log_success "4e 취소: HTTP 200, stage failed"
  else
    fail "4e 취소 기대 HTTP 200 stage failed, 실제 HTTP ${code} stage='$(json_get "${RESP}" stage)'"
  fi
  if command -v gh >/dev/null 2>&1; then
    pr_state="$(gh pr view "${PR_NUMBER}" --repo dasomel/beluga --json state --jq .state 2>/dev/null || true)"
    if [[ "${pr_state}" == "CLOSED" ]]; then
      log_success "4f GitHub PR #${PR_NUMBER}: CLOSED (머지 아님)"
    else
      fail "4f GitHub PR #${PR_NUMBER} 상태 기대 CLOSED, 실제 '${pr_state}'"
    fi
  else
    log_warn "4f SKIP: gh CLI 없음 — PR closed 를 GitHub에서 확인하지 못했다"
  fi
fi

if [[ "${FAILED}" -ne 0 ]]; then
  log_error "Test 25 (manager GitHub writer) FAILED"
  exit 1
fi
log_success "Test 25 (manager GitHub writer) passed"
