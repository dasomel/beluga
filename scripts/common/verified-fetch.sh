#!/usr/bin/env bash
# #103: 업스트림 아티팩트를 configs/upstream-artifacts.sha256 에 고정된 SHA-256과 대조한 뒤에만
# 사용한다. 잠금 파일의 형식 오류·항목 누락·중복·해시 불일치·다운로드 실패는 모두 비-0으로
# 종료한다(fail-closed). 검증 전 내용은 dest와 같은 디렉터리의 임시 파일에만 두고, 검증을
# 통과한 뒤에만 mv로 dest에 올린다.

UPSTREAM_LOCK_FILE="${UPSTREAM_LOCK_FILE:-${BELUGA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/configs/upstream-artifacts.sha256}"
# 테스트 전용 탈출구(file:// 음성 fixture). 운영 경로는 항상 https만 허용한다.
VERIFIED_FETCH_PROTO="${VERIFIED_FETCH_PROTO:-=https}"

_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch_verified <url> <dest>
fetch_verified() {
  local url="$1" dest="$2" expected matches actual tmp
  # 비주석 줄은 정확히 "<64 hex> <https url>" 두 필드여야 한다 (Python load_lock과 동일 계약).
  if ! awk -v proto="${VERIFIED_FETCH_PROTO}" '/^[[:space:]]*(#|$)/ {next}
            NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || (proto == "=https" && $2 !~ /^https:\/\//) || ($2 in seen) {bad = 1}
            {seen[$2] = 1}
            END {exit bad}' "${UPSTREAM_LOCK_FILE}" 2>/dev/null; then
    echo "ERROR: lock file missing or malformed (fields/hash/https/duplicates): ${UPSTREAM_LOCK_FILE}" >&2; return 1
  fi
  matches="$(awk -v u="${url}" '$1 !~ /^#/ && $2 == u {print $1}' "${UPSTREAM_LOCK_FILE}")"
  if [[ -z "${matches}" ]]; then
    echo "ERROR: no pinned sha256 for ${url} in ${UPSTREAM_LOCK_FILE}" >&2; return 1
  fi
  expected="${matches}"
  tmp="$(mktemp "${dest}.XXXXXX")" || return 1
  if ! curl -fsSL --retry 3 --max-time 120 \
      --proto "${VERIFIED_FETCH_PROTO}" --proto-redir "${VERIFIED_FETCH_PROTO}" "${url}" -o "${tmp}"; then
    rm -f "${tmp}"; echo "ERROR: download failed: ${url}" >&2; return 1
  fi
  actual="$(_sha256_of "${tmp}")"
  if [[ "${actual}" != "${expected}" ]]; then
    rm -f "${tmp}"
    echo "ERROR: sha256 mismatch for ${url} (expected ${expected}, got ${actual})" >&2; return 1
  fi
  mv -f "${tmp}" "${dest}"
}
