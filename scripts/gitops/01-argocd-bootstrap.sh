#!/usr/bin/env bash
# Beluga ArgoCD & Local GitOps Bootstrap Script
# D11: APISIX 게이트웨이 기반 인그레스 — NodePort 패치 제거

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/env.sh"

log_info "Bootstrapping ArgoCD v3.5.0..."

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# v3.x CRD는 256KB 초과라 client-side apply가 "annotations: Too long"으로 실패 (실측)
kubectl apply --server-side --force-conflicts -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.0/manifests/install.yaml

log_info "Waiting for ArgoCD server deployment..."
kubectl rollout status deployment/argocd-server -n argocd --timeout=180s || true

# D11: ArgoCD는 APISIX route로 접근 (argocd.local.beluga.internal:80)
# NodePort 패치 불필요

BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log_info "Installing Kubernetes Operator CRDs (CNPG, Strimzi, Flink, APISIX)..."

# 네임스페이스 재편: beluga-system/beluga-data(2개) → 기능별 네임스페이스(narwhal 컨벤션 정합).
# helm 차트의 00-namespaces.yaml도 동일 네임스페이스를 선언하지만, 아래 오퍼레이터 설치는
# helm 차트 적용보다 먼저 실행되므로 여기서 먼저 만들어 둔다(멱등).
for ns in platform-system iam database storage streaming lakehouse analytics orchestration governance; do
  kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f -
done

# D15: Platform Secret & Credentials Generation (Idempotent)
if ! kubectl get secret beluga-credentials -n platform-system >/dev/null 2>&1; then
  log_info "Generating random platform credentials into secret 'beluga-credentials'..."
  kubectl create secret generic beluga-credentials -n platform-system \
    --from-literal=pg-password="$(openssl rand -hex 16)" \
    --from-literal=keycloak-admin-password="$(openssl rand -hex 12)" \
    --from-literal=ldap-admin-password="$(openssl rand -hex 12)" \
    --from-literal=superset-secret-key="$(openssl rand -hex 24)" \
    --from-literal=superset-admin-password="$(openssl rand -hex 8)" \
    --from-literal=client-secret-superset="$(openssl rand -hex 16)" \
    --from-literal=client-secret-airflow="$(openssl rand -hex 16)" \
    --from-literal=client-secret-openmetadata="$(openssl rand -hex 16)" \
    --from-literal=client-secret-grafana="$(openssl rand -hex 16)" \
    --from-literal=client-secret-trino="$(openssl rand -hex 16)"
fi

get_cred() {
  kubectl -n platform-system get secret beluga-credentials -o jsonpath="{.data.$1}" | base64 -d
}

# 기존 secret에 새 키가 없으면 추가 (업그레이드 경로 멱등성)
ensure_cred() {
  if [[ -z "$(kubectl -n platform-system get secret beluga-credentials -o jsonpath="{.data.$1}" 2>/dev/null)" ]]; then
    kubectl -n platform-system patch secret beluga-credentials \
      -p "{\"stringData\":{\"$1\":\"$(openssl rand -hex 16)\"}}"
  fi
}
ensure_cred apisix-admin-key
ensure_cred ldap-admin-password
ensure_cred user-password-admin
ensure_cred user-password-engineer
ensure_cred user-password-analyst
# Task 15: Trino 코디네이터 HTTPS 키스토어(PKCS12) 비밀번호 — D15 규칙대로 실제 값은 이
# 스크립트가 생성해 Secret으로만 넣고, 차트/Application에는 자리표시자만 남긴다.
ensure_cred trino-keystore-password

