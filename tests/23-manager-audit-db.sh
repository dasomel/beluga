#!/usr/bin/env bash
# Beluga E2E Test 23: Manager 감사 DB(manager-db) 라이브 검증 (ADR-0009 롤아웃 ③, D-MSSO-11)
#
# 1) CNPG Cluster manager-db가 Healthy이고 마이그레이션 테이블/부분 유니크 인덱스가 있다.
# 2) manager_writer 권한: sso_change_event INSERT 성공, UPDATE/DELETE/TRUNCATE는 permission denied.
# 3) domain-api 헬스가 감사 저장소를 별도 컴포넌트로 ready 보고한다(게이트웨이 경유, 내부 CA로 TLS 검증).
# 쓰기 비밀번호는 Secret manager-db-writer에서 읽어 stdin으로만 파드에 전달한다(argv/출력 금지).
# 모든 writer 프로브는 BEGIN; ...; ROLLBACK;으로 감싸 영구 행을 남기지 않는다(권한 결함이 있어도 이력이 파괴되지 않는다).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"
NS=platform-system
DB_POD="manager-db-1"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

FAILED=0
fail() { log_error "$*"; FAILED=1; }

# psql_as <owner|writer> <sql>: 비밀번호는 첫 stdin 줄로 넘기고 파드 안에서 PGPASSWORD로 export한다.
psql_as() {
  local role="$1" sql="$2" pw
  pw="$(kubectl -n "${NS}" get secret "manager-db-${role}" -o jsonpath='{.data.password}' | base64 -d)"
  # shellcheck disable=SC2016 # $1은 파드 안의 sh가 전개한다
  printf '%s\n%s\n' "${pw}" "${sql}" | kubectl -n "${NS}" exec -i "${DB_POD}" -c postgres -- \
    sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U "$1" -d manager -v ON_ERROR_STOP=1 -tA' _ "manager_${role}" 2>&1
}

# 1) 클러스터/스키마
if [[ "$(kubectl -n "${NS}" get cluster manager-db -o jsonpath='{.status.phase}' 2>/dev/null)" == "Cluster in healthy state" ]]; then
  log_success "CNPG Cluster manager-db healthy"
else
  fail "CNPG Cluster manager-db is not in a healthy state"
fi

tables="$(psql_as owner "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';" || true)"
if [[ "${tables}" == *sso_change_event* && "${tables}" == *sso_change_requests* ]]; then
  log_success "tables present: ${tables}"
else
  fail "expected tables sso_change_event, sso_change_requests; got: ${tables}"
fi

idx="$(psql_as owner "SELECT indexdef FROM pg_indexes WHERE indexname='sso_change_requests_one_active_per_file';" || true)"
if [[ "${idx}" == *UNIQUE* && "${idx}" == *WHERE* ]]; then
  log_success "partial unique index sso_change_requests_one_active_per_file present"
else
  fail "partial unique index missing or not partial: ${idx}"
fi

# 2) writer 권한. 모든 프로브는 BEGIN; ...; ROLLBACK; 안에서 실행한다. psql은 ON_ERROR_STOP이라 거부된 문장에서
#    세션이 끝나 트랜잭션이 암묵적으로 롤백되고, 허용된(=권한 결함) 문장도 ROLLBACK으로 이력을 남기지 않는다.
probe_denied() {
  local label="$1" stmt="$2" out
  if out="$(psql_as writer "BEGIN; ${stmt} ROLLBACK;")" && [[ "${out}" != *"permission denied"* ]]; then
    fail "manager_writer unexpectedly allowed: ${label}"
  elif [[ "${out}" == *"permission denied"* ]]; then
    log_success "manager_writer ${label} denied (permission denied)"
  else
    fail "${label} failed for another reason: ${out}"
  fi
}

if out="$(psql_as writer "BEGIN; INSERT INTO sso_change_event (stage, actor_sub, reason, detail) VALUES ('denied', 'tests-23', 'tests/23 probe', '{\"test\":\"tests/23\"}'); ROLLBACK;")"; then
  log_success "manager_writer INSERT into sso_change_event ok (rolled back)"
else
  fail "manager_writer INSERT failed: ${out}"
fi

probe_denied "UPDATE" "UPDATE sso_change_event SET reason='x';"
probe_denied "DELETE" "DELETE FROM sso_change_event;"
probe_denied "TRUNCATE" "TRUNCATE sso_change_event;"
probe_denied "INSERT with explicit created_at" "INSERT INTO sso_change_event (stage, actor_sub, created_at) VALUES ('denied', 'tests-23', '2000-01-01');"
probe_denied "INSERT with OVERRIDING SYSTEM VALUE id" "INSERT INTO sso_change_event (id, stage, actor_sub) OVERRIDING SYSTEM VALUE VALUES (1, 'denied', 'tests-23');"
probe_denied "CREATE TEMP TABLE" "CREATE TEMP TABLE t23 (x int);"

