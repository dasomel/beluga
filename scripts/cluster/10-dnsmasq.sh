#!/usr/bin/env bash
# Beluga Master Node dnsmasq Installation & CoreDNS Integration Script
#
# Configures dnsmasq on master-1 (192.168.77.10) to resolve *.<BASE_DOMAIN> (기본 local.beluga.internal)
# to APISIX LB IP (192.168.77.200).
# Configures CoreDNS in K3s to forward <BASE_DOMAIN> queries to master dnsmasq.

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
# D-DOM-7: 도메인은 BASE_DOMAIN(cluster.env, 클라우드는 override env)에서 온다. 기본 local.beluga.internal.
DOMAIN="${DOMAIN:-${BASE_DOMAIN:-local.beluga.internal}}"
SKIP_COREDNS="${SKIP_COREDNS:-false}"
# 도메인 전환 중 신·구 도메인을 동시에 같은 게이트웨이 IP로 응답하게 한다(콤마 목록, 기본 빈 값 = 무변경).
# 예: DOMAIN=kakao.beluga.internal EXTRA_DOMAINS=local.beluga.internal. 값은 dnsmasq/CoreDNS 설정에 들어가므로 형식을 검증한다.
EXTRA_DOMAINS="${EXTRA_DOMAINS:-}"
EXTRA_LIST="${EXTRA_DOMAINS//,/ }"
for extra in ${EXTRA_LIST}; do
  if [[ ! "${extra}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    log_error "EXTRA_DOMAINS entry '${extra}' is not a valid DNS name"
    exit 1
  fi
done
COREDNS_ZONES="${DOMAIN}:53"
for extra in ${EXTRA_LIST}; do
  COREDNS_ZONES="${COREDNS_ZONES} ${extra}:53"
done

log_info "=== Installing and configuring dnsmasq on master-1 ==="
log_info "Master IP: ${MASTER_IP}"
log_info "MetalLB / APISIX IP: ${APISIX_LB_IP}"
log_info "Domain: *.${DOMAIN}"

# Keep upstream resolvers space-separated because CoreDNS's forward directive
# expects all upstreams on the same line. /etc/resolv.conf normally returns one
# nameserver per line.
# D-KAKAO-8: UPSTREAM_DNS(공백 구분)가 주어지면 그대로 쓴다. 클라우드 노드의 /etc/resolv.conf는
# systemd-resolved 스텁(127.0.0.53)뿐이라 아래 자동 감지가 비고, 8.8.8.8 폴백은 NAT 없는 사설
# 서브넷에서 도달 불가다 — kakao-up.sh 가 VPC DHCP DNS를 넘긴다. 미지정이면 기존 동작 그대로.
if [[ -n "${UPSTREAM_DNS:-}" ]]; then
  UPSTREAM_SERVERS="${UPSTREAM_DNS}"
else
  UPSTREAM_SERVERS=$(grep -E '^nameserver' /etc/resolv.conf | awk '{print $2}' | grep -v -E '^127\.' | tr '\n' ' ' | xargs || true)
fi
if [[ -z "${UPSTREAM_SERVERS}" ]]; then
  UPSTREAM_SERVERS="8.8.8.8 8.8.4.4"
fi
log_info "Preserved upstream DNS servers: ${UPSTREAM_SERVERS}"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq dnsmasq
sudo systemctl stop dnsmasq || true

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

sudo rm -f /etc/resolv.conf
{
  echo "# Managed by beluga dnsmasq setup script"
  echo "nameserver 127.0.0.1"
  for srv in ${UPSTREAM_SERVERS}; do
    echo "nameserver ${srv}"
  done
} | sudo tee /etc/resolv.conf > /dev/null

sudo mkdir -p /etc/dnsmasq.d
sudo rm -f /etc/dnsmasq.d/default 2>/dev/null || true
{
  echo "# Beluga local domain resolution"
  echo "listen-address=${MASTER_IP}"
  echo "listen-address=127.0.0.1"
  echo "bind-interfaces"
  echo "port=53"
  echo "address=/${DOMAIN}/${APISIX_LB_IP}"
  for extra in ${EXTRA_LIST}; do
    echo "address=/${extra}/${APISIX_LB_IP}"
  done
  for srv in ${UPSTREAM_SERVERS}; do
    echo "server=${srv}"
  done
  echo "no-resolv"
  echo "cache-size=1000"
  echo "domain-needed"
  echo "bogus-priv"
} | sudo tee /etc/dnsmasq.d/local.conf > /dev/null

sudo mkdir -p /etc/systemd/system/dnsmasq.service.d
sudo tee /etc/systemd/system/dnsmasq.service.d/restart.conf > /dev/null << EOF
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=always
RestartSec=5
EOF

sudo systemctl daemon-reload
sudo systemctl start dnsmasq
sudo systemctl enable dnsmasq
sleep 2

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

if [[ "${SKIP_COREDNS}" == "true" ]]; then
  log_info "SKIP_COREDNS=true: skipping CoreDNS integration."
else
  log_info "=== Configuring K3s CoreDNS for in-cluster domain resolution ==="

  COREDNS_CM=$(kubectl get configmap coredns -n kube-system -o json 2>/dev/null || echo "")
  if [[ -n "${COREDNS_CM}" ]]; then
    if echo "${COREDNS_CM}" | grep -q "${DOMAIN}"; then
      log_info "CoreDNS forward rule for ${DOMAIN} already configured."
    else
      kubectl create configmap coredns-custom -n kube-system \
        --from-literal=beluga.server="${COREDNS_ZONES} {
    errors
    cache 30
    forward . ${MASTER_IP}
}" \
        --dry-run=client -o yaml | kubectl apply -f -

      COREFILE=$(kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}')
      if [[ "${COREFILE}" == *"forward . /etc/resolv.conf"* ]]; then
        COREFILE_SAFE="${COREFILE//"forward . /etc/resolv.conf"/"forward . ${UPSTREAM_SERVERS}"}"
        # Keep the environment assignment on the Python process. Placing it
        # after the pipe only exports it to kubectl, which caused CF to be
        # missing in Python under set -u.
        CF="${COREFILE_SAFE}" python3 -c "import json,sys,os; d=json.load(sys.stdin); d['data']['Corefile']=os.environ['CF']; print(json.dumps(d))" \
          <<< "${COREDNS_CM}" | kubectl apply -f -
      else
        log_warn "CoreDNS Corefile does not contain the expected default forward rule; leaving it unchanged."
      fi

      log_info "Restarting CoreDNS rollout..."
      kubectl rollout restart deployment coredns -n kube-system
      kubectl rollout status deployment coredns -n kube-system --timeout=60s
      log_success "CoreDNS configured: ${DOMAIN} -> ${MASTER_IP}"
    fi

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
