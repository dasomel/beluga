#!/usr/bin/env bash
# SeaweedFS S3 authz/authn 라이브 회귀 검증 (이슈 #7)
#
# 이 스크립트는 3가지를 확인한다:
# 1) 허용된 네임스페이스에서도 무자격/가짜 자격 요청은 2xx로 통과하지 않는다.
# 2) 무관한 네임스페이스는 NetworkPolicy 때문에 S3/filer 포트에 도달하지 못한다.
# 3) 버킷 권한은 beluga-lake에만 한정돼 있고 글로벌/타 버킷 액션은 선언되지 않았다.
#
# 수정: `kubectl run --rm -i`는 --rm이 파드를 즉시 정리하며 출력하는
# "pod ... deleted" 메시지가 캡처한 변수에 섞여 들어갈 수 있다(라이브 실측 —
# 클러스터 부하가 있을 때 재현). 정적 Pod(레이블 지정) + kubectl logs 패턴으로
# 대체해 출력 캡처와 파드 생명주기를 분리한다.
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

# 정적 Pod로 curl 스크립트를 실행하고 완료를 기다린 뒤 로그만 읽는다 — 삭제는
# 별도 단계라 출력에 섞이지 않는다.
run_probe() {
  local pod_ns="$1" pod_name="$2" pod_label_app="$3" script="$4"
  kubectl -n "${pod_ns}" delete pod "${pod_name}" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "${pod_ns}" run "${pod_name}" --restart=Never \
    --image=curlimages/curl:8.21.0 \
    --labels="app=${pod_label_app}" \
    --command -- sh -c "${script}" >/dev/null
  for _ in $(seq 1 20); do
    local phase
    phase=$(kubectl -n "${pod_ns}" get pod "${pod_name}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [[ "${phase}" == "Succeeded" || "${phase}" == "Failed" ]]; then
      break
    fi
    sleep 2
  done
  kubectl -n "${pod_ns}" logs "${pod_name}" 2>/dev/null || true
  kubectl -n "${pod_ns}" delete pod "${pod_name}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

log_info "2/4: 허용된 네임스페이스(storage)에서도 무자격 요청은 거부돼야 한다..."
NOAUTH_OUT=$(run_probe storage seaweedfs-noauth-probe seaweedfs \
  'curl -s -o /dev/null --max-time 10 -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1 || echo 000')
if [[ ! "${NOAUTH_OUT}" =~ ^4[0-9]{2}$ ]]; then
  log_error "무자격 S3 요청이 명시적으로 거부되지 않음 (출력: ${NOAUTH_OUT})"
  exit 1
fi
log_success "무자격 요청 거부 확인 (HTTP ${NOAUTH_OUT})."

log_info "3/4: 가짜 자격 요청은 거부되고, 무관한 네임스페이스는 포트 자체가 차단돼야 한다..."
INVALID_OUT=$(run_probe storage seaweedfs-invalid-probe seaweedfs '
printf "machine seaweedfs-s3.storage.svc.cluster.local\nlogin invalid\npassword invalid\n" > /tmp/s3.netrc
curl -s -o /dev/null --max-time 10 --netrc-file /tmp/s3.netrc --aws-sigv4 "aws:amz:us-east-1:s3" \
  -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1 || echo 000
')
if [[ ! "${INVALID_OUT}" =~ ^4[0-9]{2}$ ]]; then
  log_error "가짜 자격 S3 요청이 명시적으로 거부되지 않음 (출력: ${INVALID_OUT})"
  exit 1
fi

NP_OUT=$(run_probe default seaweedfs-network-probe default \
  'curl -s -o /dev/null --max-time 8 -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake')
if [[ "${NP_OUT}" != "000" ]]; then
  log_error "default 네임스페이스에서 SeaweedFS S3에 연결됨(NetworkPolicy가 차단하면 000이어야 함) — 미집행 가능성 (HTTP ${NP_OUT})"
  exit 1
fi
log_success "가짜 자격 거부(HTTP ${INVALID_OUT}) 및 default 네임스페이스 차단 확인."

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
