#!/usr/bin/env bash
# LIVE ONLY, read-only: connector GET, logs du, SQL SELECT, kubelet stats/summary GET.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"

# D-WAL-6: isolate the caller/repo config; never trust shared current-context.
# Cost: one temporary file; escape hatch: regenerate the repo-local config.
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "${CHECK_DIR}"' EXIT
chmod 700 "${CHECK_DIR}"
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten > "${CHECK_DIR}/kubeconfig"
export KUBECONFIG="${CHECK_DIR}/kubeconfig"
log_info "[TEST 29] LIVE CDC slot WAL, Connect logs and node filesystem headroom..."

python3 - <<'PY'
import json
import os
import subprocess
import sys


def kubectl(*args):
    return subprocess.check_output(['kubectl', '--request-timeout=30s', *args],
                                   text=True, timeout=60)


errors = []


def require(condition, message):
    if not condition:
        errors.append(message)


def check():
    limit = int(os.environ.get('CDC_WAL_MAX_BYTES', '1073741824'))
    log_limit = int(os.environ.get('CONNECT_LOG_MAX_BYTES', '209715200'))
    min_free = float(os.environ.get('NODE_FS_MIN_FREE_PERCENT', '20'))
    if limit <= 0 or log_limit <= 0 or not 0 < min_free < 100:
        raise ValueError('invalid WAL/log/free-space threshold')
    # D-LOG-5: inspect every worker during a rolling update, including the old
    # pod retaining logs. Cost: exec/du per pod; escape hatch: scrape usage metrics.
    pods = json.loads(kubectl('-n', 'streaming', 'get', 'pods', '-l',
                             'app=debezium-connect', '-o', 'json'))['items']
    # Terminating/Pending pods cannot be exec'd; only Running pods carry readable logs.
    running = [p for p in pods if p.get('status', {}).get('phase') == 'Running'
               and not p['metadata'].get('deletionTimestamp')]
    require(bool(running), 'no Running debezium-connect pod for log check (not healthy evidence)')
    for pod in running:
        name = pod['metadata']['name']
        try:
            usage = kubectl('-n', 'streaming', 'exec', name, '-c', 'connect', '--',
                            'du', '-sk', '/kafka/logs').split()
        except (OSError, subprocess.SubprocessError):
            errors.append(f'{name}: Connect log usage exec failed')
            continue
        if len(usage) != 2 or not usage[0].isdecimal() or usage[1] != '/kafka/logs':
            errors.append(f'{name}: invalid Connect log usage response')
            continue
        log_bytes = int(usage[0]) * 1024
        print(f'pod={name} connect_log_bytes={log_bytes} limit_bytes={log_limit}')
        require(log_bytes <= log_limit,
                f'{name}: /kafka/logs {log_bytes} bytes exceeds {log_limit}')
    config = json.loads(kubectl('-n', 'streaming', 'exec', 'deploy/debezium-connect',
                               '--', 'curl', '-fsS', '--max-time', '20',
                               'http://localhost:8083/connectors/shop-cdc/config'))
    interval = config.get('heartbeat.interval.ms', '')
    require(isinstance(interval, str) and interval.isdecimal()
            and 0 < int(interval) <= 60000, 'heartbeat.interval.ms absent/disabled/too slow')
    require(config.get('heartbeat.action.query') == (
        'INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) '
        'ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at'),
        'heartbeat.action.query is not the singleton UPSERT')
    require('public.cdc_heartbeat' in config.get('table.include.list', '').split(','),
            'heartbeat table is not captured')
    require(config.get('publication.autocreate.mode') == 'filtered'
            and config.get('publication.name') == 'dbz_publication',
            'expected filtered dbz_publication')

    cluster = json.loads(kubectl('-n', 'database', 'get', 'cluster', 'postgres-main', '-o', 'json'))
    primary = cluster['status']['currentPrimary']
    sql = """
SELECT json_build_object(
  'max_slot_wal_keep_size_bytes', CASE WHEN current_setting('max_slot_wal_keep_size') = '-1'
    THEN -1 ELSE pg_size_bytes(current_setting('max_slot_wal_keep_size')) END,
  'slots', (SELECT json_agg(json_build_object(
    'active', active, 'database', database, 'plugin', plugin, 'wal_status', wal_status,
    'confirmed_flush_lsn', confirmed_flush_lsn,
    'retained_bytes', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)))
    FROM pg_replication_slots WHERE slot_name = 'beluga_shop_slot'));
"""
    state = json.loads(kubectl('-n', 'database', 'exec', primary, '-c', 'postgres', '--',
                              'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
                              '-d', 'shop', '-Atc', sql))
    cap = state['max_slot_wal_keep_size_bytes']
    require(isinstance(cap, int) and cap > 0, 'max_slot_wal_keep_size is unlimited/invalid')
    slots = state['slots'] or []
    require(len(slots) == 1, 'beluga_shop_slot missing or ambiguous')
    for slot in slots:
        require(slot['active'] is True, 'beluga_shop_slot inactive: check Kafka/Connect')
        require(slot['database'] == 'shop' and slot['plugin'] == 'pgoutput',
                'beluga_shop_slot database/plugin mismatch')
        require(slot['wal_status'] in ('reserved', 'extended'),
                'beluga_shop_slot WAL unavailable: recovery/re-snapshot review required')
        retained = slot['retained_bytes']
        require(isinstance(retained, (int, float)) and 0 <= retained < limit,
                f'beluga_shop_slot retained WAL {retained} bytes must be below {limit}')
        print(f"slot=beluga_shop_slot retained_bytes={retained} cap_bytes={cap} "
              f"confirmed_flush_lsn={slot['confirmed_flush_lsn']} active={slot['active']}")

    # D-WAL-7: no alert evaluator/node-exporter convention exists; query kubelet
    # nodefs/imagefs directly. Cost: point-in-time + nodes/proxy read permission;
    # escape hatch: replace with scraped metrics and routed alerts when provisioned.
    nodes = json.loads(kubectl('get', 'nodes', '-o', 'json'))['items']
    require(bool(nodes), 'no nodes returned for filesystem check')
    for node in nodes:
        name = node['metadata']['name']
        pressure = next((c['status'] for c in node['status']['conditions']
                         if c['type'] == 'DiskPressure'), None)
        require(pressure == 'False', f'{name}: DiskPressure={pressure}')
        stats = json.loads(kubectl('get', '--raw',
                                  f'/api/v1/nodes/{name}/proxy/stats/summary'))['node']
        runtime = stats.get('runtime', {})
        filesystems = {'nodefs': stats.get('fs'), 'imagefs': runtime.get('imageFs')}
        if runtime.get('containerFs'):
            filesystems['containerfs'] = runtime['containerFs']
        for label, fs in filesystems.items():
            if not fs or not isinstance(fs.get('capacityBytes'), (int, float)) or fs['capacityBytes'] <= 0:
                errors.append(f'{name}/{label}: missing filesystem stats (not healthy evidence)')
                continue
            available = fs.get('availableBytes')
            if not isinstance(available, (int, float)):
                errors.append(f'{name}/{label}: missing availableBytes')
                continue
            free = 100 * available / fs['capacityBytes']
            print(f'node={name} filesystem={label} available_bytes={available} free_percent={free:.2f}')
            require(free >= min_free, f'{name}/{label}: free {free:.2f}% below {min_free}%')


try:
    check()
except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
    # Never print Connect response/config, which contains database.password.
    errors.append(f'live query failed ({type(exc).__name__}); check access and response schema')
if errors:
    for error in errors:
        print(f'FAIL CDC WAL: {error}', file=sys.stderr)
    sys.exit(1)
print('PASS CDC WAL: heartbeat configured, bounded active slot, retained WAL, Connect logs and node free space within thresholds')
PY
