#!/usr/bin/env bash
# Beluga hosts file manager
# SwitchHosts 아이디어 기반: 블록 단위 그룹화, 활성/비활성 토글, 멱등 적용, 자동 백업 및 DNS 플러시
#
# 사용법:
#   bash scripts/hosts.sh            # 상태 및 블록 내용 출력 (변경 없음)
#   bash scripts/hosts.sh --apply    # /etc/hosts 에 beluga-mdp 블록 멱등 등록/갱신 (sudo 필요)
#   bash scripts/hosts.sh --on       # beluga-mdp 블록 활성화 (주석 해제)
#   bash scripts/hosts.sh --off      # beluga-mdp 블록 비활성화 (주석 처리)
#   bash scripts/hosts.sh --remove   # /etc/hosts 에서 beluga-mdp 블록 완전 제거
#   bash scripts/hosts.sh --status   # 현재 적용 및 활성화 상태 확인

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=/dev/null
if [[ -f "${SCRIPT_DIR}/common/logging.sh" ]]; then
  source "${SCRIPT_DIR}/common/logging.sh"
else
  log_info() { echo "[INFO] $*"; }
  log_success() { echo "[OK] $*"; }
  log_warn() { echo "[WARN] $*"; }
  log_error() { echo "[ERROR] $*" >&2; }
fi

# shellcheck source=/dev/null
if [[ -f "${SCRIPT_DIR}/common/env.sh" ]]; then
  source "${SCRIPT_DIR}/common/env.sh"
fi

HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
MARK_BEGIN="# BEGIN beluga-mdp"
MARK_END="# END beluga-mdp"
GROUP_TITLE="# @group: Beluga Modern Data Platform (APISIX Gateway)"
ACTION="${1:---status}"

APISIX_LB_IP="${APISIX_LB_IP:-192.168.77.200}"

