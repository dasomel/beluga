#!/usr/bin/env bash
# Beluga ArgoCD & Local GitOps Bootstrap Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"

log_info "Bootstrapping ArgoCD v2.14.0..."

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.0/manifests/install.yaml

log_info "Waiting for ArgoCD server deployment..."
kubectl rollout status deployment/argocd-server -n argocd --timeout=180s || true
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort", "ports": [{"name": "https", "port": 443, "targetPort": 8080, "nodePort": 30443}]}}' || true

BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log_info "Installing Kubernetes Operator CRDs (CNPG, Strimzi, Flink, APISIX)..."

kubectl create namespace beluga-system --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace beluga-data --dry-run=client -o yaml | kubectl apply -f -

# 1. CNPG Operator (v1.25.0)
log_info "Installing CloudNativePG (CNPG) Operator..."
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.25.0/releases/cnpg-1.25.0.yaml || true

# 2. Strimzi Kafka Operator (v0.45.0)
log_info "Installing Strimzi Kafka Operator CRDs & Controller..."
kubectl apply -f https://github.com/strimzi/strimzi-kafka-operator/releases/download/0.45.0/strimzi-cluster-operator-0.45.0.yaml -n beluga-data || true

# 3. Flink Kubernetes Operator CRDs (v1.10)
log_info "Installing Flink Kubernetes Operator CRDs..."
kubectl apply -f https://raw.githubusercontent.com/apache/flink-kubernetes-operator/main/helm/flink-kubernetes-operator/crds/flinkdeployments.flink.apache.org-v1.yml || true
kubectl apply -f https://raw.githubusercontent.com/apache/flink-kubernetes-operator/main/helm/flink-kubernetes-operator/crds/flinksessionjobs.flink.apache.org-v1.yml || true

# 4. APISIX Ingress Controller CRDs (master branch - narwhal alignment)
log_info "Installing APISIX Ingress Controller CRDs..."
kubectl apply -f https://raw.githubusercontent.com/apache/apisix-ingress-controller/master/config/crd/bases/apisix.apache.org_apisixroutes.yaml || true
kubectl apply -f https://raw.githubusercontent.com/apache/apisix-ingress-controller/master/config/crd/bases/apisix.apache.org_apisixupstreams.yaml || true

log_info "Waiting for Operator CRDs registration..."
sleep 10

log_info "Applying beluga-platform Helm Chart..."
helm template beluga-platform "${BELUGA_ROOT}/gitops/charts/beluga-platform" \
  --namespace beluga-system | kubectl apply -f - || true

log_info "Applying beluga-data Helm Chart..."
helm template beluga-data "${BELUGA_ROOT}/gitops/charts/beluga-data" \
  --namespace beluga-data | kubectl apply -f - || true

log_info "Applying App-of-Apps root manifest..."
APP_OF_APPS="${BELUGA_ROOT}/gitops/apps/app-of-apps.yaml"
if [[ -f "${APP_OF_APPS}" ]]; then
  kubectl apply -f "${APP_OF_APPS}" || true
fi

log_success "GitOps applications and data platform stack applied successfully."
