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
from live_checks import data_rows, internal_query
rows = internal_query('SELECT status FROM iceberg.lake.orders LIMIT 1')
data_rows(rows)
print('PASS: Trino read a sane Iceberg orders status row (data path)')
PYTHON
