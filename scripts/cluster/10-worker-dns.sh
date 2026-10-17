#!/usr/bin/env bash
# Beluga Worker Node DNS Resolver Configuration Script
#
# Configures systemd-resolved on worker nodes to forward *.<BASE_DOMAIN> (기본 local.beluga.internal)
# queries to master-1 dnsmasq instance (192.168.77.10).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/../common/logging.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/../common/logging.sh"
else
  log_info() { echo "[INFO] $*"; }
  log_success() { echo "[SUCCESS] $*"; }
  log_warn() { echo "[WARN] $*"; }
  log_error() { echo "[ERROR] $*"; }
fi

if [[ -f "${SCRIPT_DIR}/../common/env.sh" ]]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/../common/env.sh"
fi

MASTER_IP="${MASTER_IP:-192.168.77.10}"
DOMAIN="${DOMAIN:-${BASE_DOMAIN:-local.beluga.internal}}"

# 도메인 전환 중 신·구 도메인 동시 라우팅(콤마 목록, 기본 빈 값 = 무변경). 10-dnsmasq.sh 와 같은 값을 쓴다.
EXTRA_DOMAINS="${EXTRA_DOMAINS:-}"
EXTRA_LIST="${EXTRA_DOMAINS//,/ }"
RESOLVED_DOMAINS="~${DOMAIN}"
for extra in ${EXTRA_LIST}; do
  if [[ ! "${extra}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    log_error "EXTRA_DOMAINS entry '${extra}' is not a valid DNS name"
    exit 1
  fi
  RESOLVED_DOMAINS="${RESOLVED_DOMAINS} ~${extra}"
done

log_info "=== Configuring worker DNS resolver for ${DOMAIN} ==="
log_info "Master dnsmasq: ${MASTER_IP}"

# Drop-in: route *.${DOMAIN} to master dnsmasq only (split-DNS)
sudo mkdir -p /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/beluga-worker.conf > /dev/null << EOF
[Resolve]
DNS=${MASTER_IP}
Domains=${RESOLVED_DOMAINS}
EOF

sudo systemctl restart systemd-resolved

log_info "Verifying worker DNS resolution for trino.${DOMAIN}..."
if resolvectl query "trino.${DOMAIN}" > /dev/null 2>&1 || nslookup "trino.${DOMAIN}" > /dev/null 2>&1; then
  log_success "Worker DNS resolution verified: *.${DOMAIN} -> ${MASTER_IP}"
else
  log_warn "Worker DNS resolution warning: trino.${DOMAIN} not immediately resolvable"
fi
