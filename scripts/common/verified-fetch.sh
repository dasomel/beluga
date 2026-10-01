#!/usr/bin/env bash
# #103: 업스트림 아티팩트를 configs/upstream-artifacts.sha256 에 고정된 SHA-256과 대조한 뒤에만
# 사용한다. 잠금 항목 누락·중복·해시 불일치·다운로드 실패는 모두 비-0으로 종료한다(fail-closed).
# 검증 전 내용은 stdout/파이프로 흘리지 않고 임시 파일에만 둔다.

UPSTREAM_LOCK_FILE="${UPSTREAM_LOCK_FILE:-${BELUGA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/configs/upstream-artifacts.sha256}"

_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch_verified <url> <dest>
fetch_verified() {
  local url="$1" dest="$2" expected matches actual
  matches="$(awk -v u="${url}" '$1 !~ /^#/ && $2 == u {print $1}' "${UPSTREAM_LOCK_FILE}" 2>/dev/null)"
  if [[ -z "${matches}" ]]; then
    echo "ERROR: no pinned sha256 for ${url} in ${UPSTREAM_LOCK_FILE}" >&2; return 1
  fi
  if [[ "$(printf '%s\n' "${matches}" | wc -l)" -ne 1 ]]; then
    echo "ERROR: duplicate pinned sha256 entries for ${url}" >&2; return 1
  fi
  expected="${matches}"
  if [[ ! "${expected}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: malformed sha256 for ${url}" >&2; return 1
  fi
  if ! curl -sfL --max-time 120 "${url}" -o "${dest}"; then
    rm -f "${dest}"; echo "ERROR: download failed: ${url}" >&2; return 1
  fi
  actual="$(_sha256_of "${dest}")"
  if [[ "${actual}" != "${expected}" ]]; then
    rm -f "${dest}"
    echo "ERROR: sha256 mismatch for ${url} (expected ${expected}, got ${actual})" >&2; return 1
  fi
}