PG_PASS="$(get_cred pg-password)"
KC_ADMIN_PASS="$(get_cred keycloak-admin-password)"
LDAP_ADMIN_PASS="$(get_cred ldap-admin-password)"
SUPERSET_SECRET_KEY="$(get_cred superset-secret-key)"
SUPERSET_ADMIN_PASS="$(get_cred superset-admin-password)"
CLIENT_SECRET_SUPERSET="$(get_cred client-secret-superset)"
CLIENT_SECRET_AIRFLOW="$(get_cred client-secret-airflow)"
CLIENT_SECRET_OPENMETADATA="$(get_cred client-secret-openmetadata)"
CLIENT_SECRET_GRAFANA="$(get_cred client-secret-grafana)"
CLIENT_SECRET_TRINO="$(get_cred client-secret-trino)"
TRINO_KEYSTORE_PASSWORD="$(get_cred trino-keystore-password)"
APISIX_ADMIN_KEY="$(get_cred apisix-admin-key)"
USER_PASS_ADMIN="$(get_cred user-password-admin)"
USER_PASS_ENGINEER="$(get_cred user-password-engineer)"
USER_PASS_ANALYST="$(get_cred user-password-analyst)"
LDAP_ADMIN_PASS="$(get_cred ldap-admin-password 2>/dev/null || true)"

log_info "Creating derived credential secrets..."
# postgres-admin-credential: CNPG Cluster(database 네임스페이스)의 bootstrap.initdb.secret이
# 참조하는 시크릿이자, OpenMetadata(governance 네임스페이스)가 DB_USER_PASSWORD로 secretKeyRef
# 참조하는 시크릿이기도 하다. Secret은 네임스페이스 스코프라 두 네임스페이스에 동일 값으로 복제한다.
for ns in database governance; do
  kubectl create secret generic postgres-admin-credential -n "${ns}" \
    --from-literal=username=beluga_admin \
    --from-literal=password="${PG_PASS}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

