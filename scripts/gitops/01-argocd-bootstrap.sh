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
# Task 16(D-E 2/2) 실측 결함: OAuth2 인증이 켜지면 Trino 노드 간 내부 통신에도 공유
# 시크릿이 필수다(계획서에 없던 요구사항, 코디네이터 크래시루프로 실측) — 코디네이터·워커
# 전 노드가 동일 값을 써야 한다.
ensure_cred trino-internal-shared-secret

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
TRINO_INTERNAL_SHARED_SECRET="$(get_cred trino-internal-shared-secret)"
APISIX_ADMIN_KEY="$(get_cred apisix-admin-key)"
USER_PASS_ADMIN="$(get_cred user-password-admin)"
USER_PASS_ENGINEER="$(get_cred user-password-engineer)"
USER_PASS_ANALYST="$(get_cred user-password-analyst)"
LDAP_ADMIN_PASS="$(get_cred ldap-admin-password 2>/dev/null || true)"

log_info "Creating derived credential secrets..."
# postgres-admin-credential: CNPG Cluster(database)의 bootstrap.initdb.secret,
# OpenMetadata(governance)의 DB_USER_PASSWORD 외에도 D-K(이슈 #104)로 Debezium 등록 Job
# (streaming), Lakekeeper(lakehouse), Airflow(orchestration), Superset(analytics)이
# 모두 secretKeyRef로 참조한다. Secret은 네임스페이스 스코프라 필요한 만큼 동일 값으로 복제한다.
for ns in database governance streaming lakehouse orchestration analytics; do
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

# D-K(이슈 #104): 아래부터는 예전에 helm --set credentials.*로 렌더 시점에 굽던 값들이다.
# ArgoCD Application이 git에서 관리하는 리소스가 아니므로 selfHeal이 되돌릴 수 없다.
# ldap-admin-credential: openldap 서버/init Job, keycloak-ldap-federation Job(모두 iam),
# Task 13부터는 Trino group-provider(analytics)도 같은 LDAP admin bind 계정을 재사용한다.
for ns in iam analytics; do
  kubectl create secret generic ldap-admin-credential -n "${ns}" \
    --from-literal=password="${LDAP_ADMIN_PASS}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

# keycloak-user-passwords: keycloak-users Job(iam)이 beluga-admin/-engineer/-analyst
# 계정 생성에 쓴다.
kubectl create secret generic keycloak-user-passwords -n iam \
  --from-literal=admin="${USER_PASS_ADMIN}" \
  --from-literal=engineer="${USER_PASS_ENGINEER}" \
  --from-literal=analyst="${USER_PASS_ANALYST}" \
  --dry-run=client -o yaml | kubectl apply -f -

# keycloak-client-secrets: keycloak-clients Job(iam)이 realm 클라이언트 시크릿을 교정할 때,
# Superset(analytics)/Airflow(orchestration)/OpenMetadata(governance)가 각자의 OIDC
# client_secret을 읽을 때 참조한다. 5개 키 전체를 4개 네임스페이스에 동일하게 복제한다.
for ns in iam analytics orchestration governance; do
  kubectl create secret generic keycloak-client-secrets -n "${ns}" \
    --from-literal=superset="${CLIENT_SECRET_SUPERSET}" \
    --from-literal=airflow="${CLIENT_SECRET_AIRFLOW}" \
    --from-literal=openmetadata="${CLIENT_SECRET_OPENMETADATA}" \
    --from-literal=grafana="${CLIENT_SECRET_GRAFANA}" \
    --from-literal=trino="${CLIENT_SECRET_TRINO}" \
    --dry-run=client -o yaml | kubectl apply -f -
done

# superset-credential: Superset Deployment/import Job(analytics)이 SECRET_KEY와 admin 계정
# 비밀번호를 읽는다.
kubectl create secret generic superset-credential -n analytics \
  --from-literal=secret-key="${SUPERSET_SECRET_KEY}" \
  --from-literal=admin-password="${SUPERSET_ADMIN_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

# apisix-admin-credential: APISIX 데이터 플레인(config.yaml 환경변수 치환)과 ingress
# controller(platform-system)가 admin API 인증에 쓴다.
kubectl create secret generic apisix-admin-credential -n platform-system \
  --from-literal=key="${APISIX_ADMIN_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

# trino-internal-shared-secret: Task 16(D-E 2/2) — 코디네이터·워커(둘 다 analytics) 내부
# 통신 인증용, 두 노드가 동일 값을 써야 한다.
kubectl create secret generic trino-internal-shared-secret -n analytics \
  --from-literal=secret="${TRINO_INTERNAL_SHARED_SECRET}" \
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
# D-K(이슈 #104): credentials.* --set 제거 — 차트가 더 이상 이 값들을 렌더 시점에 쓰지
# 않는다(위에서 생성한 네임스페이스별 Secret을 secretKeyRef로 읽는다).
helm template beluga-platform "${BELUGA_ROOT}/gitops/charts/beluga-platform" \
  --namespace platform-system | kubectl apply -f - || true

# D19: keycloak-group-mapper Job은 keycloak-ldap-federation Job이 만든 LDAP 프로바이더
# 컴포넌트 ID를 조회해서 쓴다 — 이 스크립트의 kubectl apply는 ArgoCD sync-wave를 타지 않는
# 1회성 적용이라 순서가 보장되지 않으므로, 여기서 명시적으로 완료를 기다려 순서를 강제한다.
log_info "Waiting for Keycloak LDAP federation Job (그룹 매퍼가 의존하는 프로바이더 생성 대기)..."
kubectl -n iam wait --for=condition=complete job/keycloak-ldap-federation --timeout=180s || true
log_info "Waiting for Keycloak group-ldap-mapper Job (사용자→그룹→롤 사슬 연결)..."
kubectl -n iam wait --for=condition=complete job/keycloak-group-mapper --timeout=180s || true

log_info "Applying beluga-data Helm Chart..."
# D-K(이슈 #104): credentials.* --set 제거 — 위와 동일한 이유.
helm template beluga-data "${BELUGA_ROOT}/gitops/charts/beluga-data" \
  --namespace storage \
  --set openmetadata.enabled="${ENABLE_OPENMETADATA:-false}" \
  --set trino.workerEnabled="${TRINO_WORKER_ENABLED:-false}" | kubectl apply -f - || true

log_info "Applying App-of-Apps root manifest..."
APP_OF_APPS="${BELUGA_ROOT}/gitops/apps/app-of-apps.yaml"
if [[ -f "${APP_OF_APPS}" ]]; then
  kubectl apply -f "${APP_OF_APPS}" || true
fi

log_success "GitOps applications and data platform stack applied successfully."
log_info "To retrieve any credential from Secret 'beluga-credentials':"
log_info "  kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d"
