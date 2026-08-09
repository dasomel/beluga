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

log_info "1/5 Launching Vagrant VMs..."
WORKER_MEMORY="${WORKER_MEMORY}" WORKER_CPUS="${WORKER_CPUS}" vagrant up

log_info "2/5 Running Node Preparation & K8s Initialization..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/cluster/01-node-prep.sh && sudo bash /vagrant/scripts/cluster/02-k8s-init.sh"
for worker in worker-1 worker-2 worker-3; do
  vagrant ssh "${worker}" -c "sudo bash /vagrant/scripts/cluster/01-node-prep.sh && sudo bash /vagrant/scripts/cluster/02-k8s-init.sh"
done

log_info "3/5 Installing CNI (Cilium) & LoadBalancer (MetalLB)..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/cluster/03-cni-metallb.sh"

log_info "4/5 Bootstrapping ArgoCD & GitOps Applications..."
vagrant ssh master-1 -c "sudo bash /vagrant/scripts/gitops/01-argocd-bootstrap.sh"

log_success "=========================================================="
log_success " Beluga Data Platform Provisioning Complete!"
log_success " Access URLs (via Local Port Forwarding):"
log_success " - Trino UI:       http://localhost:${HOST_PORT_TRINO:-8080}"
log_success " - Airflow UI:     http://localhost:${HOST_PORT_AIRFLOW:-8085}"
log_success " - Superset UI:    http://localhost:${HOST_PORT_SUPERSET:-8088}"
log_success " - Flink UI:       http://localhost:${HOST_PORT_FLINK:-8081}"
log_success " - Lakekeeper:     http://localhost:${HOST_PORT_LAKEKEEPER:-8181}"
log_success " - SeaweedFS S3:   http://localhost:${HOST_PORT_SEAWEED_S3:-8333}"
log_success " - Grafana:        http://localhost:${HOST_PORT_GRAFANA:-3000}"
log_success " - ArgoCD UI:      https://localhost:${HOST_PORT_ARGOCD:-8443}"
log_success "=========================================================="
