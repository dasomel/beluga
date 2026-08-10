#!/usr/bin/env bash
# Beluga Environment & RAM Profile Loader (D8)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -f "${SCRIPT_DIR}/logging.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/logging.sh"
fi

ENV_FILE="${BELUGA_ROOT}/configs/cluster.env"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
fi

detect_host_ram_gb() {
  local ram_bytes=0
  if [[ "$OSTYPE" == "darwin"* ]]; then
    ram_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  elif [[ -f /proc/meminfo ]]; then
    local mem_kb
    mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    ram_bytes=$((mem_kb * 1024))
  fi

  local ram_gb=$((ram_bytes / 1024 / 1024 / 1024))
  echo "${ram_gb}"
}

apply_ram_profile() {
  local host_ram_gb
  host_ram_gb=$(detect_host_ram_gb)

  if [[ ${host_ram_gb} -ge 64 ]]; then
    BELUGA_PROFILE=64
    WORKER_MEMORY=12288
    WORKER_CPUS=4
  elif [[ ${host_ram_gb} -ge 48 ]]; then
    BELUGA_PROFILE=48
    WORKER_MEMORY=10240
    WORKER_CPUS=4
  else
    BELUGA_PROFILE=32
    WORKER_MEMORY=8192
    WORKER_CPUS=4
  fi
  MASTER_MEMORY=4096
  MASTER_CPUS=2

  # 이미 설정돼 있으면 존중 — VM 안에서 재source될 때 VM RAM(4GB) 기준으로
  # 호스트에서 결정된 프로파일을 덮어쓰지 않기 위함 (up.sh가 ssh로 전달)
  if [[ -z "${ENABLE_OPENMETADATA:-}" || -z "${TRINO_WORKER_ENABLED:-}" ]]; then
    if [[ ${BELUGA_PROFILE} -ge 48 ]]; then
      ENABLE_OPENMETADATA="${ENABLE_OPENMETADATA:-true}"
      TRINO_WORKER_ENABLED="${TRINO_WORKER_ENABLED:-true}"
    else
      ENABLE_OPENMETADATA="${ENABLE_OPENMETADATA:-false}"
      TRINO_WORKER_ENABLED="${TRINO_WORKER_ENABLED:-false}"
    fi
  fi

  export BELUGA_PROFILE WORKER_MEMORY WORKER_CPUS MASTER_MEMORY MASTER_CPUS ENABLE_OPENMETADATA TRINO_WORKER_ENABLED

  if command -v log_info &>/dev/null; then
    log_info "RAM Profile applied: BELUGA_PROFILE=${BELUGA_PROFILE} (Worker RAM: ${WORKER_MEMORY}MB, OpenMetadata: ${ENABLE_OPENMETADATA}, Trino Worker: ${TRINO_WORKER_ENABLED})"
  fi
}

apply_ram_profile
