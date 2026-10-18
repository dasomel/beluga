#!/usr/bin/env bash
# Beluga E2E Test 24: Manager SSO 변경 요청(미리보기/제출) 라이브 검증 (ADR-0009 롤아웃 ③, D-MSSO-7/8/9/11)
#
# 1) 토큰 없음 401, analyst(비 admins) 미리보기 403
# 2) admin 미리보기(dryRun=true): flink allowedGroups = 현재 + analysts -> 200, diff는 allowedGroups만 건드림,
#    baseBlobSha(40 hex)/sourceCommitSha
# 3) 변경 없음(순서만 바뀐 것 포함)/admins 누락/미지의 그룹/편집 불가 엔드포인트 -> 422
# 4) 제출(Idempotency-Key + baseBlobSha) -> 503 GIT_WRITER_UNCONFIGURED(롤아웃 3은 운영 writer 없음), DB에는
#    sso_change_requests 행이 없고 sso_change_event에 2)의 'previewed' 행이 있다
# 5) --with-db-outage만: CNPG 최대 절전(cnpg.io/hibernation=on)으로 manager-db를 내리면 미리보기 503 AUDIT_UNAVAILABLE,
#    GET /api/v1/sso는 200. 어떤 경우에도 trap으로 복구하고 Cluster healthy + 헬스 auditStore ok까지 대기한다.
# 이 테스트는 GitHub 쓰기와 sso.yaml 변경을 하지 않는다(미리보기 + 거부되는 제출뿐). 미리보기는 감사 행(previewed)을 남긴다.
# 비밀번호/토큰은 0600 임시파일로만 다루고 출력하지 않는다. 라우팅은 BELUGA_GATEWAY_IP로 curl --resolve 한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"
NS=platform-system
DB_CLUSTER="manager-db"
DB_POD="manager-db-1"
HOST="manager.${BASE_DOMAIN}"
API="https://${HOST}/api/v1"
WAIT_POD_GONE_S=300
WAIT_RESTORE_S=420

WITH_DB_OUTAGE=0
for arg in "$@"; do
  case "${arg}" in
    --with-db-outage) WITH_DB_OUTAGE=1 ;;
    *) echo "usage: $0 [--with-db-outage]" >&2; exit 2 ;;
  esac
done

TMP_DIR="$(mktemp -d)"
HIBERNATED=0
restore_db() {
  if [[ "${HIBERNATED}" == "1" ]]; then
    log_warn "trap: manager-db 최대 절전 해제(복구)..."
    kubectl -n "${NS}" annotate cluster "${DB_CLUSTER}" cnpg.io/hibernation- >/dev/null 2>&1 || true
  fi
}
trap 'restore_db; rm -rf "${TMP_DIR}"' EXIT
# INT/TERM은 exit 130으로 돌려 EXIT trap(복구)이 반드시 돈다. SIGKILL은 trap으로 잡을 수 없다:
# 그 경우 수동 복구: kubectl annotate cluster manager-db -n platform-system cnpg.io/hibernation-
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

# post_body <file> <endpoint> <group...>: 요청 본문 JSON을 만든다(baseBlobSha는 BASE_BLOB가 있을 때만)
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

psql_owner() {
  local pw
  pw="$(kubectl -n "${NS}" get secret manager-db-owner -o jsonpath='{.data.password}' | base64 -d)"
  # shellcheck disable=SC2016 # $1은 파드 안의 sh가 전개한다
  printf '%s\n%s\n' "${pw}" "$1" | kubectl -n "${NS}" exec -i "${DB_POD}" -c postgres -- \
    sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U manager_owner -d manager -v ON_ERROR_STOP=1 -tA' 2>&1
}

audit_store_state() {
  run_curl "${API}/health" 2>/dev/null | python3 -c '
import json, sys
try:
    a = json.load(sys.stdin)["components"]["auditStore"]
    print(a.get("status", a.get("state", "")) if isinstance(a, dict) else a)
except Exception:
    print("")
'
}

log_info "=========================================================="
log_info " [TEST 24] Manager SSO change preview/submit (ADR-0009 ③)"
log_info " Manager: ${HOST} (gateway ${GATEWAY_IP}), outage test: ${WITH_DB_OUTAGE}"
log_info "=========================================================="

ADMIN_HDR="${TMP_DIR}/admin.hdr"
ANALYST_HDR="${TMP_DIR}/analyst.hdr"
login_bearer beluga-admin admin "${ADMIN_HDR}" || { log_error "admin 로그인 실패, 중단"; exit 1; }
login_bearer beluga-analyst analyst "${ANALYST_HDR}" || { log_error "analyst 로그인 실패, 중단"; exit 1; }

