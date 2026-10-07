#!/usr/bin/env bash
# BELUGA_PROFILE 검증 계약 (이슈 #24 / environment-profiles P7): 클러스터 불필요.
# 사용: bash tests/18-profile-validation.sh [env.sh 경로] — 기본은 현재 scripts/common/env.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_SH="${1:-${ROOT}/scripts/common/env.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# env.sh가 BELUGA_ROOT/configs/cluster.env를 읽으므로 임시 트리에 복사 (cluster.env 없음 = 호스트 값 비의존)
mkdir -p "$TMP/scripts/common"
cp "$ENV_SH" "$TMP/scripts/common/env.sh"
FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }

# 환경을 비운 서브셸에서 source — 결과를 "rc|WORKER_MEMORY|ENABLE_OPENMETADATA|TRINO_WORKER_ENABLED"로 출력
probe() {
  # shellcheck disable=SC2016  # $0/$1은 bash -c 안에서 전개
  env -i PATH="$PATH" HOME="$HOME" BELUGA_PROFILE="$1" bash -c '
    set -e
    source "$0" 2>"$1"
    echo "ok|${WORKER_MEMORY}|${ENABLE_OPENMETADATA}|${TRINO_WORKER_ENABLED}"
  ' "$TMP/scripts/common/env.sh" "$TMP/stderr" 2>/dev/null || echo "rc=$?"
}

check_valid() { # profile worker_mem openmetadata
  local out; out="$(probe "$1")"
  [[ "$out" == "ok|$2|$3|$3" ]] || fail "profile $1: expected ok|$2|$3|$3, got '$out'"
}
check_invalid() {
  local out; out="$(probe "$1")"
  [[ "$out" == rc=* && "$out" != "rc=0" ]] || fail "profile '$1': expected non-zero exit, got '$out'"
  grep -q "32, 48, 64" "$TMP/stderr" || fail "profile '$1': stderr must name allowed values 32, 48, 64 ($(cat "$TMP/stderr"))"
}

check_valid 32 8192 false
check_valid 48 10240 true
check_valid 64 12288 true
for bad in 128 16 abc 032 "32 " 64GB -1; do check_invalid "$bad"; done

# BELUGA_PROFILE= (빈 값) = 미설정과 동일: 호스트 자동 감지, 성공해야 함
out="$(probe "")"
[[ "$out" == ok\|* ]] || fail "empty BELUGA_PROFILE must auto-detect and succeed, got '$out'"

if [[ "$FAILED" -ne 0 ]]; then exit 1; fi
echo "PASS: BELUGA_PROFILE validation ($ENV_SH)"
