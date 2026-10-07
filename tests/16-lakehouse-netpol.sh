#!/usr/bin/env bash
# Beluga E2E Test 16: lakehouse 네임스페이스 default-deny NetworkPolicy 집행 검증 (이슈 #11)
#
# 04b-lakehouse-network-policy.yaml이 실제 데이터플레인(Cilium)에서 집행되는지(무관한
# 네임스페이스/무라벨 파드 차단), 그리고 정당한 경로(게이트웨이 -> Lakekeeper, 부트스트랩/마이그레이트
# Job 라벨의 허용된 egress)가 계속 동작하는지 둘 다 확인한다. 라이브 클러스터 전용이며
# purpose=tmp-netpol-check 라벨의 일회성 probe 파드만 default/lakehouse에 만들고 종료 시 지운다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

PROBE_IMAGE="curlimages/curl:8.21.0"
LK_SVC="http://lakekeeper.lakehouse.svc.cluster.local:8181"
PROBES=(
  "default lk-netpol-default"
  "lakehouse lk-netpol-plain"
  "lakehouse lk-netpol-boot"
  "lakehouse lk-netpol-mig"
)

cleanup() {
  local entry
  for entry in "${PROBES[@]}"; do
    kubectl -n "${entry%% *}" delete pod "${entry##* }" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# probe <namespace> <name> [extra-labels]: 일회성 curl probe 파드. app=lakekeeper 라벨은 Service
# 셀렉터와 겹치므로 절대 쓰지 않는다.
probe() {
  local ns="$1" name="$2" labels="purpose=tmp-netpol-check${3:+,$3}"
  kubectl -n "${ns}" delete pod "${name}" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "${ns}" run "${name}" --restart=Never --labels="${labels}" \
    --image="${PROBE_IMAGE}" --command -- sleep 300 >/dev/null
  kubectl -n "${ns}" wait --for=condition=Ready "pod/${name}" --timeout=90s >/dev/null
}

# curl_exit <ns> <pod> <curl args...>: curl 종료코드만 돌려준다(28=timeout 차단, 0/1/52/56=연결됨).
curl_exit() {
  local ns="$1" pod="$2"; shift 2
  local rc=0
  kubectl -n "${ns}" exec "${pod}" -- curl -s --max-time 6 -o /dev/null "$@" >/dev/null 2>&1 || rc=$?
  echo "${rc}"
}

expect_blocked() { # <desc> <rc>
  if [[ "$2" -ne 28 ]]; then
    log_error "$1: 차단돼야 하는데 연결됨/다른 오류(curl exit=$2)"
    exit 1
  fi
  log_success "$1: 차단됨(timeout)."
}
expect_reached() { # <desc> <rc>  (HTTP 아닌 프로토콜 포트는 curl exit 1/52/56도 '도달'이다)
  if [[ "$2" -eq 28 || "$2" -eq 6 || "$2" -eq 7 ]]; then
    log_error "$1: 허용돼야 하는데 도달 실패(curl exit=$2)"
    exit 1
  fi
  log_success "$1: 도달 가능(curl exit=$2)."
}

log_info "[TEST 16] lakehouse default-deny NetworkPolicy 집행 검증..."

log_info "1. NetworkPolicy 6종이 배포돼 있는지 확인..."
for np in default-deny-all allow-cluster-dns lakekeeper-ingress lakekeeper-egress \
          lakekeeper-migrate-egress lakekeeper-bootstrap-egress; do
  if ! kubectl -n lakehouse get networkpolicy "${np}" >/dev/null 2>&1; then
    log_error "NetworkPolicy lakehouse/${np}가 존재하지 않음"
    exit 1
  fi
done
log_success "NetworkPolicy 6종 존재 확인."

log_info "1b. lakekeeper-egress가 게이트웨이(apisix:443)를 허용하는지 확인 (JWKS는 외부 호스트 경유)..."
LK_EGRESS_GW="$(kubectl -n lakehouse get networkpolicy lakekeeper-egress -o json | python3 -c '
import json, sys
for rule in json.load(sys.stdin)["spec"].get("egress", []):
    for dest in rule.get("to", []):
        ns = dest.get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name")
        app = dest.get("podSelector", {}).get("matchLabels", {}).get("app")
        if ns == "platform-system" and app == "apisix" and any(p.get("port") == 443 and p.get("protocol", "TCP") == "TCP" for p in rule.get("ports", [])):
            print("yes")
            sys.exit(0)
print("no")')"
if [[ "${LK_EGRESS_GW}" != "yes" ]]; then
  log_error "lakekeeper-egress에 platform-system/apisix:443 허용이 없음 — 재시작 후 JWKS 조회가 막혀 모든 토큰이 401이 된다"
  exit 1
fi
log_success "lakekeeper-egress: apisix:443 허용 확인."
# 관찰 검증: 정책이 있어도 실제 JWKS 조회가 막히면 로그에 남는다(캐시가 살아 있는 동안은 안 보일 수
# 있으므로 위 정책 검사와 함께 쓴다 — 단독으로는 부족하다).
JWKS_ERRORS="$(kubectl -n lakehouse logs deploy/lakekeeper --since=10m 2>/dev/null | grep -c 'Failed fetching the key' || true)"
if [[ "${JWKS_ERRORS}" -gt 0 ]]; then
  log_error "lakekeeper가 최근 10분간 JWKS 조회에 ${JWKS_ERRORS}회 실패(Failed fetching the key) — 외부 sso 경로 차단 의심"
  exit 1
fi
log_success "lakekeeper 최근 10분 JWKS 조회 실패 0건."

log_info "2. Lakekeeper가 Ready인지 확인..."
if ! kubectl -n lakehouse get deployment lakekeeper -o jsonpath='{.status.readyReplicas}' | grep -q '^1$'; then
  log_error "lakekeeper Deployment가 Ready 상태가 아님"
  exit 1
fi
log_success "lakekeeper Ready."

probe default lk-netpol-default
probe lakehouse lk-netpol-plain
probe lakehouse lk-netpol-boot app=lakekeeper-bootstrap
probe lakehouse lk-netpol-mig app=lakekeeper-migrate

log_info "3. Ingress: 허용 목록 밖(default 네임스페이스, lakehouse 무라벨 파드)에서 lakekeeper:8181 접근..."
expect_blocked "default -> lakekeeper:8181" "$(curl_exit default lk-netpol-default "${LK_SVC}/health")"
expect_blocked "lakehouse 무라벨 파드 -> lakekeeper:8181" "$(curl_exit lakehouse lk-netpol-plain "${LK_SVC}/health")"

log_info "4. 정당한 경로: 게이트웨이(apisix) -> lakekeeper가 계속 동작하는지 확인..."
GW_SVC_IP="$(kubectl -n platform-system get svc apisix-gateway -o jsonpath='{.spec.clusterIP}')"
GW_CODE="$(kubectl -n default exec lk-netpol-default -- curl -sk --max-time 8 -o /dev/null -w '%{http_code}' \
  --resolve "catalog.local.beluga.internal:443:${GW_SVC_IP}" https://catalog.local.beluga.internal/health 2>/dev/null || true)"
if [[ "${GW_CODE}" != "200" ]]; then
  log_error "게이트웨이 경유 lakekeeper /health가 200이 아님(HTTP ${GW_CODE:-none}) — apisix 허용 규칙 의심"
  exit 1
fi
log_success "게이트웨이 -> lakekeeper /health 200."

log_info "5. Egress: 무라벨 lakehouse 파드는 default-deny로 모든 목적지가 차단돼야 한다..."
expect_blocked "무라벨 -> keycloak:8080" "$(curl_exit lakehouse lk-netpol-plain http://keycloak.iam.svc.cluster.local:8080/realms/beluga)"
expect_blocked "무라벨 -> postgres:5432" "$(curl_exit lakehouse lk-netpol-plain http://postgres-main-rw.database.svc.cluster.local:5432/)"
expect_blocked "무라벨 -> trino:8080(임의 서비스)" "$(curl_exit lakehouse lk-netpol-plain http://trino.analytics.svc.cluster.local:8080/)"

log_info "6. Egress: bootstrap 라벨 파드는 keycloak/lakekeeper/seaweedfs-s3만 허용..."
expect_reached "bootstrap -> keycloak:8080" "$(curl_exit lakehouse lk-netpol-boot http://keycloak.iam.svc.cluster.local:8080/realms/beluga)"
expect_reached "bootstrap -> lakekeeper:8181" "$(curl_exit lakehouse lk-netpol-boot "${LK_SVC}/health")"
expect_reached "bootstrap -> seaweedfs-s3:8333" "$(curl_exit lakehouse lk-netpol-boot http://seaweedfs-s3.storage.svc.cluster.local:8333/)"
expect_blocked "bootstrap -> openfga:8081(비허용)" "$(curl_exit lakehouse lk-netpol-boot http://openfga.iam.svc.cluster.local:8081/)"

log_info "7. Egress: migrate 라벨 파드는 postgres/openfga만 허용..."
expect_reached "migrate -> postgres:5432" "$(curl_exit lakehouse lk-netpol-mig http://postgres-main-rw.database.svc.cluster.local:5432/)"
expect_reached "migrate -> openfga:8081" "$(curl_exit lakehouse lk-netpol-mig http://openfga.iam.svc.cluster.local:8081/)"
expect_blocked "migrate -> keycloak:8080(비허용)" "$(curl_exit lakehouse lk-netpol-mig http://keycloak.iam.svc.cluster.local:8080/realms/beluga)"

log_success "[TEST 16] lakehouse default-deny가 집행되며 정당한 트래픽은 영향받지 않음."
