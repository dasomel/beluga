#!/usr/bin/env bash
# LIVE ONLY, read-only: Ready status, port-forward, HTTP queries; no test alerts/writes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
# D-ALERT-11: isolate repo/caller kubeconfig as test 29 does. Cost: temp file;
# escape hatch: regenerate repo config. Never use the shared current-context.
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "${CHECK_DIR}"' EXIT
chmod 700 "${CHECK_DIR}"
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
log_info "[TEST 31] LIVE alerting readiness, scrape coverage, Watchdog and evaluation..."
python3 - <<'PY'
import contextlib
import datetime
import json
import math
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request


def kubectl(*args):
    return json.loads(subprocess.check_output(
        ['kubectl', '--request-timeout=30s', *args], text=True, timeout=60))


def require(ok, message):
    if not ok:
        raise ValueError(message)


@contextlib.contextmanager
def forward(service, port):
    # D-ALERT-12: ephemeral local ports avoid concurrent workers' collisions.
    # Cost: three short-lived forwards; escape hatch: query from an existing authorized pod.
    with tempfile.TemporaryFile(mode='w+') as log:
        proc = subprocess.Popen(['kubectl', '-n', 'platform-system', 'port-forward',
                                 '--address=127.0.0.1', f'svc/{service}', f':{port}'],
                                stdout=log, stderr=log, text=True)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                log.seek(0)
                match = re.search(r'Forwarding from 127\.0\.0\.1:(\d+)', log.read())
                if match:
                    yield f'http://127.0.0.1:{match[1]}'
                    return
                require(proc.poll() is None, f'{service}: port-forward exited')
                time.sleep(0.2)
            raise ValueError(f'{service}: port-forward timeout')
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=20) as response:
        return json.load(response)


def query(base, expr, hint=''):
    # VM query API is unprotected by design (observability.yaml); admin auth-key is
    # needed only for management endpoints. Never fetch/print that Secret here.
    result = get(base, '/api/v1/query?' + urllib.parse.urlencode({'query': expr}))
    require(result.get('status') == 'success', 'VM query failed')
    values = result['data']['result']
    require(bool(values), 'VM query returned no series: ' + expr + '; ' + hint)
    require(all(math.isfinite(float(v['value'][1])) for v in values), 'non-finite sample')
    return values


def check():
    for app in ('victoria-metrics', 'vmalert', 'alertmanager'):
        pods = kubectl('-n', 'platform-system', 'get', 'pods', '-l', f'app={app}', '-o', 'json')['items']
        require(bool(pods), f'{app}: no pods')
        for pod in pods:
            conditions = pod.get('status', {}).get('conditions', [])
            require(not pod['metadata'].get('deletionTimestamp') and
                    any(c['type'] == 'Ready' and c['status'] == 'True' for c in conditions),
                    f'{app}: pod not Ready')
        print(f'PASS Ready: {app} ({len(pods)} pods)')
    nodes = {n['metadata']['name'] for n in kubectl('get', 'nodes', '-o', 'json')['items']}
    require(bool(nodes), 'no nodes')
    with forward('victoria-metrics', 8428) as vm, forward('vmalert', 8880) as va, forward('alertmanager', 9093) as am:
        kubelet_hint = 'check CiliumNetworkPolicy/victoria-metrics-entity-egress, API discovery, kubelet TLS/RBAC'
        healthy = query(vm, 'up{job=~"kubelet.*"} == 1', kubelet_hint)
        for job in ('kubelet', 'kubelet-cadvisor', 'kubelet-resource'):
            values = query(vm, f'up{{job="{job}"}}', kubelet_hint)
            require({v['metric'].get('node') for v in values} == nodes,
                    f'{job}: node discovery gap; {kubelet_hint}')
            require(all(float(v['value'][1]) == 1 for v in values) and
                    {v['metric'].get('node') for v in healthy if v['metric'].get('job') == job} == nodes,
                    f'{job}: scrape down; {kubelet_hint}')
            print(f'PASS up==1: {job} ({len(values)} targets)')
        cnpg_hint = 'check CiliumNetworkPolicy/victoria-metrics-entity-egress (API SD) and manager-db-ingress (VM TCP 9187)'
        values = query(vm, 'up{job="cnpg"}', cnpg_hint)
        healthy = query(vm, 'up{job="cnpg"} == 1', cnpg_hint)
        require(all(float(v['value'][1]) == 1 for v in values), f'cnpg scrape down; {cnpg_hint}')
        require({v['metric'].get('cluster') for v in values} == {'postgres-main', 'manager-db'},
                f'CNPG cluster gap; {cnpg_hint}')
        for ns, cluster in (('database', 'postgres-main'), ('platform-system', 'manager-db')):
            expected = {p['metadata']['name'] for p in kubectl('-n', ns, 'get', 'pods', '-l',
                        f'cnpg.io/cluster={cluster}', '-o', 'json')['items'] if not p['metadata'].get('deletionTimestamp')}
            require(expected and expected == {v['metric'].get('pod') for v in healthy
                                              if v['metric'].get('namespace') == ns and
                                              v['metric'].get('cluster') == cluster},
                    f'{ns}/{cluster}: expected every CNPG pod up == 1; {cnpg_hint}')
            print(f'PASS up==1: cnpg {ns}/{cluster} ({len(expected)} targets)')
        for expr in ('container_fs_usage_bytes{job="kubelet-cadvisor",id="/",device="/dev/root"}',
                     'container_fs_limit_bytes{job="kubelet-cadvisor",id="/",device="/dev/root"} > 0',
                     'kubelet_volume_stats_available_bytes{job="kubelet"}',
                     'kubelet_volume_stats_capacity_bytes{job="kubelet"} > 0',
                     'cnpg_pg_replication_slots_pg_wal_lsn_diff{job="cnpg",slot_name="beluga_shop_slot"}'):
            samples = query(vm, expr)
            if expr.startswith('container_fs_'):
                require({v['metric'].get('node') for v in samples} == nodes,
                        'root filesystem metric missing on a node (up alone is insufficient)')
        print('PASS filesystem series on every node and beluga_shop_slot metric present')
        groups = get(va, '/api/v1/rules')['data']['groups']
        require({g['name'] for g in groups} == {'storage', 'cdc-wal', 'pipeline'}, 'rule groups missing')
        rules = [r for g in groups for r in g['rules']]
        require(len(rules) == 11, 'expected 11 rules')
        for rule in rules:
            require(rule.get('health') == 'ok' and not rule.get('lastError'), 'rule evaluation error')
            evaluated = datetime.datetime.fromisoformat(rule['lastEvaluation'].replace('Z', '+00:00'))
            age = (datetime.datetime.now(datetime.timezone.utc) - evaluated).total_seconds()
            require(0 <= age < 180, 'rule evaluation stale/uninitialized')
        firing = get(va, '/api/v1/alerts')['data']['alerts']
        require(any(a['labels'].get('alertname') == 'Watchdog' and a.get('state') == 'firing'
                    for a in firing), 'Watchdog not firing in vmalert (wait at least 1m after startup)')
        received = get(am, '/api/v2/alerts')
        require(any(a['labels'].get('alertname') == 'Watchdog' and a['status']['state'] in
                    ('active', 'suppressed') for a in received), 'Watchdog absent from Alertmanager')
        print('PASS 3 groups/11 healthy evaluated rules; Watchdog firing and delivered to Alertmanager')


try:
    check()
except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
    # No response bodies/Secret values in diagnostics.
    raise SystemExit(f'FAIL alerting pipeline: {type(exc).__name__}: {exc}') from None
PY
