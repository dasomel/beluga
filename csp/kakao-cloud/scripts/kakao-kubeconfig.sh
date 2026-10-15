#!/usr/bin/env bash
# Kakao Cloud 클러스터 kubeconfig 를 레포 로컬 .kube/kakao-config 로 가져온다.
# 공유 ~/.kube/config 는 건드리지 않는다. K8s API(6443)는 공개하지 않으므로 kubectl 은
# bastion SSH 터널(로컬 16443 → master-1:6443) 위에서만 동작한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib-kakao.sh"

LOCAL_PORT="${KAKAO_API_LOCAL_PORT:-16443}"
OUT="${KAKAO_KUBECONFIG_OUT:-${BELUGA_ROOT}/.kube/kakao-config}"

require_cmds tofu ssh python3
load_tofu_outputs

mkdir -p "$(dirname "${OUT}")"
# k3s.yaml 은 root 만 읽을 수 있다. server 를 터널 주소로 바꿔 저장한다
# (k3s 서버 인증서 SAN 에 127.0.0.1 이 포함되어 있어 TLS 검증이 그대로 통과한다).
umask 077
ssh_host master-1 sudo cat "${REMOTE_KUBECONFIG}" \
  | sed "s#https://127.0.0.1:6443#https://127.0.0.1:${LOCAL_PORT}#" > "${OUT}"
chmod 600 "${OUT}"
log_success "kubeconfig written to ${OUT}"

log_info "1) Open the tunnel (keep it running in another terminal):"
log_info "     ssh -F ${SSH_CONFIG} -N -L ${LOCAL_PORT}:127.0.0.1:6443 master-1"
log_info "2) Then use it:"
log_info "     KUBECONFIG=${OUT} kubectl get nodes"