# 3) domain-api 헬스가 감사 저장소를 별도 컴포넌트로 ready 보고한다(게이트웨이 경유, 내부 CA로 TLS 검증).
# 쓰기 비밀번호는 Secret manager-db-writer에서 읽어 stdin으로만 파드에 전달한다(argv/출력 금지).
# 모든 writer 프로브는 BEGIN; ...; ROLLBACK;으로 감싸 영구 행을 남기지 않는다(권한 결함이 있어도 이력이 파괴되지 않는다).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"
NS=platform-system
DB_POD="manager-db-1"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

FAILED=0
fail() { log_error "$*"; FAILED=1; }

# psql_as <owner|writer> <sql>: 비밀번호는 첫 stdin 줄로 넘기고 파드 안에서 PGPASSWORD로 export한다.
psql_as() {
  local role="$1" sql="$2" pw
  pw="$(kubectl -n "${NS}" get secret "manager-db-${role}" -o jsonpath='{.data.password}' | base64 -d)"
  # shellcheck disable=SC2016 # $1은 파드 안의 sh가 전개한다
  printf '%s\n%s\n' "${pw}" "${sql}" | kubectl -n "${NS}" exec -i "${DB_POD}" -c postgres -- \
    sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U "$1" -d manager -v ON_ERROR_STOP=1 -tA' _ "manager_${role}" 2>&1
}

# 1) 클러스터/스키마
if [[ "$(kubectl -n "${NS}" get cluster manager-db -o jsonpath='{.status.phase}' 2>/dev/null)" == "Cluster in healthy state" ]]; then
  log_success "CNPG Cluster manager-db healthy"
else
  fail "CNPG Cluster manager-db is not in a healthy state"
fi

tables="$(psql_as owner "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';" || true)"
if [[ "${tables}" == *sso_change_event* && "${tables}" == *sso_change_requests* ]]; then
  log_success "tables present: ${tables}"
else
  fail "expected tables sso_change_event, sso_change_requests; got: ${tables}"
fi

idx="$(psql_as owner "SELECT indexdef FROM pg_indexes WHERE indexname='sso_change_requests_one_active_per_file';" || true)"
if [[ "${idx}" == *UNIQUE* && "${idx}" == *WHERE* ]]; then
  log_success "partial unique index sso_change_requests_one_active_per_file present"
else
  fail "partial unique index missing or not partial: ${idx}"
fi

# 2) writer 권한
marker="tests/23-$(date +%s)"
if out="$(psql_as writer "INSERT INTO sso_change_event (stage, actor_sub, reason, detail) VALUES ('denied', 'tests-23', '${marker}', '{\"test\":\"tests/23\"}');")"; then
  log_success "manager_writer INSERT into sso_change_event ok"
else
  fail "manager_writer INSERT failed: ${out}"
fi

for stmt in \
  "UPDATE sso_change_event SET reason='x' WHERE reason='${marker}';" \
  "DELETE FROM sso_change_event WHERE reason='${marker}';" \
  "TRUNCATE sso_change_event;"; do
  if out="$(psql_as writer "${stmt}")"; then
    fail "manager_writer unexpectedly allowed: ${stmt%% *}"
  elif [[ "${out}" == *"permission denied"* ]]; then
    log_success "manager_writer ${stmt%% *} denied (permission denied)"
  else
    fail "${stmt%% *} failed for another reason: ${out}"
  fi
done

# 3) domain-api 헬스: 감사 저장소 컴포넌트가 ready
CA_CERT="${TMP_DIR}/ca.crt"
kubectl get secret beluga-internal-ca-secret -n cert-manager -o jsonpath='{.data.ca\.crt}' | base64 -d > "${CA_CERT}"
health="$(curl -sS --max-time 15 --cacert "${CA_CERT}" --resolve "manager.${BASE_DOMAIN}:443:${GATEWAY_IP}" \
  "https://manager.${BASE_DOMAIN}/api/v1/health" || true)"
if printf '%s' "${health}" | python3 -c '
import json, sys
ok = {"ok", "ready", "up", "healthy", True}
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if "audit" in k.lower():
                s = v.get("status", v.get("ready")) if isinstance(v, dict) else v
                return s in ok
            r = walk(v)
            if r is not None:
                return r
    return None
sys.exit(0 if walk(json.load(sys.stdin)) else 1)'; then
  log_success "domain-api health reports audit store ready"
else
  fail "domain-api health does not report the audit store as ready: ${health}"
fi

if [[ "${FAILED}" -ne 0 ]]; then
  log_error "Test 23 (manager audit DB) FAILED"
  exit 1
fi
log_success "Test 23 (manager audit DB) passed"
