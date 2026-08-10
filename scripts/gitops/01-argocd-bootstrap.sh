#!/usr/bin/env bash
# Beluga ArgoCD & Local GitOps Bootstrap Script
# D11: APISIX 게이트웨이 기반 인그레스 — NodePort 패치 제거

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/env.sh"

log_info "Bootstrapping ArgoCD v2.14.0..."

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.0/manifests/install.yaml

log_info "Waiting for ArgoCD server deployment..."
kubectl rollout status deployment/argocd-server -n argocd --timeout=180s || true

# D11: ArgoCD는 APISIX route로 접근 (argocd.local.beluga.internal:80)
# NodePort 패치 불필요

BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log_info "Installing Kubernetes Operator CRDs (CNPG, Strimzi, Flink, APISIX)..."

kubectl create namespace beluga-system --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace beluga-data --dry-run=client -o yaml | kubectl apply -f -

# D15: Platform Secret & Credentials Generation (Idempotent)
if ! kubectl get secret beluga-credentials -n beluga-system >/dev/null 2>&1; then
  log_info "Generating random platform credentials into secret 'beluga-credentials'..."
  kubectl create secret generic beluga-credentials -n beluga-system \
    --from-literal=pg-password="$(openssl rand -hex 16)" \
    --from-literal=keycloak-admin-password="$(openssl rand -hex 12)" \
    --from-literal=superset-secret-key="$(openssl rand -hex 24)" \
    --from-literal=superset-admin-password="$(openssl rand -hex 8)" \
    --from-literal=client-secret-superset="$(openssl rand -hex 16)" \
    --from-literal=client-secret-airflow="$(openssl rand -hex 16)" \
    --from-literal=client-secret-openmetadata="$(openssl rand -hex 16)" \
    --from-literal=client-secret-grafana="$(openssl rand -hex 16)" \
    --from-literal=client-secret-trino="$(openssl rand -hex 16)"
fi

get_cred() {
  kubectl -n beluga-system get secret beluga-credentials -o jsonpath="{.data.$1}" | base64 -d
}

PG_PASS="$(get_cred pg-password)"
KC_ADMIN_PASS="$(get_cred keycloak-admin-password)"
SUPERSET_SECRET_KEY = "SET-AT-BOOTSTRAP"
SUPERSET_ADMIN_PASS="$(get_cred superset-admin-password)"
CLIENT_SECRET_SUPERSET="$(get_cred client-secret-superset)"
CLIENT_SECRET_AIRFLOW="$(get_cred client-secret-airflow)"
CLIENT_SECRET_OPENMETADATA="$(get_cred client-secret-openmetadata)"
CLIENT_SECRET_GRAFANA="$(get_cred client-secret-grafana)"
CLIENT_SECRET_TRINO="$(get_cred client-secret-trino)"

log_info "Creating derived credential secrets..."
kubectl create secret generic postgres-admin-credential -n beluga-data \
  --from-literal=username=beluga_admin \
  --from-literal=password="${PG_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic keycloak-admin-credential -n beluga-system \
  --from-literal=username=admin \
  --from-literal=password="${KC_ADMIN_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic keycloak-db-credential -n beluga-system \
  --from-literal=username=beluga_admin \
  --from-literal=password="${PG_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

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
kubectl apply -f https://raw.githubusercontent.com/apache/apisix-ingress-controller/master/config/crd/bases/apisix.apache.org_apisixtlses.yaml || true

log_info "Waiting for Operator CRDs registration..."
sleep 10

log_info "Applying beluga-platform Helm Chart..."
helm template beluga-platform "${BELUGA_ROOT}/gitops/charts/beluga-platform" \
  --namespace beluga-system \
  --set credentials.clientSecrets.superset="${CLIENT_SECRET_SUPERSET}" \
  --set credentials.clientSecrets.airflow="${CLIENT_SECRET_AIRFLOW}" \
  --set credentials.clientSecrets.openmetadata="${CLIENT_SECRET_OPENMETADATA}" \
  --set credentials.clientSecrets.grafana="${CLIENT_SECRET_GRAFANA}" \
  --set credentials.clientSecrets.trino="${CLIENT_SECRET_TRINO}" | kubectl apply -f - || true

log_info "Applying beluga-data Helm Chart..."
helm template beluga-data "${BELUGA_ROOT}/gitops/charts/beluga-data" \
  --namespace beluga-data \
  --set openmetadata.enabled="${ENABLE_OPENMETADATA:-false}" \
  --set trino.workerEnabled="${TRINO_WORKER_ENABLED:-false}" \
  --set credentials.pgPassword="${PG_PASS}" \
  --set credentials.supersetSecretKey="${SUPERSET_SECRET_KEY}" \
  --set credentials.supersetAdminPassword="${SUPERSET_ADMIN_PASS}" \
  --set credentials.clientSecrets.superset="${CLIENT_SECRET_SUPERSET}" \
  --set credentials.clientSecrets.airflow="${CLIENT_SECRET_AIRFLOW}" \
  --set credentials.clientSecrets.openmetadata="${CLIENT_SECRET_OPENMETADATA}" | kubectl apply -f - || true

log_info "Applying App-of-Apps root manifest..."
APP_OF_APPS="${BELUGA_ROOT}/gitops/apps/app-of-apps.yaml"
if [[ -f "${APP_OF_APPS}" ]]; then
  kubectl apply -f "${APP_OF_APPS}" || true
fi

log_success "GitOps applications and data platform stack applied successfully."
log_info "To retrieve any credential from Secret 'beluga-credentials':"
log_info "  kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d"
