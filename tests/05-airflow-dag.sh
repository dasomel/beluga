#!/usr/bin/env bash
# LIVE ONLY, read-only: verify deployed data/DAG behavior, not pod phase.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# D-PIPE-3: isolate caller config before all live operations.
# Cost: temporary file; escape hatch: regenerate the repo-local kubeconfig.
CHECK_DIR="$(mktemp -d)"
chmod 700 "${CHECK_DIR}"
trap 'rm -rf "${CHECK_DIR}"' EXIT
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten --raw > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
export PYTHONPATH="${SCRIPT_DIR}/../scripts/common${PYTHONPATH:+:${PYTHONPATH}}"
python3 - <<'PYTHON'
import json
from live_checks import airflow, require_dags
require_dags(json.loads(airflow('dags', 'list', '-o', 'json')),
             json.loads(airflow('dags', 'list-import-errors', '-o', 'json')))
print('PASS: both shipped DAGs loaded without import errors; pause state unchanged')
PYTHON
