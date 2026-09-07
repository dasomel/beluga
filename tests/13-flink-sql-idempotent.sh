#!/usr/bin/env bash
# Beluga Static Preflight 13: Flink SQL 제출 훅 멱등성 정적 검증 (이슈 #114)
#
# ArgoCD Sync 훅(flink-sql-submit Job)은 매 sync마다 재실행된다. jobs/overview
# 사전 체크로 동일 pipeline.name의 활성 잡을 건너뛰지 않으면, sync 재실행마다
# INSERT INTO가 새 스트리밍 잡으로 재제출되어 미관리 잡이 계속 쌓인다.
# 클러스터 접속 없이 helm template 렌더 결과와 SQL 파일만으로 다음을 검증한다:
#   1) flink-sql-submit Job이 렌더되고, 스크립트가 jobs/overview 사전 체크와
#      pipeline.name을 사용한다.
#   2) files/flink-sql/*.sql 각 파일이 정확히 하나의 INSERT INTO와, 파일명에서
#      유도된 pipeline.name SET 문을 갖는다.
#   3) 모든 pipeline.name이 서로 겹치지 않는다.
#   4) 위 INSERT INTO 카운터 자체가 회귀를 잡아내는지 자가 검증(음성 대조)한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 13] Flink SQL 제출 훅 멱등성 정적 preflight..."

DATA_RENDER="$(mktemp)"
trap 'rm -f "${DATA_RENDER}"' EXIT

log_info "1/4: helm template 렌더 (beluga-data)..."
helm template "${REPO_ROOT}/gitops/charts/beluga-data" > "${DATA_RENDER}"
log_success "렌더 완료."

log_info "2/4: flink-sql-submit Job의 jobs/overview 사전 체크와 pipeline.name 사용 확인..."
if ! grep -q "name: flink-sql-submit" "${DATA_RENDER}"; then
  log_error "flink-sql-submit Job이 렌더 결과에 없음 (flink.sqlJobsEnabled 확인 필요)"
  exit 1
fi
if ! grep -q "jobs/overview" "${DATA_RENDER}"; then
  log_error "flink-sql-submit Job 스크립트에 jobs/overview 사전 체크가 없음"
  exit 1
fi
if ! grep -q "pipeline.name" "${DATA_RENDER}"; then
  log_error "flink-sql-submit Job 스크립트에 pipeline.name 사용이 없음"
  exit 1
fi
log_success "jobs/overview 사전 체크와 pipeline.name 사용 확인."

# 대소문자/들여쓰기와 무관하게 INSERT INTO를 세되, 문장 시작 토큰만 카운트한다
# (SELECT 서브쿼리 등에 우연히 섞인 "insert into" 문자열을 오탐하지 않도록).
count_inserts() {
  grep -ciE '^[[:space:]]*INSERT[[:space:]]+INTO' "$1" || true
}

log_info "3/4: SQL 파일별 INSERT INTO 단일성, pipeline.name 매칭, 전역 유일성 검증..."
SQL_DIR="${REPO_ROOT}/gitops/charts/beluga-data/files/flink-sql"
ALL_NAMES=""
for f in "${SQL_DIR}"/*.sql; do
  base="$(basename "${f}" .sql)"
  expected="beluga-${base}"

  insert_count=$(count_inserts "${f}")
  if [[ "${insert_count}" -ne 1 ]]; then
    log_error "${f}: INSERT INTO 개수가 1이 아님 (${insert_count})"
    exit 1
  fi

  if ! grep -qF "SET 'pipeline.name' = '${expected}';" "${f}"; then
    log_error "${f}: 파일명과 일치하는 pipeline.name SET 문이 없음 (기대: ${expected})"
    exit 1
  fi

  ALL_NAMES="${ALL_NAMES}${expected}"$'\n'
done

DUP="$(printf '%s' "${ALL_NAMES}" | sort | uniq -d || true)"
if [[ -n "${DUP}" ]]; then
  log_error "pipeline.name 중복 발견: ${DUP}"
  exit 1
fi
log_success "SQL 파일별 INSERT INTO 단일성, pipeline.name 매칭, 전역 유일성 확인."

log_info "4/4: 자가 검증 — INSERT INTO 카운터가 중복 삽입 회귀를 실제로 잡아내는지 확인..."
SELF_CHECK_SRC="${SQL_DIR}/events_sessionization.sql"
SELF_CHECK_TMP="$(mktemp)"
trap 'rm -f "${DATA_RENDER}" "${SELF_CHECK_TMP}"' EXIT
cp "${SELF_CHECK_SRC}" "${SELF_CHECK_TMP}"
# 들여쓰기된 소문자 insert into를 주입 — 대소문자/들여쓰기 무관 매칭을 함께 검증한다.
printf '  insert into dummy_table select 1;\n' >> "${SELF_CHECK_TMP}"
INJECTED_COUNT=$(count_inserts "${SELF_CHECK_TMP}")
rm -f "${SELF_CHECK_TMP}"
if [[ "${INJECTED_COUNT}" -ne 2 ]]; then
  log_error "자가 검증 실패: 중복 INSERT INTO 주입 후에도 카운터가 2를 반환하지 않음 (실제: ${INJECTED_COUNT}) — 회귀 탐지 로직 자체가 깨져 있음"
  exit 1
fi
log_success "자가 검증 통과 — 회귀 탐지 로직이 중복 INSERT INTO를 실제로 잡아냄."

log_success "[TEST 13] Flink SQL 제출 훅 멱등성 정적 preflight 통과."
