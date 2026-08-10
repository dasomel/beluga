#!/usr/bin/env bash
# Beluga kubeconfig 설정 — 호스트에서 kubectl로 클러스터에 접근할 수 있게 한다.
#
# 사용법:
#   bash scripts/kubeconfig.sh           # 리포 로컬 .kube/config 생성 + 사용법 출력
#   bash scripts/kubeconfig.sh --merge   # 추가로 ~/.kube/config 에 'beluga' 컨텍스트로 병합
#
# k3s가 master-1에 만든 admin kubeconfig를 가져와 server 주소를 노드 IP로 바꾼다.
# (원본은 127.0.0.1을 가리켜 호스트에서 그대로 쓰면 접속되지 않는다)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/env.sh"

MERGE=0
[[ "${1:-}" == "--merge" ]] && MERGE=1

KUBE_DIR="${BELUGA_ROOT}/.kube"
KUBE_FILE="${KUBE_DIR}/config"
CONTEXT_NAME="beluga"

command -v kubectl >/dev/null || { log_error "kubectl이 없다. brew install kubectl 후 다시 실행."; exit 1; }

log_info "master-1(${MASTER_IP})에서 kubeconfig 가져오는 중..."
mkdir -p "${KUBE_DIR}"
cd "${BELUGA_ROOT}"

RAW="$(vagrant ssh master-1 -c "sudo cat /etc/rancher/k3s/k3s.yaml" 2>/dev/null)"
[[ -n "${RAW}" ]] || { log_error "kubeconfig를 가져오지 못했다. 'vagrant status'로 master-1이 running인지 확인."; exit 1; }

# 127.0.0.1 → 노드 IP, 컨텍스트/클러스터/유저 이름을 beluga로 (다른 클러스터와 병합해도 충돌 없게)
printf '%s\n' "${RAW}" \
  | sed "s|https://127.0.0.1:6443|https://${MASTER_IP}:6443|g" \
  | sed "s|: default$|: ${CONTEXT_NAME}|g; s|name: default|name: ${CONTEXT_NAME}|g; s|cluster: default|cluster: ${CONTEXT_NAME}|g; s|user: default|user: ${CONTEXT_NAME}|g" \
  > "${KUBE_FILE}"
chmod 600 "${KUBE_FILE}"

log_info "접속 검증 중..."
if ! KUBECONFIG="${KUBE_FILE}" kubectl get nodes >/dev/null 2>&1; then
  log_error "kubeconfig는 생성됐으나 API 서버에 접속하지 못했다:"
  KUBECONFIG="${KUBE_FILE}" kubectl get nodes 2>&1 | head -3
  exit 1
fi
KUBECONFIG="${KUBE_FILE}" kubectl get nodes

if [[ ${MERGE} -eq 1 ]]; then
  log_info "${HOME}/.kube/config 에 '${CONTEXT_NAME}' 컨텍스트로 병합 중..."
  mkdir -p "${HOME}/.kube"
  [[ -f "${HOME}/.kube/config" ]] && cp "${HOME}/.kube/config" "${HOME}/.kube/config.bak.$(date +%s)"
  MERGED="$(KUBECONFIG="${HOME}/.kube/config:${KUBE_FILE}" kubectl config view --flatten)"
  printf '%s\n' "${MERGED}" > "${HOME}/.kube/config"
  chmod 600 "${HOME}/.kube/config"
  log_success "병합 완료 (기존 파일은 ~/.kube/config.bak.* 로 백업)."
  log_info "사용:  kubectl config use-context ${CONTEXT_NAME}"
fi

log_success "=========================================================="
log_success " kubectl 접근 준비 완료"
log_success "=========================================================="
log_info "이 셸에서 바로 쓰기:"
log_info "  export KUBECONFIG=${KUBE_FILE}"
log_info "  kubectl get pods -A"
log_info ""
log_info "전역으로 쓰려면:  bash scripts/kubeconfig.sh --merge"