# 현재 flink allowedGroups (GET /api/v1/sso)
SSO_JSON="${TMP_DIR}/sso.json"
code="$(api "${SSO_JSON}" -H "@${ADMIN_HDR}" "${API}/sso")"
CURRENT="$(F="${SSO_JSON}" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["F"]))
    print(" ".join(g for e in d["config"]["endpoints"] if e["name"] == "flink" for g in e["allowedGroups"]))
except Exception:
    print("")
')"
if [[ "${code}" != "200" || -z "${CURRENT}" ]]; then
  log_error "GET /api/v1/sso 실패 또는 flink allowedGroups 없음 (HTTP ${code})"
  exit 1
fi
log_info "현재 flink allowedGroups: ${CURRENT}"
if [[ " ${CURRENT} " == *" analysts "* ]]; then
  log_error "flink allowedGroups에 이미 analysts가 있어 테스트 전제가 깨졌다 (변경 없음 422가 됨)"
  exit 1
fi
# shellcheck disable=SC2206 # 그룹 이름은 [a-z0-9-]+라 단어 분리가 안전하다
CUR_GROUPS=(${CURRENT})

PREVIEW_Q="${API}/sso/change-requests?dryRun=true"
BODY="${TMP_DIR}/body.json"
RESP="${TMP_DIR}/resp.json"
JSON_H=(-H "Content-Type: application/json")

# 1) 인증/인가
post_body "${BODY}" flink "${CUR_GROUPS[@]}" analysts
code="$(api "${RESP}" -X POST "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "1a 토큰 없는 미리보기" 401 - "${RESP}" "${code}"
code="$(api "${RESP}" -X POST -H "@${ANALYST_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "1b analyst 미리보기" 403 FORBIDDEN "${RESP}" "${code}"

# 2) admin 미리보기
PREVIEW_START="$(date +%s)"
PREVIEW_JSON="${TMP_DIR}/preview.json"
code="$(api "${PREVIEW_JSON}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
BASE_BLOB="$(json_get "${PREVIEW_JSON}" baseBlobSha)"
SOURCE_COMMIT="$(json_get "${PREVIEW_JSON}" sourceCommitSha)"
if [[ "${code}" == "200" ]] && PJ="${PREVIEW_JSON}" python3 -c '
import json, os, re, sys
d = json.load(open(os.environ["PJ"]))
assert d["endpoint"] == "flink"
assert re.fullmatch(r"[0-9a-f]{40}", d["baseBlobSha"]) and re.fullmatch(r"[0-9a-f]{40}", d["sourceCommitSha"])
assert "analysts" in d["after"] and set(d["after"]) - {"analysts"} == set(d["before"] or [])
# diff는 flink allowedGroups 블록만 건드린다: 변경 줄은 모두 그룹 목록 항목이고, 직전 비-항목 줄(앵커)이 allowedGroups:여야 하며
# (컨텍스트 3줄에 name이 보이면 flink여야 한다), 변경은 정확히 +analysts 한 줄이다. 헤더(---/+++/@@ 앞)와 빈 줄/백슬래시 줄은 건너뛴다.
# 다른 엔드포인트가 수정되지 않는다는 보장은 서버(editEngine: 두 문서의 유일한 차이=한 엔드포인트의 allowedGroups)에 있다.
lines = d["diff"].splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("@@"))
anchor, changes = None, []
for l in lines[start:]:
    if l.startswith("@@"):
        anchor = None
        continue
    if l == "" or l.startswith("\\"):
        continue
    tag, text = l[0], l[1:]
    m = re.match(r"\s*-\s+name:\s*[\"\x27]?([^\"\x27\s]+)", text)
    if m:
        assert m.group(1) == "flink", l
    is_item = re.fullmatch(r"\s*-\s+\S.*", text) is not None
    if tag in "+-":
        assert is_item and anchor == "allowedGroups:", l
        changes.append(l)
    elif not is_item:
        anchor = text.strip()
assert len(changes) == 1 and re.fullmatch(r"\+\s*-\s+[\"\x27]?analysts[\"\x27]?", changes[0]), changes
'; then
  log_success "2 admin 미리보기: HTTP 200, diff는 flink allowedGroups(+analysts)만, baseBlobSha/sourceCommitSha 40 hex"
else
  fail "2 admin 미리보기 검증 실패: HTTP ${code}"
