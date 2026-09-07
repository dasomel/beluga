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
LDAP_MANIFEST="${REPO_ROOT}/gitops/charts/beluga-platform/templates/openldap.yaml"

# 정책/컴파일러/LDAP의 그룹 이름은 단일 원천이어야 한다. OpenLDAP는 이미지 초기 시드와
# 재배포 시 수렴시키는 init Job이라는 두 실제 CN 소스를 가지므로 둘 다 읽는다.
verify_keycloak_group_seam() {
  local keycloak_spec="$1"

  python3 - "${keycloak_spec}" "${POLICIES_DIR}/groups.yaml" "${POLICIES_DIR}/roles.yaml" "${LDAP_MANIFEST}" <<'PY'
import json
import re
import sys

import yaml


GROUP_DN = re.compile(r"^cn=([^,]+),ou=groups,dc=beluga,dc=internal$", re.IGNORECASE)
INIT_GROUP = re.compile(
    r'''add_if_missing\s+"cn=([^,"]+),ou=groups,\$BASE_DN"\s+"dn:\s*cn=([^,]+),ou=groups,\$BASE_DN
\s*objectClass:\s*groupOfNames
\s*cn:\s*([^\s"]+)''',
    re.IGNORECASE,
)


def group_cns_from_seed_ldif(manifest):
    with open(manifest, encoding="utf-8") as source:
        documents = list(yaml.safe_load_all(source))
    config_maps = [
        document for document in documents
        if document and document.get("kind") == "ConfigMap"
        and document.get("metadata", {}).get("name") == "openldap-seed-ldifs"
    ]
    if len(config_maps) != 1:
        raise ValueError("expected exactly one openldap-seed-ldifs ConfigMap")

    groups = set()
    for ldif in config_maps[0].get("data", {}).values():
        for entry in re.split(r"\n\s*\n", ldif.strip()):
            attributes = {}
            for line in entry.splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    attributes.setdefault(key.lower(), []).append(value.strip())
            dn = attributes.get("dn", [None])[0]
            match = GROUP_DN.fullmatch(dn or "")
            if match and "groupofnames" in {value.lower() for value in attributes.get("objectclass", [])}:
                cn = match.group(1)
                if attributes.get("cn") != [cn]:
                    raise ValueError(f"seed LDIF group CN does not match DN: {dn}")
                groups.add(cn)
    if not groups:
        raise ValueError("no groupOfNames CNs found in openldap seed LDIF")
    return groups, documents


def group_cns_from_init_job(documents):
    jobs = [
        document for document in documents
        if document and document.get("kind") == "Job"
        and document.get("metadata", {}).get("name") == "openldap-init"
    ]
    if len(jobs) != 1:
        raise ValueError("expected exactly one openldap-init Job")
    containers = jobs[0]["spec"]["template"]["spec"]["containers"]
    container = next((item for item in containers if item.get("name") == "openldap-init"), None)
    if container is None:
        raise ValueError("openldap-init container not found")
    command = container.get("command", [])
    scripts = [command[index + 1] for index, value in enumerate(command[:-1]) if value == "-c"]
    if len(scripts) != 1:
        raise ValueError("openldap-init must contain exactly one shell script")

    groups = set()
    for dn_cn, ldif_dn_cn, attribute_cn in INIT_GROUP.findall(scripts[0]):
        if len({dn_cn, ldif_dn_cn, attribute_cn}) != 1:
            raise ValueError(f"init Job group CN does not match DN: {dn_cn}, {ldif_dn_cn}, {attribute_cn}")
        groups.add(dn_cn)
    if not groups:
        raise ValueError("no groupOfNames CNs found in openldap-init Job")
    return groups


def named_role_assignments(groups, role_key, source_name):
    assignments = {}
    for group in groups:
        name = group.get("name")
        roles = group.get(role_key)
        if not isinstance(name, str) or not name:
            raise ValueError(f"{source_name} group has invalid name: {name!r}")
        if not isinstance(roles, list) or not all(isinstance(role, str) and role for role in roles):
            raise ValueError(f"{source_name} group {name} has invalid {role_key}")
        if name in assignments:
            raise ValueError(f"{source_name} has duplicate group: {name}")
        if len(roles) != len(set(roles)):
            raise ValueError(f"{source_name} group {name} has duplicate {role_key}")
        assignments[name] = sorted(roles)
    return assignments


def named_roles(roles, source_name):
    names = set()
    for role in roles:
        name = role.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"{source_name} role has invalid name: {name!r}")
        if name in names:
            raise ValueError(f"{source_name} has duplicate role: {name}")
        names.add(name)
    return names


def assert_same_names(expected, actual, source_name):
    if expected != actual:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise ValueError(f"{source_name} group CN drift (missing={missing}, unexpected={unexpected})")


