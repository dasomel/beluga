#!/usr/bin/env bash
# Beluga Platform Bootstrap Entrypoint (up.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/env.sh"

log_info "=========================================================="
log_info " Starting Beluga Data Platform Cluster Provisioning"
log_info " Subnet: ${SUBNET_PREFIX}.x | Master: ${MASTER_IP}"
log_info " Host RAM Profile Detected -> Worker RAM: ${WORKER_MEMORY} MB"
log_info "=========================================================="

cd "${BELUGA_ROOT}"

log_info "1/5 Launching Vagrant VMs (Provider: ${VAGRANT_PROVIDER:-vmware_fusion})..."
WORKER_MEMORY="${WORKER_MEMORY}" WORKER_CPUS="${WORKER_CPUS}" vagrant up --provider="${VAGRANT_PROVIDER:-vmware_fusion}"

log_info "2/5 Running Node Preparation & K8s Initialization..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/cluster/01-node-prep.sh && sudo bash /vagrant/scripts/cluster/02-k8s-init.sh"
for worker in worker-1 worker-2 worker-3; do
  vagrant ssh "${worker}" -c "sudo bash /vagrant/scripts/cluster/01-node-prep.sh && sudo bash /vagrant/scripts/cluster/02-k8s-init.sh"
done

log_info "3/5 Installing CNI (Cilium) & LoadBalancer (MetalLB)..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/cluster/03-cni-metallb.sh"

log_info "4/5 Configuring Local DNS Infrastructure (dnsmasq & worker DNS)..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/cluster/10-dnsmasq.sh"
for worker in worker-1 worker-2 worker-3; do
  vagrant ssh "${worker}" -c "sudo bash /vagrant/scripts/cluster/10-worker-dns.sh"
done

log_info "5/5 Bootstrapping ArgoCD & GitOps Applications..."
vagrant ssh master-1 -c "sudo ENABLE_OPENMETADATA=${ENABLE_OPENMETADATA:-false} TRINO_WORKER_ENABLED=${TRINO_WORKER_ENABLED:-false} bash /vagrant/scripts/gitops/01-argocd-bootstrap.sh"

log_success "=========================================================="
log_success " Beluga Data Platform Provisioning Complete!"
log_success " Host DNS Setup Options (Choose one for macOS / Host):"
log_success "  Option A (Recommended for macOS): /etc/resolver configuration"
log_success "    sudo mkdir -p /etc/resolver"
log_success "    echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal"
log_success "  Option B: /etc/hosts entry"
log_success "    192.168.77.200 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal sso.local.beluga.internal metadata.local.beluga.internal"
log_success ""
log_success " Access URLs (via *.local.beluga.internal on Unified Port 80):"
log_success " - Trino UI:       http://trino.local.beluga.internal"
log_success " - Airflow UI:     http://airflow.local.beluga.internal"
log_success " - Superset UI:    http://superset.local.beluga.internal"
log_success " - Lakekeeper:     http://catalog.local.beluga.internal"
log_success " - SeaweedFS S3:   http://s3.local.beluga.internal"
log_success " - ArgoCD UI:      http://argocd.local.beluga.internal"
log_success " - Keycloak SSO:   http://sso.local.beluga.internal"
log_success " - Metadata:       http://metadata.local.beluga.internal"
log_success "=========================================================="

