#!/usr/bin/env bash
# Beluga Complete Test Suite Runner

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

log_info "=========================================================="
log_info " Running Beluga Data Platform Test Suite"
log_info "=========================================================="

bash "${SCRIPT_DIR}/01-cluster-health.sh"
bash "${SCRIPT_DIR}/02-ingest-cdc.sh"
bash "${SCRIPT_DIR}/03-stream-iceberg.sh"
bash "${SCRIPT_DIR}/04-trino-query.sh"
bash "${SCRIPT_DIR}/05-airflow-dag.sh"
bash "${SCRIPT_DIR}/07-trino-authz-live.sh"
bash "${SCRIPT_DIR}/08-apisix-admin-restrict.sh"

log_success "=========================================================="
log_success " All Beluga E2E Test Suite Executed Successfully!"
log_success "=========================================================="