try:
    with open(sys.argv[1], encoding="utf-8") as source:
        compiled = json.load(source)
    with open(sys.argv[2], encoding="utf-8") as source:
        policy = yaml.safe_load(source)
    with open(sys.argv[3], encoding="utf-8") as source:
        role_policy = yaml.safe_load(source)
    policy_groups = named_role_assignments(policy.get("groups", []), "roles", "policy declaration")
    compiled_groups = named_role_assignments(compiled.get("groups", []), "realmRoles", "compiled Keycloak")
    policy_role_names = named_roles(role_policy.get("roles", []), "policy declaration")
    compiled_role_names = named_roles(compiled.get("realmRoles", []), "compiled Keycloak")
    seed_groups, ldap_documents = group_cns_from_seed_ldif(sys.argv[4])
    init_groups = group_cns_from_init_job(ldap_documents)

    expected_names = set(policy_groups)
    assert_same_names(expected_names, set(compiled_groups), "compiled Keycloak")
    assert_same_names(expected_names, seed_groups, "OpenLDAP seed LDIF")
    assert_same_names(expected_names, init_groups, "OpenLDAP init Job")
    assert_same_names(policy_role_names, compiled_role_names, "compiled Keycloak realmRoles")
    unknown_group_roles = {
        name: sorted(set(roles) - compiled_role_names)
        for name, roles in compiled_groups.items()
        if set(roles) - compiled_role_names
    }
    if unknown_group_roles:
        raise ValueError(f"Keycloak groups reference undeclared realmRoles: {unknown_group_roles}")
    if policy_groups != compiled_groups:
        differences = {
            name: {"policy": policy_groups.get(name), "compiled": compiled_groups.get(name)}
            for name in sorted(set(policy_groups) | set(compiled_groups))
            if policy_groups.get(name) != compiled_groups.get(name)
        }
        raise ValueError(f"Keycloak group realmRoles drift: {differences}")
except (OSError, KeyError, TypeError, ValueError, yaml.YAMLError, SyntaxError) as error:
    print(f"Cannot verify Keycloak policy/OpenLDAP group seam: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

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
    # 자가 검증: 이름과 그룹별 역할 할당 두 드리프트가 모두 감지되는지 확인한다.
    NEGATIVE_KEYCLOAK="${COMPILED_DIR}/keycloak-group-drift.json"
    NEGATIVE_ROLE_KEYCLOAK="${COMPILED_DIR}/keycloak-role-drift.json"
    NEGATIVE_REALM_ROLE_KEYCLOAK="${COMPILED_DIR}/keycloak-realm-role-drift.json"
    python3 - "${COMPILED_DIR}/keycloak.json" "${NEGATIVE_KEYCLOAK}" "${NEGATIVE_ROLE_KEYCLOAK}" "${NEGATIVE_REALM_ROLE_KEYCLOAK}" <<'PY'
import copy
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    compiled = json.load(source)
group_drift = copy.deepcopy(compiled)
group_drift.setdefault("groups", []).append({"name": "__seam_negative__", "realmRoles": []})
with open(sys.argv[2], "w", encoding="utf-8") as output:
    json.dump(group_drift, output)

role_drift = copy.deepcopy(compiled)
if not role_drift["groups"]:
    raise ValueError("cannot self-check role drift without a compiled group")
role_drift["groups"][0]["realmRoles"].append("__seam_negative_role__")
with open(sys.argv[3], "w", encoding="utf-8") as output:
    json.dump(role_drift, output)

realm_role_drift = copy.deepcopy(compiled)
if not realm_role_drift.get("realmRoles"):
    raise ValueError("cannot self-check realm role drift without a compiled realm role")
realm_role_drift["realmRoles"].pop()
with open(sys.argv[4], "w", encoding="utf-8") as output:
    json.dump(realm_role_drift, output)
PY
    if verify_keycloak_group_seam "${NEGATIVE_KEYCLOAK}"; then
      log_error "자가 검증 실패 — Keycloak 그룹 이름 드리프트를 탐지하지 못함"
      exit 1
    fi
    if verify_keycloak_group_seam "${NEGATIVE_ROLE_KEYCLOAK}"; then
      log_error "자가 검증 실패 — Keycloak 그룹 realmRoles 드리프트를 탐지하지 못함"
      exit 1
    fi
    if verify_keycloak_group_seam "${NEGATIVE_REALM_ROLE_KEYCLOAK}"; then
      log_error "자가 검증 실패 — Keycloak 최상위 realmRoles 드리프트를 탐지하지 못함"
      exit 1
    fi
    log_success "자가 검증 통과 — Keycloak 그룹 이름/realmRoles/최상위 역할 드리프트 감지 정상 동작."

    if ! verify_keycloak_group_seam "${COMPILED_DIR}/keycloak.json"; then
      log_error "정책 선언, 컴파일된 Keycloak, OpenLDAP 그룹 사이에 드리프트 감지"
      exit 1
    fi
    log_success "policy groups.yaml, keycloak.json, OpenLDAP CN 및 그룹별 realmRoles 정합성 확인."
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
