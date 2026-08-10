#!/usr/bin/env bash
# Beluga Master Node dnsmasq Installation & CoreDNS Integration Script
#
# Configures dnsmasq on master-1 (192.168.77.10) to resolve *.local.beluga.internal
# to APISIX LB IP (192.168.77.200).
# Configures CoreDNS in K3s to forward local.beluga.internal queries to master dnsmasq.

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
APISIX_LB_IP="${APISIX_LB_IP:-192.168.77.200}"
DOMAIN="${DOMAIN:-local.beluga.internal}"
SKIP_COREDNS="${SKIP_COREDNS:-false}"

log_info "=== Installing and configuring dnsmasq on master-1 ==="
log_info "Master IP: ${MASTER_IP}"
log_info "MetalLB / APISIX IP: ${APISIX_LB_IP}"
log_info "Domain: *.${DOMAIN}"

# Preserve existing upstream nameservers from /etc/resolv.conf before modification
UPSTREAM_SERVERS=$(grep -E '^nameserver' /etc/resolv.conf | awk '{print $2}' | grep -v -E '^127\.' || true)
if [[ -z "${UPSTREAM_SERVERS}" ]]; then
  UPSTREAM_SERVERS="8.8.8.8 8.8.4.4"
fi
log_info "Preserved upstream DNS servers: ${UPSTREAM_SERVERS}"

# Install dnsmasq
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq dnsmasq

# Stop dnsmasq temporarily
sudo systemctl stop dnsmasq || true

# Handle systemd-resolved port 53 conflict (narwhal pattern)
if systemctl is-active --quiet systemd-resolved; then
  log_info "Configuring systemd-resolved to disable stub listener..."
  sudo mkdir -p /etc/systemd/resolved.conf.d
  sudo tee /etc/systemd/resolved.conf.d/dnsmasq.conf > /dev/null << EOF
[Resolve]
DNS=127.0.0.1
FallbackDNS=${UPSTREAM_SERVERS}
DNSStubListener=no
EOF
  sudo systemctl restart systemd-resolved
fi

# Ensure /etc/resolv.conf uses localhost (dnsmasq) and upstream fallback
sudo rm -f /etc/resolv.conf
{
  echo "# Managed by beluga dnsmasq setup script"
  echo "nameserver 127.0.0.1"
  for srv in ${UPSTREAM_SERVERS}; do
    echo "nameserver ${srv}"
  done
} | sudo tee /etc/resolv.conf > /dev/null

# Configure dnsmasq
sudo mkdir -p /etc/dnsmasq.d
sudo rm -f /etc/dnsmasq.d/default 2>/dev/null || true

{
  echo "# Beluga local domain resolution"
  echo "listen-address=${MASTER_IP}"
  echo "listen-address=127.0.0.1"
  echo "bind-interfaces"
  echo "port=53"
  echo "address=/${DOMAIN}/${APISIX_LB_IP}"
  for srv in ${UPSTREAM_SERVERS}; do
    echo "server=${srv}"
  done
  echo "no-resolv"
  echo "cache-size=1000"
  echo "domain-needed"
  echo "bogus-priv"
} | sudo tee /etc/dnsmasq.d/local.conf > /dev/null

# Systemd restart configuration for reboot resilience
sudo mkdir -p /etc/systemd/system/dnsmasq.service.d
sudo tee /etc/systemd/system/dnsmasq.service.d/restart.conf > /dev/null << EOF
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
EOF

# Start and enable dnsmasq
sudo systemctl daemon-reload
sudo systemctl start dnsmasq
sudo systemctl enable dnsmasq

sleep 2

# Self-verification of dnsmasq resolution
log_info "Verifying local DNS resolution (trino.${DOMAIN})..."
TEST_IP=""
if command -v dig &>/dev/null; then
  TEST_IP=$(dig +short @127.0.0.1 "trino.${DOMAIN}" | tail -n1)
elif command -v nslookup &>/dev/null; then
  TEST_IP=$(nslookup "trino.${DOMAIN}" 127.0.0.1 2>/dev/null | grep -E '^Address:' | tail -n1 | awk '{print $2}')
fi

if [[ "${TEST_IP}" != "${APISIX_LB_IP}" ]]; then
  log_error "dnsmasq verification failed! Expected ${APISIX_LB_IP}, got '${TEST_IP}'"
  exit 1
fi
log_success "dnsmasq local resolution verified: trino.${DOMAIN} -> ${TEST_IP}"

# CoreDNS Integration for K3s
if [[ "${SKIP_COREDNS}" == "true" ]]; then
  log_info "SKIP_COREDNS=true: skipping CoreDNS integration."
else
  log_info "=== Configuring K3s CoreDNS for in-cluster domain resolution ==="

  COREDNS_CM=$(kubectl get configmap coredns -n kube-system -o json 2>/dev/null || echo "")
  if [[ -n "${COREDNS_CM}" ]]; then
    if echo "${COREDNS_CM}" | grep -q "${DOMAIN}"; then
      log_info "CoreDNS forward rule for ${DOMAIN} already configured."
    else
      COREFILE=$(kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}')

      # Prevent loop by replacing forward . /etc/resolv.conf with upstream DNS
      COREFILE_SAFE="${COREFILE//"forward . /etc/resolv.conf"/"forward . ${UPSTREAM_SERVERS}"}"

      NEW_COREFILE="${DOMAIN}:53 {
    errors
    cache 30
    forward . ${MASTER_IP}
}
${COREFILE_SAFE}"

      kubectl create configmap coredns -n kube-system \
        --from-literal=Corefile="${NEW_COREFILE}" \
        --dry-run=client -o yaml | kubectl apply -f -

      # Also create coredns-custom ConfigMap for K3s native override support
      kubectl create configmap coredns-custom -n kube-system \
        --from-literal=beluga.server="${DOMAIN}:53 {
    errors
    cache 30
    forward . ${MASTER_IP}
}" \
        --dry-run=client -o yaml | kubectl apply -f -

      log_info "Restarting CoreDNS rollout..."
      kubectl rollout restart deployment coredns -n kube-system 2>/dev/null || true
      kubectl rollout status deployment coredns -n kube-system --timeout=60s || true
      log_success "CoreDNS configured: ${DOMAIN} -> ${MASTER_IP}"
    fi

    # Verify Pod DNS resolution via CoreDNS
    log_info "Testing Pod DNS resolution via CoreDNS..."
    POD_NAME="dns-test-pod-$$"
    kubectl run "${POD_NAME}" --image=busybox:1.36 --restart=Never -- nslookup "sso.${DOMAIN}" > /dev/null 2>&1 || true
    kubectl wait --for=condition=Ready pod/"${POD_NAME}" --timeout=15s >/dev/null 2>&1 || true
    sleep 3
    POD_OUT=$(kubectl logs "${POD_NAME}" 2>/dev/null || echo "")
    kubectl delete pod "${POD_NAME}" --grace-period=0 --force >/dev/null 2>&1 || true

    if echo "${POD_OUT}" | grep -q "${APISIX_LB_IP}"; then
      log_success "In-cluster Pod DNS resolution verified: sso.${DOMAIN} -> ${APISIX_LB_IP}"
    else
      log_error "In-cluster Pod DNS verification failed! Pod output: ${POD_OUT}"
      exit 1
    fi
  else
    log_warn "CoreDNS ConfigMap not found in kube-system."
  fi
fi

log_success "=== Master dnsmasq & CoreDNS integration complete ==="
