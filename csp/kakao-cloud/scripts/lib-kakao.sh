#!/usr/bin/env bash
# Kakao Cloud 스크립트 공용 헬퍼 — `source` 해서 쓴다 (kakao-up.sh, kakao-kubeconfig.sh).
# `tofu output -json` 을 읽어 SSH 설정을 만들고, bastion 을 거쳐 노드에 명령을 보내는 함수를 제공한다.
# 자격증명·상태 파일은 읽지 않는다: 출력 값(IP, 키 경로)만 쓴다.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSP_DIR="$(cd "${LIB_DIR}/.." && pwd)"
BELUGA_ROOT="$(cd "${CSP_DIR}/../.." && pwd)"
TF_DIR="${TF_DIR:-${CSP_DIR}/terraform}"

# shellcheck source=/dev/null
source "${BELUGA_ROOT}/scripts/common/logging.sh"

# shellcheck disable=SC2034  # source 하는 스크립트가 사용
# 원격 노드에서 BELUGA_SRC (Vagrant 의 /vagrant 대응). 02-k8s-init.sh 가 .kube/node-token 을 여기에 쓴다.
REMOTE_SRC="/opt/beluga"
# k3s 서버 kubeconfig — sudo 환경에서 HOME 이 달라도 kubectl/helm 이 같은 파일을 쓰도록 명시한다.
REMOTE_KUBECONFIG="/etc/rancher/k3s/k3s.yaml"

require_cmds() {
  local missing=0 cmd
  for cmd in "$@"; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      log_error "required command not found: ${cmd}"
      missing=1
    fi
  done
  [[ ${missing} -eq 0 ]] || exit 1
}

# tofu output -json → 셸 변수. python3 로 파싱한다(jq 의존 회피).
load_tofu_outputs() {
  local json
  if ! json="$(tofu -chdir="${TF_DIR}" output -json)"; then
    log_error "tofu output failed — run 'tofu -chdir=${TF_DIR} apply' first"
    exit 1
  fi
  local parsed
  parsed="$(python3 -I -c '
import json, shlex, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
need = ["bastion_public_ip", "bastion_private_ip", "nlb_public_ip", "master_private_ip",
        "worker_private_ips", "proxy_url", "apisix_cluster_ip", "base_domain", "ssh_config"]
missing = [k for k in need if k not in o or o[k] in (None, "", [])]
if missing:
    sys.exit("missing tofu outputs: " + ", ".join(missing))
print("BASTION_PUBLIC_IP=" + shlex.quote(o["bastion_public_ip"]))
print("BASTION_PRIVATE_IP=" + shlex.quote(o["bastion_private_ip"]))
print("NLB_PUBLIC_IP=" + shlex.quote(o["nlb_public_ip"]))
print("MASTER_IP=" + shlex.quote(o["master_private_ip"]))
print("PROXY_URL=" + shlex.quote(o["proxy_url"]))
print("APISIX_CLUSTER_IP=" + shlex.quote(o["apisix_cluster_ip"]))
print("BASE_DOMAIN=" + shlex.quote(o["base_domain"]))
print("WORKER_COUNT=" + str(len(o["worker_private_ips"])))
print("SSH_CONFIG_TEXT=" + shlex.quote(o["ssh_config"]))
' <<< "${json}")" || exit 1
  eval "${parsed}"

  # 키 디렉터리(generated/)는 terraform 이 만든다. ssh_config 는 그 옆에 둔다.
  GENERATED_DIR="${TF_DIR}/generated"
  SSH_CONFIG="${GENERATED_DIR}/ssh_config"
  mkdir -p "${GENERATED_DIR}"
  printf '%s\n' "${SSH_CONFIG_TEXT}" > "${SSH_CONFIG}"
  chmod 600 "${SSH_CONFIG}"
  # 노드 호스트 별칭: master-1, worker-1..N (ssh_config 의 Host 블록과 같다)
  NODES=(master-1)
  local i
  for ((i = 1; i <= WORKER_COUNT; i++)); do
    NODES+=("worker-${i}")
  done
  export BASTION_PUBLIC_IP BASTION_PRIVATE_IP NLB_PUBLIC_IP MASTER_IP PROXY_URL APISIX_CLUSTER_IP BASE_DOMAIN
}

# ssh_host <alias> <command...> — bastion 경유(ProxyCommand) 원격 실행. 호스트 키가 바뀌면 실패한다(fail closed).
ssh_host() {
  local host="$1"
  shift
  ssh -F "${SSH_CONFIG}" -o BatchMode=yes -o ConnectTimeout=10 "${host}" "$@"
}

# remote_root <alias> [VAR=val ...] <command...> — 원격에서 sudo env 로 환경 변수를 넘겨 실행.
# sudo 는 env_reset 으로 호출자 환경을 지우므로 필요한 값은 반드시 이렇게 명시한다.
# ssh 는 인자를 공백으로 이어 원격 셸에 넘기므로(UPSTREAM_DNS="a b" 같은 값이 쪼개진다) printf %q 로 인용한다.
remote_root() {
  local host="$1" cmd
  shift
  cmd="$(printf '%q ' sudo env "KUBECONFIG=${REMOTE_KUBECONFIG}" "$@")"
  ssh_host "${host}" "${cmd}"
}

wait_for_ssh() {
  local host="$1" tries="${2:-60}" n=0
  until ssh_host "${host}" true 2>/dev/null; do
    n=$((n + 1))
    if [[ ${n} -ge ${tries} ]]; then
      log_error "ssh to ${host} did not become ready after ${tries} attempts"
      return 1
    fi
    sleep 10
  done
}
