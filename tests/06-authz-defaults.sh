#!/usr/bin/env bash
# §10.1 "기본은 거부" 회귀 검증 — 신규 테이블에 analyst가 자동 SELECT를 받으면 실패
#
# ALTER DEFAULT PRIVILEGES는 "그 명령을 실행한 롤"이 이후 생성하는 오브젝트에만 적용된다
# (pg_default_acl.defaclrole=beluga_admin, 실측 확인). 신규 테이블(CDC 미러·customers_v2 등)은
# 실제로 DB 소유자 서비스 계정 beluga_admin이 생성하므로, 재현도 beluga_admin으로 해야 한다.
# postgres 슈퍼유저로 테이블을 만들면 이 결함이 재현되지 않는다(로컬 소켓은 pg_ident상
# postgres 롤만 peer 인증되므로 beluga_admin은 TCP + 비밀번호로 접속한다).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

log_info "[TEST 06] 기본 권한(ALTER DEFAULT PRIVILEGES) 회귀 검증..."

BELUGA_ADMIN_PW=$(kubectl -n beluga-data get secret postgres-admin-credential -o jsonpath='{.data.password}' | base64 -d)
PSQL=(kubectl -n beluga-data exec postgres-main-1 -c postgres -- env "PGPASSWORD=${BELUGA_ADMIN_PW}" psql -h 127.0.0.1 -U beluga_admin -d shop -tAc)

"${PSQL[@]}" "CREATE TABLE IF NOT EXISTS authz_probe (id int);" >/dev/null
GRANTED=$("${PSQL[@]}" "SELECT has_table_privilege('beluga_analyst','authz_probe','SELECT');")
"${PSQL[@]}" "DROP TABLE authz_probe;" >/dev/null

if [[ "${GRANTED}" == "t" ]]; then
  log_error "신규 테이블에 analyst SELECT가 자동 부여됨 — §10.1 위반"
  exit 1
fi
log_success "[TEST 06] 신규 테이블은 기본 거부 상태."
