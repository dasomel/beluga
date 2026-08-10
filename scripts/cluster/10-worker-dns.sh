#!/usr/bin/env bash
# Beluga Worker Node DNS Resolver Configuration Script
#
# Configures systemd-resolved on worker nodes to forward *.local.beluga.internal
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
DOMAIN="${DOMAIN:-local.beluga.internal}"

log_info "=== Configuring worker DNS resolver for ${DOMAIN} ==="
log_info "Master dnsmasq: ${MASTER_IP}"

# Drop-in: route *.local.beluga.internal to master dnsmasq only (split-DNS)
sudo mkdir -p /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/beluga-worker.conf > /dev/null << EOF
[Resolve]
DNS=${MASTER_IP}
Domains=~${DOMAIN}
EOF

sudo systemctl restart systemd-resolved

log_info "Verifying worker DNS resolution for trino.${DOMAIN}..."
if resolvectl query "trino.${DOMAIN}" > /dev/null 2>&1 || nslookup "trino.${DOMAIN}" > /dev/null 2>&1; then
  log_success "Worker DNS resolution verified: *.${DOMAIN} -> ${MASTER_IP}"
else
  log_warn "Worker DNS resolution warning: trino.${DOMAIN} not immediately resolvable"
fi