# 1. 호스트네임 목록 추출 (클러스터 ApisixRoute 조회 시도 -> 실패 시 cluster.env 기본값)
get_hostnames() {
  local extracted=""
  local kubeconfig="${KUBECONFIG:-${BELUGA_ROOT}/.kube/config}"

  if command -v kubectl >/dev/null 2>&1 && [[ -f "${kubeconfig}" ]]; then
    extracted=$(KUBECONFIG="${kubeconfig}" kubectl get apisixroute -A -o json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    hosts = set()
    for item in data.get("items", []):
        for rule in (item.get("spec", {}).get("http") or []):
            for h in (rule.get("match", {}).get("hosts") or []):
                if h:
                    hosts.add(h)
    print(" ".join(sorted(hosts)))
except Exception:
    pass
' 2>/dev/null || true)
  fi

  if [[ -n "${extracted}" ]]; then
    echo "${extracted}"
    return
  fi

  # Fallback to predefined domains in cluster.env
  local default_hosts=(
    "${DOMAIN_TRINO:-trino.local.beluga.internal}"
    "${DOMAIN_AIRFLOW:-airflow.local.beluga.internal}"
    "${DOMAIN_SUPERSET:-superset.local.beluga.internal}"
    "${DOMAIN_FLINK:-flink.local.beluga.internal}"
    "${DOMAIN_CATALOG:-catalog.local.beluga.internal}"
    "${DOMAIN_S3:-s3.local.beluga.internal}"
    "${DOMAIN_FILER:-filer.local.beluga.internal}"
    "${DOMAIN_ARGOCD:-argocd.local.beluga.internal}"
    "${DOMAIN_SSO:-sso.local.beluga.internal}"
    "${DOMAIN_METADATA:-metadata.local.beluga.internal}"
  )
  echo "${default_hosts[*]}"
}

flush_dns_cache() {
  if [[ "${HOSTS_FILE}" != "/etc/hosts" ]]; then
    return 0
  fi
  if [[ "$OSTYPE" == "darwin"* ]]; then
    dscacheutil -flushcache 2>/dev/null || true
    if sudo -n true 2>/dev/null; then
      sudo killall -HUP mDNSResponder 2>/dev/null || true
    fi
    log_info "macOS DNS 캐시 플러시 완료."
  elif command -v resolvectl >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      sudo resolvectl flush-caches 2>/dev/null || true
    fi
  elif command -v systemd-resolve >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      sudo systemd-resolve --flush-caches 2>/dev/null || true
    fi
  fi
}

backup_hosts_file() {
  if [[ -w "${HOSTS_FILE}" ]]; then
    cp "${HOSTS_FILE}" "${HOSTS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  else
    sudo cp "${HOSTS_FILE}" "${HOSTS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  fi
}

has_block() {
  grep -q "^${MARK_BEGIN}\$" "${HOSTS_FILE}" 2>/dev/null && grep -q "^${MARK_END}\$" "${HOSTS_FILE}" 2>/dev/null
}

is_block_enabled() {
  if ! has_block; then
    return 1
  fi
  # 블록 내부에서 주석 처리되지 않은 IP 매핑 라인이 하나라도 있으면 활성화 상태로 판단
  sed -n "/^${MARK_BEGIN}\$/,/^${MARK_END}\$/p" "${HOSTS_FILE}" | grep -v "^#" | grep -q "${APISIX_LB_IP}"
}

remove_block() {
  if ! has_block; then
    return 0
  fi
  backup_hosts_file
  local tmp_file
  tmp_file="$(mktemp)"
  sed "/^${MARK_BEGIN}\$/,/^${MARK_END}\$/d" "${HOSTS_FILE}" > "${tmp_file}"
  if [[ -w "${HOSTS_FILE}" ]]; then
    cat "${tmp_file}" > "${HOSTS_FILE}"
  else
    sudo cp "${tmp_file}" "${HOSTS_FILE}"
  fi
  rm -f "${tmp_file}"
  flush_dns_cache
}

build_block_content() {
  local disabled="${1:-0}"
  local host_list
  host_list=$(get_hostnames)

  echo "${MARK_BEGIN}"
  echo "${GROUP_TITLE}"
  for h in ${host_list}; do
    if [[ "${disabled}" -eq 1 ]]; then
      echo "# ${APISIX_LB_IP} ${h}"
    else
      echo "${APISIX_LB_IP} ${h}"
    fi
  done
  echo "${MARK_END}"
}

case "${ACTION}" in
  --apply)
    log_info "hosts 파일(${HOSTS_FILE})에 Beluga MDP 블록 적용 중..."
    remove_block
    backup_hosts_file
    BLOCK="$(build_block_content 0)"
    if [[ -w "${HOSTS_FILE}" ]]; then
      printf '\n%s\n' "${BLOCK}" >> "${HOSTS_FILE}"
    else
      printf '\n%s\n' "${BLOCK}" | sudo tee -a "${HOSTS_FILE}" >/dev/null
    fi
    flush_dns_cache
    log_success "Beluga MDP hosts 블록 적용 완료 (활성 상태)."
    ;;

  --on|--enable)
    if ! has_block; then
      log_warn "등록된 Beluga MDP 블록이 없습니다. --apply를 먼저 실행합니다."
      "$0" --apply
      exit 0
    fi
    log_info "Beluga MDP 블록 활성화 (주석 해제) 중..."
    backup_hosts_file
    tmp_file="$(mktemp)"
    # 블록 내부에서 '# <IP>' 형태를 '<IP>'로 복원
    awk -v b="${MARK_BEGIN}" -v e="${MARK_END}" -v ip="${APISIX_LB_IP}" '
      $0 ~ b { in_b=1 }
      in_b && $0 ~ "^#[[:space:]]*" ip { sub("^#[[:space:]]*", ""); print; next }
      $0 ~ e { in_b=0 }
      { print }
    ' "${HOSTS_FILE}" > "${tmp_file}"
    if [[ -w "${HOSTS_FILE}" ]]; then
      cat "${tmp_file}" > "${HOSTS_FILE}"
    else
      sudo cp "${tmp_file}" "${HOSTS_FILE}"
    fi
    rm -f "${tmp_file}"
    flush_dns_cache
    log_success "Beluga MDP hosts 블록이 활성화되었습니다 [ON]."
    ;;

  --off|--disable)
    if ! has_block; then
      log_warn "등록된 Beluga MDP 블록이 없습니다."
      exit 0
    fi
    log_info "Beluga MDP 블록 비활성화 (주석 처리) 중..."
    backup_hosts_file
    tmp_file="$(mktemp)"
    # 블록 내부에서 주석 처리되지 않은 IP 매핑 라인 앞에 '# ' 추가
    awk -v b="${MARK_BEGIN}" -v e="${MARK_END}" -v ip="${APISIX_LB_IP}" '
      $0 ~ b { in_b=1 }
      in_b && $0 ~ "^" ip { print "# " $0; next }
      $0 ~ e { in_b=0 }
      { print }
    ' "${HOSTS_FILE}" > "${tmp_file}"
    if [[ -w "${HOSTS_FILE}" ]]; then
      cat "${tmp_file}" > "${HOSTS_FILE}"
    else
      sudo cp "${tmp_file}" "${HOSTS_FILE}"
    fi
    rm -f "${tmp_file}"
    flush_dns_cache
    log_success "Beluga MDP hosts 블록이 비활성화되었습니다 [OFF]."
    ;;

  --remove)
    log_info "hosts 파일(${HOSTS_FILE})에서 Beluga MDP 블록 제거 중..."
    if has_block; then
      remove_block
      log_success "Beluga MDP hosts 블록 제거 완료."
    else
      log_info "제거할 Beluga MDP 블록이 없습니다."
    fi
    ;;

  --print)
    build_block_content 0
    ;;

  --status|status|"")
    echo "=========================================================="
    echo " Beluga MDP Hosts Block Status (${HOSTS_FILE})"
    echo "=========================================================="
    if has_block; then
      if is_block_enabled; then
        log_success "상태: 등록됨 [ON - 활성]"
      else
        log_warn "상태: 등록됨 [OFF - 비활성/주석 처리됨]"
      fi
      echo ""
      echo "--- 현재 등록된 블록 내용 ---"
      sed -n "/^${MARK_BEGIN}\$/,/^${MARK_END}\$/p" "${HOSTS_FILE}"
      echo "-----------------------------"
    else
      log_info "상태: 미등록 (블록 없음)"
      echo ""
      echo "--- 등록 예정 블록 미리보기 ---"
      build_block_content 0
      echo "--------------------------------"
      echo ""
      echo "적용하려면: bash scripts/hosts.sh --apply"
    fi
    echo ""
    echo "사용 가능한 명령:"
    echo "  bash scripts/hosts.sh --apply   # 블록 등록 및 최신화"
    echo "  bash scripts/hosts.sh --on      # 블록 활성화 (토글 ON)"
    echo "  bash scripts/hosts.sh --off     # 블록 비활성화 (토글 OFF)"
    echo "  bash scripts/hosts.sh --remove  # 블록 완전 제거"
    ;;

  *)
    log_error "알 수 없는 옵션: ${ACTION}"
    echo "사용법: $0 [--apply | --on | --off | --remove | --status | --print]"
    exit 1
    ;;
esac
