#!/usr/bin/env bash
# Beluga Static Preflight 11: SSO/identity 경계 평문 엔드포인트 노출 정적 검증 (이슈 #2, 인수기준 6)
#
# 클러스터 접속 없이 `helm template` 렌더 결과만으로 프로덕션 매니페스트가 평문 identity
# 엔드포인트를 노출하지 않는지 검증한다. 검출 대상:
#   1) http://sso. 참조 (실 설정값 — 주석 속 역사적 서술은 제외)
#   2) Keycloak→OpenLDAP federation 등에서 쓰는 ldap:// (connectionUrl은 ldaps://여야 함)
#   3) Keycloak --hostname=http://
#   4) Trino oauth2.issuer=http://
#   5) TLS 검증 우회 패턴 (verify=False, insecure-skip-tls-verify, InsecureSkipVerify, ssl_verify: false)
#   6) trino://…:8080 형태의 평문 서비스 연결(이슈 #110) — Task 16 이후 Trino coordinator는
#      oauth2,PASSWORD 전용이라 8080/무자격 연결은 즉시 거부되므로, 이 패턴이 남아 있으면
#      곧바로 실배포 실패로 이어진다.
#
# 알려진 예외(ALLOWLIST)는 아래 PYEOF 블록 상단에 사유·이슈 번호와 함께 문서화한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 11] SSO/identity 경계 평문 엔드포인트 정적 preflight..."

PLATFORM_RENDER="$(mktemp)"
DATA_RENDER="$(mktemp)"
trap 'rm -f "${PLATFORM_RENDER}" "${DATA_RENDER}"' EXIT

log_info "1/2: helm template 렌더 (beluga-platform, beluga-data)..."
helm template "${REPO_ROOT}/gitops/charts/beluga-platform" > "${PLATFORM_RENDER}"
helm template "${REPO_ROOT}/gitops/charts/beluga-data" > "${DATA_RENDER}"
log_success "렌더 완료."

log_info "2/2: 평문 identity 엔드포인트 패턴 검사..."
python3 - "${PLATFORM_RENDER}" "beluga-platform" "${DATA_RENDER}" "beluga-data" <<'PYEOF'
import re
import sys

# ALLOWLIST — 클러스터 내부 경계(파드/ClusterIP) 안쪽이며 별도 이슈로 추적 중인
# 알려진 평문 사용. 신규 예외를 추가할 때는 반드시 사유와 이슈 번호를 남긴다.
LDAP_ALLOWLIST_SOURCE_SUFFIXES = (
    # Trino 자체 LDAP group provider(group-provider.properties, ldap.allow-insecure=true) —
    # 이슈 #106에서 별도 추적. Trino↔OpenLDAP는 같은 클러스터 내부 통신.
    "06-trino.yaml",
    # OpenLDAP in-pod 헬스체크(localhost:389)와 초기화 Job의 ldapsearch/ldapadd —
    # 같은 iam 네임스페이스 ClusterIP 경계 내부 호출이라 외부 노출이 아니다.
    "openldap.yaml",
)

RULES = [
    ("plaintext-sso-http", re.compile(r"http://sso\."), None),
    ("keycloak-ldap-plaintext", re.compile(r"ldap://"), LDAP_ALLOWLIST_SOURCE_SUFFIXES),
    ("keycloak-hostname-http", re.compile(r"--hostname=http://"), None),
    ("trino-oauth2-issuer-http", re.compile(r"oauth2\.issuer=http://"), None),
    # 이슈 #110: trino://user@host:8080 형태의 평문 서비스 연결 회귀 방지.
    ("trino-plaintext-service-uri", re.compile(r"trino://[^@\s]+@[^/\s]*:8080\b"), None),
    ("tls-verify-bypass", re.compile(
        r"verify\s*=\s*False|insecure-skip-tls-verify|InsecureSkipVerify|ssl_verify:\s*false",
        re.IGNORECASE), None),
]


def scan(path, chart_label):
    offenses = []
    current_source = "(unknown)"
    current_kind = "(unknown)"
    with open(path, encoding="utf-8") as f:
        for lineno, raw_line in enumerate(f, start=1):
            stripped = raw_line.strip()
            src_match = re.match(r"#\s*Source:\s*(\S+)", stripped)
            if src_match:
                current_source = src_match.group(1)
                continue
            kind_match = re.match(r"kind:\s*(\S+)", stripped)
            if kind_match:
                current_kind = kind_match.group(1)

            for rule_name, pattern, allow_suffixes in RULES:
                if not pattern.search(raw_line):
                    continue
                # 주석 속 역사적 서술(예전엔 이 값이 http였다는 설명 등)은 실 설정이 아니므로 제외
                if rule_name == "plaintext-sso-http" and stripped.startswith("#"):
                    continue
                if allow_suffixes and current_source.endswith(allow_suffixes):
                    continue
                offenses.append((chart_label, current_source, current_kind, lineno, rule_name, stripped))
    return offenses


args = sys.argv[1:]
all_offenses = []
for i in range(0, len(args), 2):
    render_path, chart_label = args[i], args[i + 1]
    all_offenses.extend(scan(render_path, chart_label))

if all_offenses:
    print("평문 identity 엔드포인트 노출 발견:", file=sys.stderr)
    for chart, source, kind, lineno, rule, text in all_offenses:
        print(f"  [{rule}] {chart}/{source} (kind={kind}) line {lineno}: {text}", file=sys.stderr)
    sys.exit(1)

print("평문 identity 엔드포인트 노출 없음 — 정적 preflight 통과.")
sys.exit(0)
PYEOF

log_success "[TEST 11] SSO/identity 경계 평문 엔드포인트 정적 preflight 통과."
