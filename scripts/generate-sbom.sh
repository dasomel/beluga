#!/usr/bin/env bash
# Beluga SBOM 생성 — 실행 중인 클러스터의 실제 컨테이너 이미지를 대상으로 한다.
#
# "Never fabricate state" (CLAUDE.md 규약 2) 원칙에 따라 VERSIONS.md의 선언값이
# 아니라 kubectl로 조회한 실배포 이미지를 스캔한다. VERSIONS.md는 여전히 라이선스
# 단일 원천이다(각 컴포넌트 행의 "라이선스" 열) — 이 스크립트는 그 선언을 대체하지
# 않고, 실제로 떠 있는 이미지의 전이 의존성(베이스 이미지 패키지 등, VERSIONS.md에는
# 없는)까지 SPDX로 남긴다. VERSIONS.md 대비 미선언 이미지 자동 검출은 아직 없다 —
# 마크다운 표에서 이미지 참조를 안정적으로 파싱하기 어려워 보류했다.
#
# 사용법:
#   bash scripts/generate-sbom.sh          # sbom/ 아래에 이미지별 SPDX JSON 생성
#   bash scripts/generate-sbom.sh --check  # 스캔 실패(pull 불가 등)가 하나라도 있으면 비정상 종료 (CI 게이트용)
#
# 요구 도구: trivy (https://trivy.dev) — 이 저장소는 이미지를 컴파일/번들하지 않으므로
# go-licenses/license-checker류가 아니라 이미지 스캐너를 쓴다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BELUGA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/logging.sh"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/common/env.sh"

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

command -v trivy >/dev/null 2>&1 || { log_error "trivy가 필요하다. https://trivy.dev/latest/getting-started/installation/"; exit 2; }
command -v kubectl >/dev/null 2>&1 || { log_error "kubectl이 필요하다."; exit 2; }

export KUBECONFIG="${KUBECONFIG:-${BELUGA_ROOT}/.kube/config}"
[[ -f "${KUBECONFIG}" ]] || { log_error "kubeconfig가 없다. 먼저 실행: bash scripts/kubeconfig.sh"; exit 1; }
kubectl get ns platform-system >/dev/null 2>&1 || { log_error "클러스터에 접속할 수 없다. bash scripts/kubeconfig.sh 로 확인."; exit 1; }

SBOM_DIR="${BELUGA_ROOT}/sbom"
mkdir -p "${SBOM_DIR}"

log_info "클러스터에서 실행 중인 컨테이너 이미지를 조회한다..."
mapfile -t IMAGES < <(
  kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.initContainers[*]}{.image}{"\n"}{end}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' \
    | sort -u
)

if [[ "${#IMAGES[@]}" -eq 0 ]]; then
  log_error "실행 중인 파드가 없다 — 클러스터가 아직 부트스트랩되지 않았을 수 있다."
  exit 1
fi

log_info "이미지 ${#IMAGES[@]}개 발견. sbom/ 아래에 SPDX JSON을 생성한다."

FAILED=0
for image in "${IMAGES[@]}"; do
  # 이미지 참조를 파일명으로 안전하게 변환 (registry/name:tag -> registry_name_tag)
  safe_name="$(echo "${image}" | tr '/:@' '___')"
  out_file="${SBOM_DIR}/${safe_name}.spdx.json"
  log_info "스캔 중: ${image}"
  if ! trivy image --quiet --format spdx-json --output "${out_file}" "${image}"; then
    log_warn "SBOM 생성 실패 (이미지를 pull할 수 없거나 스캔 오류): ${image}"
    FAILED=1
  fi
done

{
  echo "# Beluga SBOM 인덱스"
  echo
  echo "생성 시각: $(date +'%Y-%m-%dT%H:%M:%S%z')"
  echo "이미지 수: ${#IMAGES[@]}"
  echo
  echo "각 이미지의 라이선스 선언은 VERSIONS.md를 우선 참고하되, 실제 번들 패키지 목록은"
  echo "아래 개별 SPDX JSON이 정확하다 (Debian/Alpine 베이스 패키지 등 VERSIONS.md에 없는"
  echo "전이 의존성 포함)."
  echo
  for image in "${IMAGES[@]}"; do
    echo "- ${image}"
  done
} > "${SBOM_DIR}/README.md"

if [[ "${CHECK}" -eq 1 && "${FAILED}" -eq 1 ]]; then
  log_error "--check: 일부 이미지의 SBOM 생성에 실패했다."
  exit 1
fi

log_success "완료: ${SBOM_DIR}/"
