#!/usr/bin/env bash
# Beluga ArgoCD Bootstrap Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"

log_info "Bootstrapping ArgoCD v2.14.0..."

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.0/manifests/install.yaml

log_info "Waiting for ArgoCD server deployment..."
kubectl rollout status deployment/argocd-server -n argocd --timeout=180s || true

log_info "Applying App-of-Apps root manifest..."
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_OF_APPS="${BELUGA_ROOT}/gitops/apps/app-of-apps.yaml"

if [[ -f "${APP_OF_APPS}" ]]; then
  kubectl apply -f "${APP_OF_APPS}"
  log_success "App-of-Apps applied successfully."
else
  log_warn "App-of-Apps manifest not found at ${APP_OF_APPS}. Skipping apply."
fi
