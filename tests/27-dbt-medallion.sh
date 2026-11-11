#!/usr/bin/env bash
# LIVE ONLY: requires deployed Phase B identity/policies/DAG and a manually triggered run.
# This script observes the supplied run; it does not trigger writes or change pause state.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
export BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
if [[ -z "${DBT_RUN_ID:-}" ]]; then
  log_warn "SKIP: set DBT_RUN_ID to a manually triggered dbt_shop_medallion run ID (see dbt/README.md)"
  exit 0
fi
export DBT_RUN_ID
# D1: isolate even an explicitly supplied kubeconfig before querying shared infrastructure.
# Cost: one temporary file; escape hatch: regenerate the repo-local config if stale.
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "${CHECK_DIR}"' EXIT
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
log_info "[TEST 27] LIVE dbt medallion run, data path and svc-dbt PII denial..."

python3 - "${SCRIPT_DIR}/../gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py" <<'PY'
import base64
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
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
dag = next((item for item in dags if item['dag_id'] == 'dbt_shop_medallion'), None)
if dag is None:
    raise SystemExit('FAIL: dbt_shop_medallion absent; check Airflow import errors')
if str(dag['is_paused']).lower() != 'false':
    raise SystemExit('FAIL: DAG paused; unpause and manually trigger as documented')
run_id = os.environ['DBT_RUN_ID']
deadline = time.monotonic() + 900
while True:
    state = airflow('dags', 'state', 'dbt_shop_medallion', run_id).splitlines()[-1].strip()
    if state == 'success':
        break
    if state == 'failed':
        raise SystemExit('FAIL: supplied DAG run failed; inspect dbt_build logs')
    if time.monotonic() >= deadline:
        raise SystemExit('FAIL: DAG run did not succeed within 900 seconds')
    time.sleep(10)
print('PASS: DAG present, unpaused and supplied run succeeded')

# Same HTTPS/JWT /v1/statement pattern as test 07, using client_credentials
# and svc-dbt rather than a human password. Keep secrets out of argv and stdout.
ca = json.loads(kubectl('-n', 'analytics', 'get', 'configmap', 'beluga-internal-ca', '-o', 'json'))
context = ssl.create_default_context(cadata=ca['data']['ca.crt'])
secret = json.loads(kubectl('-n', 'analytics', 'get', 'secret', 'keycloak-dbt-client-secret', '-o', 'json'))
client_secret = base64.b64decode(secret['data']['dbt']).decode()
domain = os.environ['BASE_DOMAIN']
form = urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': 'dbt', 'scope': 'openid',
                              'client_secret': client_secret}).encode()
request = urllib.request.Request(
    f'https://sso.{domain}/realms/beluga/protocol/openid-connect/token', data=form,
    headers={'Content-Type': 'application/x-www-form-urlencoded'})
with urllib.request.urlopen(request, context=context, timeout=30) as response:
    token = json.load(response)['access_token']
base = f'https://trino.{domain}'
headers = {'Authorization': f'Bearer {token}', 'X-Trino-User': 'svc-dbt'}


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


for table in ('silver_shop.orders', 'gold_shop.daily_revenue'):
    rows, error = query(f'SELECT count(*) FROM iceberg.{table}')
    if error or len(rows) != 1:
        raise SystemExit(f'FAIL: {table} data query: {error}')
    if table == 'gold_shop.daily_revenue' and int(rows[0][0]) <= 0:
        raise SystemExit('FAIL: Gold row count must be positive')
    print(f'PASS: iceberg.{table} row count = {rows[0][0]}')

# D-DBT-16: derive the expected revision from the checked-in image tag, not HEAD.
# Cost: the deployed DAG must match GitOps; escape hatch: rebuild and repin the image.
pin = re.search(r'image="ghcr.io/dasomel/beluga-dbt:sha-([a-f0-9]{40})@sha256:[a-f0-9]{64}"',
                Path(sys.argv[1]).read_text())
if pin is None:
    raise SystemExit('FAIL: cannot determine the pinned dbt image git SHA')
quoted_run_id = run_id.replace("'", "''")
rows, error = query(
    'SELECT node_unique_id, resource_type, status, project_git_revision '
    'FROM iceberg.gold_shop.dbt_run_audit '
    f"WHERE orchestrator_run_id = '{quoted_run_id}'")
if error or not rows or any(row[3] != pin[1] for row in rows):
    raise SystemExit(f'FAIL: audit rows missing or image git SHA mismatch: {error}')
if not any(row[:3] == ['model.beluga.daily_revenue', 'model', 'success'] for row in rows):
    raise SystemExit('FAIL: audit has no successful Gold model for supplied run')
if not any(row[1] == 'test' and row[2] == 'pass' for row in rows):
    raise SystemExit('FAIL: audit has no passing tests for supplied run')
print(f'PASS: {len(rows)} audit rows for supplied run match pinned image git SHA {pin[1]}')
_, error = query('SELECT * FROM iceberg.lake.customers LIMIT 1')
if not error or error.get('errorName') != 'PERMISSION_DENIED':
    raise SystemExit(f'FAIL: expected PII PERMISSION_DENIED, observed {error}')
print('PASS: svc-dbt cannot select iceberg.lake.customers (PERMISSION_DENIED)')
PY
log_success "dbt medallion live checks passed."
