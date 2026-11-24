#!/usr/bin/env bash
# LIVE ONLY, mutating: explicit opt-in follows the env-gated tests 27/28 convention.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
if [[ "${PIPELINE_E2E:-}" != "1" ]]; then
  log_warn "SKIP: set PIPELINE_E2E=1 to INSERT/UPDATE/DELETE one demo shop order"
  exit 0
fi
CHECK_DIR="$(mktemp -d)"
chmod 700 "${CHECK_DIR}"
CHILD_PID=""
cleanup() {
  if [[ -n "${CHILD_PID}" ]]; then
    wait "${CHILD_PID}" || true
  fi
  rm -rf "${CHECK_DIR}"
}
terminate() {
  if [[ -n "${CHILD_PID}" ]]; then
    kill -TERM "${CHILD_PID}" 2>/dev/null || true
  fi
  exit 143
}
# D-PIPE-8: keep credentials until the child finishes its source cleanup.
# Cost: wait on termination; escape: operator cleanup if the child is killed forcibly.
trap cleanup EXIT
trap terminate TERM INT
# D-PIPE-3: isolate even an explicitly supplied config before accessing the cluster.
# Cost: temporary file; escape hatch: regenerate the repo-local kubeconfig.
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten --raw > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
export PYTHONPATH="${SCRIPT_DIR}/../scripts/common${PYTHONPATH:+:${PYTHONPATH}}"
python3 "${SCRIPT_DIR}/../scripts/ops/pipeline_e2e.py" &
CHILD_PID=$!
wait "${CHILD_PID}"
