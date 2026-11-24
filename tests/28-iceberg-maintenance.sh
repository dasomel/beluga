#!/usr/bin/env bash
# LIVE ONLY: requires deployed maintenance identity/policies/DAG and a manually triggered run.
# This script observes the supplied run; it does not trigger writes or change pause state.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
if [[ -z "${MAINT_RUN_ID:-}" ]]; then
  log_warn "SKIP: set MAINT_RUN_ID to a manually triggered iceberg_table_maintenance run ID (see docs/adr/0008-iceberg-maintenance-service-identity.md)"
  exit 0
fi
export MAINT_RUN_ID
# D1: isolate even an explicitly supplied kubeconfig before querying shared infrastructure.
# Cost: one temporary file; escape hatch: regenerate the repo-local config if stale.
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "${CHECK_DIR}"' EXIT
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
log_info "[TEST 28] LIVE maintenance run and svc-maintenance SELECT denial..."

python3 - <<'PY'
import base64
import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


def kubectl(*args):
    return subprocess.check_output(['kubectl', *args], text=True)


def airflow(*args):
    out = kubectl('-n', 'orchestration', 'exec', 'deployment/airflow-webserver',
                  '-c', 'airflow', '--', 'airflow', *args)
    # Airflow 3 CLI also writes structlog lines ("<ISO>Z [info] ...") to stdout.
    lines = [l for l in out.splitlines() if not re.match(r'^\d{4}-\d{2}-\d{2}T\S+Z \[', l)]
    return '\n'.join(lines).strip()


# Fail on import/list errors rather than interpreting a missing DAG as success.
dags = json.loads(airflow('dags', 'list', '-o', 'json'))
dag = next((item for item in dags if item['dag_id'] == 'iceberg_table_maintenance'), None)
if dag is None:
    raise SystemExit('FAIL: iceberg_table_maintenance absent; check Airflow import errors')
if str(dag['is_paused']).lower() != 'false':
    raise SystemExit('FAIL: DAG paused; unpause and manually trigger as documented')
run_id = os.environ['MAINT_RUN_ID']
deadline = time.monotonic() + 900
while True:
    state = airflow('dags', 'state', 'iceberg_table_maintenance', run_id).splitlines()[-1].strip()
    if state == 'success':
        break
    if state == 'failed':
        raise SystemExit('FAIL: supplied DAG run failed; inspect iceberg_maintenance logs')
    if time.monotonic() >= deadline:
        raise SystemExit('FAIL: DAG run did not succeed within 900 seconds')
    time.sleep(10)
print('PASS: DAG present, unpaused and supplied run succeeded')

# Same HTTPS/JWT /v1/statement pattern as test 07, using client_credentials
# and svc-maintenance rather than a human password. Keep secrets out of argv and stdout.
ca = json.loads(kubectl('-n', 'analytics', 'get', 'configmap', 'beluga-internal-ca', '-o', 'json'))
context = ssl.create_default_context(cadata=ca['data']['ca.crt'])
secret = json.loads(kubectl('-n', 'analytics', 'get', 'secret', 'keycloak-maintenance-client-secret', '-o', 'json'))
client_secret = base64.b64decode(secret['data']['maintenance']).decode()
domain = os.environ['BASE_DOMAIN']
form = urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': 'maintenance', 'scope': 'openid',
                              'client_secret': client_secret}).encode()
request = urllib.request.Request(
    f'https://sso.{domain}/realms/beluga/protocol/openid-connect/token', data=form,
    headers={'Content-Type': 'application/x-www-form-urlencoded'})
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    token = json.load(response)['access_token']
base = f'https://trino.{domain}'
headers = {'Authorization': f'Bearer {token}', 'X-Trino-User': 'svc-maintenance'}


def query(sql):
    request = urllib.request.Request(base + '/v1/statement', data=sql.encode(), headers=headers)
    rows = []
    deadline = time.monotonic() + 120
    while True:
        with urllib.request.urlopen(request, context=context, timeout=30) as response:
            page = json.load(response)
        rows.extend(page.get('data') or [])
        if page.get('error'):
            return rows, page['error']
        if not page.get('nextUri'):
            return rows, None
        if time.monotonic() >= deadline:
            raise SystemExit('FAIL: Trino query exceeded 120 seconds')
        # Route coordinator nextUri paths through the same trusted gateway origin.
        path = urllib.parse.urlsplit(page['nextUri'])
        request = urllib.request.Request(base + path.path + ('?' + path.query if path.query else ''),
                                         headers=headers)


_, error = query('SELECT * FROM iceberg.lake.orders LIMIT 1')
if not error or error.get('errorName') != 'PERMISSION_DENIED':
    raise SystemExit(f'FAIL: expected SELECT PERMISSION_DENIED, observed {error}')
print('PASS: svc-maintenance cannot select iceberg.lake.orders (PERMISSION_DENIED)')
PY
log_success "Iceberg maintenance live checks passed."