kubectl create secret generic keycloak-admin-credential -n iam \
  --from-literal=username=admin \
  --from-literal=password="${KC_ADMIN_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic keycloak-db-credential -n iam \
  --from-literal=username=beluga_admin \
  --from-literal=password="${PG_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Task 15: trino-keystore-password — cert-manager Certificate(analytics)의
# keystores.pkcs12.passwordSecretRef가 참조한다. cert-manager 문서상 이 Secret은
# Certificate와 같은 네임스페이스(analytics)에 있어야 한다.
kubectl create secret generic trino-keystore-password -n analytics \
  --from-literal=password="${TRINO_KEYSTORE_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

# 0. cert-manager (v1.21.1) — Task 15: Trino 코디네이터 TLS 전제, Task 16(OAuth2)이
# "코디네이터 자체가 TLS로 보안돼야 한다"를 요구하므로 다른 오퍼레이터보다 먼저 설치한다.
# 실측(2026-08-21, GitHub Releases API): 최신 stable, 지원 K8s 1.33–1.36 → k3s 1.36.3 커버.
log_info "Installing cert-manager v1.21.1..."
kubectl apply --server-side --force-conflicts \
  -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.1/cert-manager.yaml
log_info "Waiting for cert-manager webhook to be ready..."
kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s

# 1. CNPG Operator (v1.30.0)
log_info "Installing CloudNativePG (CNPG) Operator..."
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.0.yaml || true

# 2. Strimzi Kafka Operator (1.1.0 — K8s 1.36 호환, fabric8 신버전. 0.45는 /version 파싱 실패로 기동 불가였음)
# 릴리스 YAML의 RoleBinding들은 기본 네임스페이스(myproject)를 참조 — sed 치환 없이는
# 오퍼레이터가 lease RBAC 403으로 리더 선출조차 못 함 (E2E 실측, Strimzi 공식 설치 절차)
log_info "Installing Strimzi Kafka Operator CRDs & Controller..."
curl -sL https://github.com/strimzi/strimzi-kafka-operator/releases/download/1.1.0/strimzi-cluster-operator-1.1.0.yaml \
  | sed 's/namespace: .*/namespace: streaming/' \
  | kubectl apply --server-side --force-conflicts -n streaming -f - || true

# 3. Flink Kubernetes Operator (1.15.0) — CRD만 설치하고 오퍼레이터 본체를 빠뜨려
# FlinkDeployment가 리컨실 없이 방치됐던 갭 수정 (E2E 실측). 웹훅 비활성으로 cert-manager 의존 회피
log_info "Installing Flink Kubernetes Operator (helm, 1.15.0)..."
helm repo add flink-operator-repo https://downloads.apache.org/flink/flink-kubernetes-operator-1.15.0/ || true
helm repo update flink-operator-repo || true
helm upgrade --install flink-kubernetes-operator flink-operator-repo/flink-kubernetes-operator \
  --namespace streaming \
  --set webhook.create=false || true

# 4. APISIX Ingress Controller CRDs — 컨트롤러 버전 태그(v1.8.0)의 전체 세트
# master 브랜치는 이미 2.x(ADC 개편) 라인이라 1.8.0과 불일치하고, 일부만 설치하면
# 컨트롤러 informer가 없는 CRD를 watch하다 캐시 sync에 영원히 실패해 라우트가
# 하나도 반영되지 않는다 (라우트 0개·전 도메인 404로 실측)
log_info "Installing APISIX Ingress Controller CRDs (full set, v1.8.0)..."
APISIX_CRD_BASE="https://raw.githubusercontent.com/apache/apisix-ingress-controller/v1.8.0/samples/deploy/crd/v1"
for crd in ApisixRoute ApisixUpstream ApisixTls ApisixClusterConfig ApisixConsumer ApisixGlobalRule ApisixPluginConfig; do
  kubectl apply -f "${APISIX_CRD_BASE}/${crd}.yaml"
done

log_info "Waiting for operators to become ready (webhook race 방지 — sleep 금지)..."
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=180s
kubectl rollout status deployment/strimzi-cluster-operator -n streaming --timeout=180s || true

log_info "Applying beluga-platform Helm Chart..."
helm template beluga-platform "${BELUGA_ROOT}/gitops/charts/beluga-platform" \
  --namespace platform-system \
  --set credentials.clientSecrets.superset="${CLIENT_SECRET_SUPERSET}" \
  --set credentials.clientSecrets.airflow="${CLIENT_SECRET_AIRFLOW}" \
  --set credentials.clientSecrets.openmetadata="${CLIENT_SECRET_OPENMETADATA}" \
  --set credentials.clientSecrets.grafana="${CLIENT_SECRET_GRAFANA}" \
  --set credentials.clientSecrets.trino="${CLIENT_SECRET_TRINO}" \
  --set credentials.apisixAdminKey="${APISIX_ADMIN_KEY}" \
  --set credentials.keycloakAdminPassword="${KC_ADMIN_PASS}" \
  --set credentials.ldapAdminPassword="${LDAP_ADMIN_PASS}" \
  --set credentials.userPasswords.admin="${USER_PASS_ADMIN}" \
  --set credentials.userPasswords.engineer="${USER_PASS_ENGINEER}" \
  --set credentials.userPasswords.analyst="${USER_PASS_ANALYST}" | kubectl apply -f - || true

# D19: keycloak-group-mapper Job은 keycloak-ldap-federation Job이 만든 LDAP 프로바이더
# 컴포넌트 ID를 조회해서 쓴다 — 이 스크립트의 kubectl apply는 ArgoCD sync-wave를 타지 않는
# 1회성 적용이라 순서가 보장되지 않으므로, 여기서 명시적으로 완료를 기다려 순서를 강제한다.
log_info "Waiting for Keycloak LDAP federation Job (그룹 매퍼가 의존하는 프로바이더 생성 대기)..."
kubectl -n iam wait --for=condition=complete job/keycloak-ldap-federation --timeout=180s || true
log_info "Waiting for Keycloak group-ldap-mapper Job (사용자→그룹→롤 사슬 연결)..."
kubectl -n iam wait --for=condition=complete job/keycloak-group-mapper --timeout=180s || true

log_info "Applying beluga-data Helm Chart..."
helm template beluga-data "${BELUGA_ROOT}/gitops/charts/beluga-data" \
  --namespace storage \
  --set openmetadata.enabled="${ENABLE_OPENMETADATA:-false}" \
  --set trino.workerEnabled="${TRINO_WORKER_ENABLED:-false}" \
  --set credentials.pgPassword="${PG_PASS}" \
  --set credentials.ldapAdminPassword="${LDAP_ADMIN_PASS}" \
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
log_info "  kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d"
