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

# D-KAKAO-4: 클라우드 노드는 cluster.env(Vagrant 서브넷 192.168.77.x)의 IP 값을 덮어써야 한다.
# cloud-init이 /etc/beluga/cluster.override.env 를 쓰면 여기서 마지막에 적용된다. 파일이 없으면
# (Vagrant 경로) 아무 일도 하지 않는다. 탈출구: BELUGA_ENV_OVERRIDE_FILE 로 경로를 바꾼다.
OVERRIDE_FILE="${BELUGA_ENV_OVERRIDE_FILE:-/etc/beluga/cluster.override.env}"
if [[ -f "${OVERRIDE_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${OVERRIDE_FILE}"
fi

# D-KAKAO-6: 프록시 뒤 노드(사설 서브넷, NAT 없음) — cloud-init 이 /etc/default/beluga-proxy 를
# 쓴다. 여기서 export 하면 curl/helm/apt 뿐 아니라 get.k3s.io install.sh 도 export 된
# (NO|HTTP|HTTPS)_PROXY 를 k3s(-agent).service.env 에 복사하므로(install.sh create_env_file
# 확인) containerd 이미지 풀에도 프록시가 적용된다. NO_PROXY 에는 VPC/파드/서비스 CIDR와
# 127.0.0.1(kubectl)이 들어 있어야 클러스터 내부 트래픽이 프록시로 새지 않는다.
# 파일이 없으면(Vagrant) 아무 일도 하지 않는다.
PROXY_ENV_FILE="${BELUGA_PROXY_ENV_FILE:-/etc/default/beluga-proxy}"
if [[ -f "${PROXY_ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${PROXY_ENV_FILE}"
  set +a
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
  if [[ -n "${BELUGA_PROFILE:-}" ]]; then
    # 명시된 프로파일은 32/48/64만 허용 — 그 외 값(128, abc)이 32GB 사이징으로 빠지면서
    # 아래 -ge 48 분기로 OpenMetadata까지 켜지는 불일치를 막는다 (docs/environment-profiles.md P7)
    if [[ ! "${BELUGA_PROFILE}" =~ ^(32|48|64)$ ]]; then
      echo "ERROR: invalid BELUGA_PROFILE='${BELUGA_PROFILE}' — allowed values: 32, 48, 64 (or unset for host RAM auto-detect)" >&2
      return 1
    fi
    case "${BELUGA_PROFILE}" in
      64)
        WORKER_MEMORY="${WORKER_MEMORY:-12288}"
        WORKER_CPUS="${WORKER_CPUS:-4}"
        MASTER_MEMORY="${MASTER_MEMORY:-6144}"
        MASTER_CPUS="${MASTER_CPUS:-2}"
        ;;
      48)
        WORKER_MEMORY="${WORKER_MEMORY:-10240}"
        WORKER_CPUS="${WORKER_CPUS:-4}"
        MASTER_MEMORY="${MASTER_MEMORY:-4096}"
        MASTER_CPUS="${MASTER_CPUS:-2}"
        ;;
      32)
        WORKER_MEMORY="${WORKER_MEMORY:-8192}"
        WORKER_CPUS="${WORKER_CPUS:-4}"
        MASTER_MEMORY="${MASTER_MEMORY:-4096}"
        MASTER_CPUS="${MASTER_CPUS:-2}"
        ;;
    esac
  else
    local host_ram_gb
    host_ram_gb=$(detect_host_ram_gb)

    if [[ ${host_ram_gb} -ge 64 ]]; then
      BELUGA_PROFILE=64
      WORKER_MEMORY=12288
      WORKER_CPUS=4
      MASTER_MEMORY=6144
      MASTER_CPUS=2
    elif [[ ${host_ram_gb} -ge 48 ]]; then
      BELUGA_PROFILE=48
      WORKER_MEMORY=10240
      WORKER_CPUS=4
      MASTER_MEMORY=4096
      MASTER_CPUS=2
    else
      BELUGA_PROFILE=32
      WORKER_MEMORY=8192
      WORKER_CPUS=4
      MASTER_MEMORY=4096
      MASTER_CPUS=2
    fi
  fi

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

# source하는 스크립트(set -e)가 잘못된 프로파일에서 중단되도록 실패를 전파
# shellcheck disable=SC2317  # exit는 source가 아닌 직접 실행 시에만 도달
apply_ram_profile || { return 1 2>/dev/null || exit 1; }