fi

# 3) 거부 케이스 (모두 422)
post_body "${BODY}" flink "${CUR_GROUPS[@]}"
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3a 변경 없음" 422 NO_EFFECTIVE_CHANGE "${RESP}" "${code}"
REVERSED=()
for ((i = ${#CUR_GROUPS[@]} - 1; i >= 0; i--)); do REVERSED+=("${CUR_GROUPS[i]}"); done
post_body "${BODY}" flink "${REVERSED[@]}"
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3b 순서만 바뀜(역순)" 422 NO_EFFECTIVE_CHANGE "${RESP}" "${code}"
post_body "${BODY}" flink analysts
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3c admins 누락" 422 PATCH_REJECTED "${RESP}" "${code}"
post_body "${BODY}" flink "${CUR_GROUPS[@]}" no-such-group
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3d 미지의 그룹" 422 PATCH_REJECTED "${RESP}" "${code}"
post_body "${BODY}" trino admins analysts
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3e 편집 불가 엔드포인트(trino)" 422 PATCH_REJECTED "${RESP}" "${code}"
post_body "${BODY}" catalog-ui admins analysts
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
expect "3f 편집 불가 엔드포인트(catalog-ui)" 422 PATCH_REJECTED "${RESP}" "${code}"

# 4) 제출: 운영 writer 없음 -> 503, DB에 요청 행 없음, previewed 이벤트는 있음
IDEM_KEY="$(openssl rand -hex 16)"
post_body "${BODY}" flink "${CUR_GROUPS[@]}" analysts
code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" -H "Idempotency-Key: ${IDEM_KEY}" --data-binary "@${BODY}" "${API}/sso/change-requests")"
expect "4a 제출(Idempotency-Key + baseBlobSha)" 503 GIT_WRITER_UNCONFIGURED "${RESP}" "${code}"

n_req="$(psql_owner "SELECT count(*) FROM sso_change_requests WHERE idempotency_key='${IDEM_KEY}';" || true)"
n_evt_key="$(psql_owner "SELECT count(*) FROM sso_change_event WHERE idempotency_key='${IDEM_KEY}';" || true)"
if [[ "${n_req}" == "0" && "${n_evt_key}" == "0" ]]; then
  log_success "4b 거부된 제출은 DB 행을 남기지 않음 (sso_change_requests 0, 해당 키의 sso_change_event 0)"
else
  fail "4b 제출 키의 행이 존재하거나 조회 실패: requests=${n_req}, events=${n_evt_key}"
fi
# BASE_BLOB는 SQL에 보간되므로 40 hex를 먼저 검증한다. created_at은 2)의 미리보기 시작 이후 행만(호스트-DB 시계 오차 5s 허용).
n_prev=""
if [[ "${BASE_BLOB}" =~ ^[0-9a-f]{40}$ ]]; then
  n_prev="$(psql_owner "SELECT count(*) FROM sso_change_event WHERE stage='previewed' AND actor_username='beluga-admin' AND endpoint='flink' AND base_blob_sha='${BASE_BLOB}' AND created_at >= to_timestamp($((PREVIEW_START - 5)));" || true)"
fi
if [[ "${n_prev}" =~ ^[0-9]+$ && "${n_prev}" -ge 1 ]]; then
  log_success "4c sso_change_event에 2)의 previewed 행 존재 (actor beluga-admin, flink, base_blob_sha 일치, ${n_prev}건)"
else
  fail "4c previewed 감사 행 없음 (기대 >=1, 실제 '${n_prev}')"
fi
log_info "미리보기 시작 이후 경과: $(($(date +%s) - PREVIEW_START))s, sourceCommitSha=${SOURCE_COMMIT:0:12}"

# 5) DB 장애 (옵션)
if [[ "${WITH_DB_OUTAGE}" == "1" ]]; then
  # 이미 최대 절전이면 건드리지 않고 중단한다(trap이 이 실행이 걸지 않은 절전을 풀지 않도록 HIBERNATED는 아직 0).
  pre_hib="$(kubectl -n "${NS}" get cluster "${DB_CLUSTER}" -o jsonpath='{.metadata.annotations.cnpg\.io/hibernation}' 2>/dev/null || true)"
  pre_pods="$(kubectl -n "${NS}" get pods -l "cnpg.io/cluster=${DB_CLUSTER}" -o name 2>/dev/null || true)"
  if [[ -n "${pre_hib}" || -z "${pre_pods}" ]]; then
    log_error "5 사전 조건 실패: manager-db가 이미 최대 절전(annotation='${pre_hib}')이거나 파드가 없다. 건드리지 않고 중단"
    exit 1
  fi
  log_info "5 DB 장애: manager-db 최대 절전(cnpg.io/hibernation=on)..."
  OLD_UID="$(kubectl -n "${NS}" get pod "${DB_POD}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
  T0="$(date +%s)"
  HIBERNATED=1
  kubectl -n "${NS}" annotate cluster "${DB_CLUSTER}" cnpg.io/hibernation=on --overwrite >/dev/null
  gone=0
  while (($(date +%s) - T0 < WAIT_POD_GONE_S)); do
    # kubectl 실패(API 오류)는 "사라짐"이 아니다: 종료 코드 0이고 결과가 비어 있을 때만 인정한다.
    if pods_now="$(kubectl -n "${NS}" get pods -l "cnpg.io/cluster=${DB_CLUSTER}" -o name 2>/dev/null)" && [[ -z "${pods_now}" ]]; then gone=1; break; fi
    sleep 3
  done
  T_GONE=$(($(date +%s) - T0))
  if [[ "${gone}" == "1" ]]; then
    log_success "5a manager-db 파드 사라짐 (${T_GONE}s)"
    post_body "${BODY}" flink "${CUR_GROUPS[@]}" analysts
    code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
    expect "5b DB 다운 중 admin 미리보기" 503 AUDIT_UNAVAILABLE "${RESP}" "${code}"
    code="$(api "${RESP}" -H "@${ADMIN_HDR}" "${API}/sso")"
    if [[ "${code}" == "200" ]]; then
      log_success "5c DB 다운 중 GET /api/v1/sso HTTP 200 (읽기 경로 유지)"
    else
      fail "5c DB 다운 중 GET /api/v1/sso 기대 200, 실제 ${code}"
    fi
  else
    fail "5a manager-db 파드가 ${WAIT_POD_GONE_S}s 안에 사라지지 않음"
  fi

  # 복구 (성공/실패와 무관하게 항상 수행; trap은 예외 종료 대비 안전망)
  log_info "5d 복구: 최대 절전 해제..."
  T1="$(date +%s)"
  kubectl -n "${NS}" annotate cluster "${DB_CLUSTER}" cnpg.io/hibernation- >/dev/null
  HIBERNATED=0
  # 헬스 필드/Cluster phase는 최대 절전 중에도 직전 값(healthy/ok)을 유지하므로, 새 파드(UID 변경)가 Ready가 된 뒤에만 신뢰한다.
  healthy=0
  while (($(date +%s) - T1 < WAIT_RESTORE_S)); do
    new_uid="$(kubectl -n "${NS}" get pod "${DB_POD}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
    ready="$(kubectl -n "${NS}" get pod "${DB_POD}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    phase="$(kubectl -n "${NS}" get cluster "${DB_CLUSTER}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [[ -n "${new_uid}" && "${new_uid}" != "${OLD_UID}" && "${ready}" == "True" && "${phase}" == "Cluster in healthy state" ]]; then healthy=1; break; fi
    sleep 5
  done
  T_HEALTHY=$(($(date +%s) - T1))
  audit_ok=0
  if [[ "${healthy}" == "1" ]]; then
    while (($(date +%s) - T1 < WAIT_RESTORE_S)); do
      if [[ "$(audit_store_state)" == "ok" ]]; then audit_ok=1; break; fi
      sleep 3
    done
  fi
  T_AUDIT=$(($(date +%s) - T1))
  if [[ "${healthy}" == "1" && "${audit_ok}" == "1" ]]; then
    log_success "5d 복구 완료: Cluster healthy ${T_HEALTHY}s, auditStore ok ${T_AUDIT}s (파드 소멸 ${T_GONE}s)"
    post_body "${BODY}" flink "${CUR_GROUPS[@]}" analysts
    code="$(api "${RESP}" -X POST -H "@${ADMIN_HDR}" "${JSON_H[@]}" --data-binary "@${BODY}" "${PREVIEW_Q}")"
    expect "5e 복구 후 admin 미리보기" 200 - "${RESP}" "${code}"
  else
    fail "5d 복구 실패: healthy=${healthy} (${T_HEALTHY}s), auditStore ok=${audit_ok} (${T_AUDIT}s)"
  fi
fi

if [[ "${FAILED}" -ne 0 ]]; then
  log_error "Test 24 (manager SSO change) FAILED"
  exit 1
fi
log_success "Test 24 (manager SSO change) passed"
