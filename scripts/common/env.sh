#!/usr/bin/env bash
# Beluga Environment & RAM Profile Loader (D8)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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
    WORKER_MEMORY=12288
    WORKER_CPUS=4
  elif [[ ${host_ram_gb} -ge 48 ]]; then
    WORKER_MEMORY=10240
    WORKER_CPUS=4
  else
    WORKER_MEMORY=8192
    WORKER_CPUS=4
  fi
  MASTER_MEMORY=4096
  MASTER_CPUS=2

  export WORKER_MEMORY WORKER_CPUS MASTER_MEMORY MASTER_CPUS
}

apply_ram_profile
