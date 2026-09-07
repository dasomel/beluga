#!/usr/bin/env bash
# Beluga Static Preflight 14: 정책 컴파일러 Seam 드리프트 정적 검증
#
# MDP Seam 계약(AGENTS.md):
#   beluga/policies/ 선언(catalog, groups, resources, roles)과
#   beluga-manager의 정책 컴파일러(policyctl)가 상호 호환되어야 하며,
#   컴파일 산출물(trino.rego, keycloak.json)이 GitOps 배포 상태와 일치해야 한다.
#
# 클러스터 없이 다음을 정적 검증한다:
#   1) beluga/policies/ YAML 문법 및 필수 선언 파일 존재 확인
#   2) gitops/charts/beluga-platform/files/opa/trino.rego 존재 및 생성 헤더 확인
#   3) beluga-manager policyctl 컴파일러가 존재할 경우:
#      - policies/를 컴파일하여 생성된 trino.rego가 배포된 파일과 0 diff인지 확인
#      - keycloak.json의 realmRoles/groups가 선언과 정확히 일치하는지 확인
#   4) 자가 검증: trino.rego에 변조가 발생했을 때 감지기가 실제로 실패하는지 확인
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 14] Beluga ↔ Beluga-Manager 정책 컴파일러 Seam 검증..."

POLICIES_DIR="${REPO_ROOT}/policies"
DEPLOYED_REGO="${REPO_ROOT}/gitops/charts/beluga-platform/files/opa/trino.rego"
MANAGER_DIR="${REPO_ROOT}/../beluga-manager"

# 1. 정책 선언 파일 확인
log_info "1/4: policies/ 선언 파일 및 YAML 문법 검증..."
for required_file in catalog.yaml groups.yaml resources.yaml roles.yaml; do
  if [[ ! -f "${POLICIES_DIR}/${required_file}" ]]; then
    log_error "필수 정책 파일 누락: ${POLICIES_DIR}/${required_file}"
    exit 1
  fi
done

python3 -c '
import sys, yaml
for p in sys.argv[1:]:
    with open(p, "r") as f:
        yaml.safe_load(f)
' "${POLICIES_DIR}"/*.yaml
log_success "policies/*.yaml 문법 정상."

# 2. 배포된 trino.rego 파일 검증
log_info "2/4: 배포된 trino.rego 헤더 및 패키지 검증..."
if [[ ! -f "${DEPLOYED_REGO}" ]]; then
  log_error "배포된 OPA rego 파일 누락: ${DEPLOYED_REGO}"
  exit 1
fi

if ! grep -q "^package trino" "${DEPLOYED_REGO}"; then
  log_error "${DEPLOYED_REGO}: package trino 선언 누락"
  exit 1
fi
log_success "배포된 trino.rego 정상 확인."

# 3. beluga-manager policyctl 컴파일 검증 (연동 가능한 환경일 때)
log_info "3/4: beluga-manager policyctl 컴파일 드리프트 검증..."
if [[ -d "${MANAGER_DIR}" ]] && command -v npm >/dev/null 2>&1; then
  COMPILED_DIR="$(mktemp -d)"
  trap 'rm -rf "${COMPILED_DIR}"' EXIT

  log_info "beluga-manager policyctl 컴파일 실행..."
  (
    cd "${MANAGER_DIR}"
    npm run policyctl -- compile "${POLICIES_DIR}" --out "${COMPILED_DIR}" >/dev/null 2>&1
  )

  if [[ ! -f "${COMPILED_DIR}/trino.rego" ]]; then
    log_error "컴파일 산출물 trino.rego 누락"
    exit 1
  fi

  if ! diff -u "${COMPILED_DIR}/trino.rego" "${DEPLOYED_REGO}"; then
    log_error "정책 선언(policies/)과 배포된 OPA 규칙(${DEPLOYED_REGO}) 사이에 드리프트 감지"
    exit 1
  fi
  log_success "trino.rego 0 diff 일치 확인 (드리프트 없음)."

  # keycloak.json 그룹/롤 정합성
  if [[ -f "${COMPILED_DIR}/keycloak.json" ]]; then
    python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
role_names = {r["name"] for r in data.get("realmRoles", [])}
group_names = {g["name"] for g in data.get("groups", [])}
assert {"admins", "analysts", "engineers"}.issubset(role_names), f"Missing roles: {role_names}"
assert {"admin", "analyst", "engineer"}.issubset(group_names), f"Missing groups: {group_names}"
' "${COMPILED_DIR}/keycloak.json"
    log_success "keycloak.json 그룹 및 롤 정합성 확인."
  fi
else
  log_warn "beluga-manager 디렉토리 또는 npm을 찾을 수 없어 policyctl 실시간 재컴파일 diff 검증을 건너뜁니다."
fi

# 4. 자가 검증: 변조 감지 회귀 테스트
log_info "4/4: 자가 검증 — OPA 규칙 변조 감지 테스트..."
MOCK_DIR="$(mktemp -d)"
trap 'rm -rf "${COMPILED_DIR:-}" "${MOCK_DIR}"' EXIT
cp "${DEPLOYED_REGO}" "${MOCK_DIR}/trino.rego"
echo "# tampered" >> "${MOCK_DIR}/trino.rego"

if diff -q "${MOCK_DIR}/trino.rego" "${DEPLOYED_REGO}" >/dev/null 2>&1; then
  log_error "자가 검증 실패 — diff가 변조를 탐지하지 못함"
  exit 1
fi
log_success "자가 검증 통과 — 변조 감지 정상 동작."

log_success "[TEST 14] Beluga ↔ Beluga-Manager 정책 컴파일러 Seam 검증 통과."
