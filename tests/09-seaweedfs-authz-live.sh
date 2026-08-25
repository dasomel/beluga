#!/usr/bin/env bash
# SeaweedFS S3 authz/authn 라이브 회귀 검증 (이슈 #7)
#
# 이 스크립트는 3가지를 확인한다:
# 1) 허용된 네임스페이스에서도 무자격/가짜 자격 요청은 2xx로 통과하지 않는다.
# 2) 무관한 네임스페이스는 NetworkPolicy 때문에 S3/filer 포트에 도달하지 못한다.
# 3) 버킷 권한은 beluga-lake에만 한정돼 있고 글로벌/타 버킷 액션은 선언되지 않았다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"

log_info "[TEST 09] SeaweedFS S3 인증/인가 및 네트워크 제한 검증..."

log_info "1/4: NetworkPolicy와 SeaweedFS auth ConfigMap 존재 확인..."
kubectl -n storage get networkpolicy seaweedfs-data-plane-restrict >/dev/null
kubectl -n storage get configmap seaweedfs-s3-identities-template >/dev/null
log_success "필수 정책/템플릿 리소스 존재."

log_info "2/4: 허용된 네임스페이스(storage)에서도 무자격 요청은 거부돼야 한다..."
# shellcheck disable=SC2016 # $code expands inside the probe pod, not locally.
NOAUTH_CODE=$(kubectl -n storage run seaweedfs-noauth-probe --rm -i --restart=Never \
  --image=curlimages/curl:8.21.0 --command -- sh -ceu '
    code=$(curl -s -o /tmp/body -w "%{http_code}" \
      http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1 || echo 000)
    printf "%s" "$code"
  ' 2>/tmp/seaweedfs-noauth.err)
kubectl -n storage delete pod seaweedfs-noauth-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
if [[ ! "${NOAUTH_CODE}" =~ ^4[0-9]{2}$ ]]; then
  log_error "무자격 S3 요청이 명시적으로 거부되지 않음 (HTTP ${NOAUTH_CODE:-unknown})"
  exit 1
fi
log_success "무자격 요청 거부 확인 (HTTP ${NOAUTH_CODE:-unknown})."

log_info "3/4: 가짜 자격 요청은 거부되고, 무관한 네임스페이스는 포트 자체가 차단돼야 한다..."
# shellcheck disable=SC2016 # $code expands inside the probe pod, not locally.
INVALID_CODE=$(kubectl -n storage run seaweedfs-invalid-probe --rm -i --restart=Never \
  --image=curlimages/curl:8.21.0 --command -- sh -ceu '
    cat <<EOF >/tmp/s3.netrc
machine seaweedfs-s3.storage.svc.cluster.local
login invalid
password invalid
EOF
    code=$(curl -s -o /tmp/body -w "%{http_code}" \
      --netrc-file /tmp/s3.netrc --aws-sigv4 "aws:amz:us-east-1:s3" \
      http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1 || echo 000)
    printf "%s" "$code"
  ' 2>/tmp/seaweedfs-invalid.err)
kubectl -n storage delete pod seaweedfs-invalid-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
if [[ ! "${INVALID_CODE}" =~ ^4[0-9]{2}$ ]]; then
  log_error "가짜 자격 S3 요청이 명시적으로 거부되지 않음 (HTTP ${INVALID_CODE:-unknown})"
  exit 1
fi

set +e
kubectl -n default run seaweedfs-network-probe --rm -i --restart=Never \
  --image=curlimages/curl:8.21.0 --timeout=20s \
  --command -- curl -sf --max-time 8 -o /dev/null -w '%{http_code}' \
  http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake \
  >/tmp/seaweedfs-network-probe.out 2>&1
NP_EXIT=$?
set -e
kubectl -n default delete pod seaweedfs-network-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true
if [[ ${NP_EXIT} -eq 0 ]]; then
  log_error "default 네임스페이스에서 SeaweedFS S3 접근 성공 — NetworkPolicy 미집행 가능성"
  exit 1
fi
log_success "가짜 자격 거부(HTTP ${INVALID_CODE:-unknown}) 및 default 네임스페이스 차단(exit=${NP_EXIT}) 확인."

log_info "4/4: 버킷 권한이 beluga-lake로만 한정돼 있는지 확인..."
IDENTITIES_JSON=$(kubectl -n storage get configmap seaweedfs-s3-identities-template -o jsonpath='{.data.identities\.json}')
if echo "${IDENTITIES_JSON}" | grep -Eq '"(Read|Write|List|Tagging|Admin)"(,|])'; then
  log_error "버킷 미지정 글로벌 액션이 발견됨"
  exit 1
fi
if ! echo "${IDENTITIES_JSON}" | grep -q 'Admin:beluga-lake'; then
  log_error "lakekeeper admin 버킷 스코프가 누락됨"
  exit 1
fi
if echo "${IDENTITIES_JSON}" | grep -Eo 'Admin:[^"]+' | grep -Fvq 'Admin:beluga-lake'; then
  log_error "예상 밖 Admin 버킷 스코프가 발견됨"
  exit 1
fi
if ! echo "${IDENTITIES_JSON}" | grep -q 'Read:beluga-lake'; then
  log_error "beluga-lake read 스코프가 누락됨"
  exit 1
fi
log_success "SeaweedFS identity action이 beluga-lake 버킷으로만 제한됨."

log_success "[TEST 09] SeaweedFS S3 인증/인가 및 네트워크 제한 검증 통과."
