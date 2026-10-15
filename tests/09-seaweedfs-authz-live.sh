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
    --labels="app=${pod_label_app},beluga-test=09" \
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

# 2/4·3/4 프로브는 seaweedfs-data-plane-restrict가 허용하는 클라이언트 신원에서
# 실행한다. storage 네임스페이스는 #125부터 default-deny(Ingress+Egress)에 DNS
# 이그레스만 허용하므로 storage 파드는 S3에 닿지 못해 curl rc=28(000)이 되고,
# 이는 인가 거부가 아닌 네트워크 차단이다. 신원은 lakehouse/app=lakekeeper-bootstrap:
# `lakekeeper-bootstrap-egress`가 storage/app=seaweedfs:8333 이그레스를 허용하고
# `seaweedfs-data-plane-restrict`가 이 신원의 8333 인그레스를 허용하며, lakehouse의
# 어떤 Service도 이 라벨을 선택하지 않는다(app=apisix 등 Service가 고르는 라벨을
# 빌리면 readinessProbe 없는 프로브가 엔드포인트에 섞여 실트래픽을 받는다).
# 프로브는 8333 포트만 사용하고 "<http_code> rc=<curl 종료코드>"를 출력해
# 무응답(rc≠0)과 실제 HTTP 거부를 구분한다. 파드명은 $$로 유일화해 동시 실행과
# 충돌하지 않고, beluga-test=09 라벨로 프로브 파드임을 식별한다.
PROBE_NS=lakehouse
PROBE_APP=lakekeeper-bootstrap
NOAUTH_POD="seaweedfs-noauth-probe-$$"
INVALID_POD="seaweedfs-invalid-probe-$$"
NETPOL_POD="seaweedfs-network-probe-$$"
cleanup_probes() {
  kubectl -n "${PROBE_NS}" delete pod "${NOAUTH_POD}" "${INVALID_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n default delete pod "${NETPOL_POD}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup_probes EXIT

# 프로브 출력("<code> rc=<n>")이 HTTP 4xx 거부인지 판정한다. 무응답은 별도 메시지.
check_denied() {
  local out="$1" what="$2"
  if [[ "${out}" =~ ^(000|[0-9]{3})\ rc=([0-9]+)$ ]]; then
    local code="${BASH_REMATCH[1]}" rc="${BASH_REMATCH[2]}"
    if [[ "${rc}" != "0" || "${code}" == "000" ]]; then
      log_error "${what}: S3 응답 없음 (curl rc=${rc}, HTTP ${code}) — 허용된 클라이언트(lakehouse/app=lakekeeper-bootstrap)에서도 도달 불가: NetworkPolicy/DNS/서비스 회귀 확인 필요"
      exit 1
    fi
    if [[ "${code}" =~ ^4[0-9]{2}$ ]]; then
      return 0
    fi
    log_error "${what}: 명시적으로 거부되지 않음 (HTTP ${code})"
    exit 1
  fi
  log_error "${what}: 프로브 출력을 해석할 수 없음 (출력: ${out:-<empty>})"
  exit 1
}

log_info "2/4: 허용된 클라이언트(lakehouse/app=lakekeeper-bootstrap)에서도 무자격 요청은 거부돼야 한다..."
NOAUTH_OUT=$(run_probe "${PROBE_NS}" "${NOAUTH_POD}" "${PROBE_APP}" \
  'curl -s -o /dev/null --max-time 10 -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1; echo " rc=$?"')
check_denied "${NOAUTH_OUT}" "무자격 S3 요청"
log_success "무자격 요청 거부 확인 (${NOAUTH_OUT%% *})."

log_info "3/4: 가짜 자격 요청은 거부되고, 무관한 네임스페이스는 포트 자체가 차단돼야 한다..."
INVALID_OUT=$(run_probe "${PROBE_NS}" "${INVALID_POD}" "${PROBE_APP}" '
printf "machine seaweedfs-s3.storage.svc.cluster.local\nlogin invalid\npassword invalid\n" > /tmp/s3.netrc
curl -s -o /dev/null --max-time 10 --netrc-file /tmp/s3.netrc --aws-sigv4 "aws:amz:us-east-1:s3" \
  -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake?max-keys=1; echo " rc=$?"
')
check_denied "${INVALID_OUT}" "가짜 자격 S3 요청"

NP_OUT=$(run_probe default "${NETPOL_POD}" default \
  'curl -s -o /dev/null --max-time 8 -w "%{http_code}" http://seaweedfs-s3.storage.svc.cluster.local:8333/beluga-lake')
if [[ "${NP_OUT}" != "000" ]]; then
  log_error "default 네임스페이스에서 SeaweedFS S3에 연결됨(NetworkPolicy가 차단하면 000이어야 함) — 미집행 가능성 (HTTP ${NP_OUT})"
  exit 1
fi
log_success "가짜 자격 거부(HTTP ${INVALID_OUT%% *}) 및 default 네임스페이스 차단 확인."

log_info "4/4: 버킷 권한이 지정된 버킷으로만 한정돼 있는지 확인..."
IDENTITIES_JSON=$(kubectl -n storage get configmap seaweedfs-s3-identities-template -o jsonpath='{.data.identities\.json}')
if echo "${IDENTITIES_JSON}" | grep -Eq '"(Read|Write|List|Tagging|Admin)"(,|])'; then
  log_error "버킷 미지정 글로벌 액션이 발견됨"
  exit 1
fi
if ! echo "${IDENTITIES_JSON}" | grep -q 'Admin:beluga-lake'; then
  log_error "lakekeeper admin 버킷 스코프가 누락됨"
  exit 1
fi
# Admin은 정확히 두 스코프만 허용: beluga-lake(lakekeeper) + beluga-postgres-backups
# (postgres-backup-provisioner, 이슈 #5 — 해당 버킷 전체 제어(읽기·쓰기·삭제 포함), 단명 훅 Job 전용 Secret).
if echo "${IDENTITIES_JSON}" | grep -Eo 'Admin:[^"]+' | grep -Fvx -e 'Admin:beluga-lake' -e 'Admin:beluga-postgres-backups' | grep -q .; then
  log_error "예상 밖 Admin 버킷 스코프가 발견됨"
  exit 1
fi
if ! echo "${IDENTITIES_JSON}" | grep -q 'Read:beluga-lake'; then
  log_error "beluga-lake read 스코프가 누락됨"
  exit 1
fi
log_success "SeaweedFS identity action이 beluga-lake 버킷으로만 제한됨."

log_success "[TEST 09] SeaweedFS S3 인증/인가 및 네트워크 제한 검증 통과."
