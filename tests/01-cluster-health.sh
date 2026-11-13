#!/usr/bin/env bash
# Beluga E2E Test 01: Cluster & Pod Health Verification

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "[TEST 01] Verifying Kubernetes Cluster Nodes & Core Pods..."

KUBECONFIG_PATH="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
if [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
fi

# EXPECTED_NODES: 기대 Ready 노드 수. 기본 4는 Vagrant 레퍼런스(마스터 1 + 워커 3)이며 단일 노드
# colima/k3s 같은 환경은 EXPECTED_NODES=1로 낮춘다. 외부 입력이므로 양의 정수만 받는다.
if [[ -z "${EXPECTED_NODES+x}" ]]; then
  EXPECTED_NODES=4
  NODES_SOURCE="default: 1 master + 3 workers; override with EXPECTED_NODES"
else
  NODES_SOURCE="EXPECTED_NODES override"
fi
if [[ ! "${EXPECTED_NODES}" =~ ^[1-9][0-9]*$ ]]; then
  log_error "EXPECTED_NODES must be a positive integer, got '${EXPECTED_NODES}'."
  exit 1
fi
log_info "Expecting ${EXPECTED_NODES} Ready node(s) (${NODES_SOURCE})."

log_info "1. Checking K8s node status..."
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | grep -c "Ready" || true)
NODE_COUNT=${NODE_COUNT:-0}
log_info "Found ${NODE_COUNT} Ready node(s)."

if [[ ${NODE_COUNT} -lt ${EXPECTED_NODES} ]]; then
  log_error "Expected ${EXPECTED_NODES} Ready node(s), found ${NODE_COUNT}."
  exit 1
else
  log_success "All ${EXPECTED_NODES} expected cluster node(s) are Ready."
fi

log_info "2. Checking system pods..."
FAILED_PODS=$(kubectl get pods -A --no-headers 2>/dev/null | grep -v -c -E "Running|Completed" || true)
FAILED_PODS=${FAILED_PODS:-0}

if [[ ${FAILED_PODS} -eq 0 ]]; then
  log_success "All Kubernetes pods are Running or Completed."
else
  log_error "Found ${FAILED_PODS} pod(s) not in Running/Completed state:"
  FAIL_GATE=1
  kubectl get pods -A --no-headers 2>/dev/null | grep -v -E "Running|Completed" || true
fi

# `kubectl | grep -q` under pipefail: grep -q exits at first match -> kubectl SIGPIPE (141) -> false result.
# Capture first, then grep the variable; a real kubectl failure is a failure, not "not found".
log_info "3. Checking Service datapath ownership..."
KUBE_SYSTEM_PODS=$(kubectl get pods -n kube-system --no-headers 2>/dev/null) || {
  log_error "kubectl get pods -n kube-system failed."
  FAIL_GATE=1
  KUBE_SYSTEM_PODS=""
}
ALL_PODS=$(kubectl get pods -A --no-headers 2>/dev/null) || {
  log_error "kubectl get pods -A failed."
  FAIL_GATE=1
  ALL_PODS=""
}
if grep -q 'cilium-' <<<"${KUBE_SYSTEM_PODS}"; then
  log_success "Cilium is deployed in kube-system."
else
  log_error "Cilium pods were not found in kube-system."
  FAIL_GATE=1
fi

if grep -qE '(^|[[:space:]])kube-proxy(-|[[:space:]])' <<<"${ALL_PODS}"; then
  log_error "kube-proxy pods are present; Cilium kube-proxy replacement is not exclusive."
  kubectl get pods -A -o wide | grep -E '(^|[[:space:]])kube-proxy(-|[[:space:]])' || true
  FAIL_GATE=1
else
  log_success "No kube-proxy pods found; Cilium owns the Service datapath."
fi

# D-KAKAO-7: 게이트웨이 노출 모드. metallb(기본, Vagrant) | nodeport(클라우드 — CSP NLB 가 워커 NodePort 로 전달).
# 명시값이 없으면 라이브 apisix-gateway Service 타입으로 판별한다(NodePort 면 nodeport).
LB_MODE="${BELUGA_LB_MODE:-}"
if [[ -z "${LB_MODE}" ]]; then
  GW_TYPE=$(kubectl -n platform-system get svc apisix-gateway -o jsonpath='{.spec.type}' 2>/dev/null || true)
  if [[ "${GW_TYPE}" == "NodePort" ]]; then LB_MODE=nodeport; else LB_MODE=metallb; fi
fi
log_info "Gateway exposure mode: ${LB_MODE}"

if grep -qE '(^|[[:space:]])svclb-[^[:space:]]+' <<<"${ALL_PODS}"; then
  log_error "K3s ServiceLB pods are present; built-in servicelb must remain disabled."
  kubectl get pods -A -o wide | grep -E '(^|[[:space:]])svclb-[^[:space:]]+' || true
  FAIL_GATE=1
else
  log_success "No K3s ServiceLB pods found."
fi

METALLB_PODS=$(kubectl get pods -n metallb-system --no-headers 2>/dev/null) || METALLB_PODS=""
if [[ "${LB_MODE}" == "nodeport" ]]; then
  if grep -q 'metallb' <<<"${METALLB_PODS}"; then
    log_error "MetalLB pods found in nodeport mode; the CSP load balancer must be the only external entry."
    FAIL_GATE=1
  else
    log_success "No MetalLB in nodeport mode."
  fi
  GW_PORTS=$(kubectl -n platform-system get svc apisix-gateway -o jsonpath='{.spec.type} {range .spec.ports[*]}{.port}:{.nodePort} {end}' 2>/dev/null || true)
  if [[ "${GW_PORTS}" == NodePort* ]] && grep -Eq '(^| )80:31080( |$)' <<<"${GW_PORTS}" && grep -Eq '(^| )443:31443( |$)' <<<"${GW_PORTS}"; then
    log_success "apisix-gateway is NodePort 80:31080 / 443:31443 for the CSP load balancer."
  else
    log_error "apisix-gateway is not NodePort 80:31080 / 443:31443 in nodeport mode (got: ${GW_PORTS:-none})."
    FAIL_GATE=1
  fi
else
  if grep -q 'metallb' <<<"${METALLB_PODS}"; then
    log_success "MetalLB is deployed for LoadBalancer services."
  else
    log_error "MetalLB pods were not found in metallb-system."
    FAIL_GATE=1
  fi
fi

# 실패는 그대로 종료 코드로 전파 — 성공 하드코딩 금지 (§7)
if [[ ${FAIL_GATE:-0} -eq 1 ]]; then
  exit 1
fi
log_success "[TEST 01] Cluster health verification passed."
