#!/usr/bin/env bash
# LIVE ONLY, read-only. Run on a trusted operator host, not inside the node VM.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_CLOCK_SOURCE_CONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}"
python3 - <<'PY'
import datetime
import email.utils
import json
import os
import re
import subprocess
import tempfile
import time


class ClockFailure(Exception):
    pass


def require(ok, message):
    if not ok:
        raise ClockFailure(message)


def check():
    threshold = os.environ.get('NODE_CLOCK_MAX_SKEW_SECONDS', '120')
    require(re.fullmatch(r'[0-9]+', threshold) and int(threshold) > 0,
            'NODE_CLOCK_MAX_SKEW_SECONDS must be a positive integer')
    threshold = int(threshold)
    # D-ALERT-24: kubectl handles client certificates, CA, TLS server name and auth.
    # Private isolated config/verbose headers never reach stdout. Cost: client-go
    # header log format dependency; escape: fail closed and update parser after upgrade.
    with tempfile.TemporaryDirectory(prefix='beluga-clock-') as directory:
        config = os.path.join(directory, 'kubeconfig')
        with open(config, 'w', encoding='utf-8') as output:
            os.chmod(config, 0o600)
            result = subprocess.run([
                'kubectl', '--kubeconfig', os.environ['NODE_CLOCK_SOURCE_CONFIG'],
                'config', 'view', '--minify', '--flatten', '--raw',
            ], stdout=output, stderr=subprocess.DEVNULL, timeout=30)
        require(result.returncode == 0, 'cannot isolate kubeconfig')
        env = {**os.environ, 'KUBECONFIG': config}
        before = time.time()
        # Never echo verbose logs: they may include auth or certificate metadata.
        response = subprocess.run(['kubectl', '--request-timeout=15s', 'get',
                                   '--raw', '/healthz', '-v=8'], env=env,
                                  capture_output=True, text=True, timeout=25)
        after = time.time()
        require(after >= before, 'operator host clock moved backwards during request')
        require(response.returncode == 0, 'API healthz request failed (TLS/auth/reachability)')
        dates = re.findall(r'\bDate:\s*([^\r\n]+)', response.stderr, re.IGNORECASE)
        require(len(dates) == 1, 'API Date header missing or ambiguous')
        api = email.utils.parsedate_to_datetime(dates[0].strip().strip('[]'))
        require(api.tzinfo is not None, 'API Date header lacks timezone')
        # D-ALERT-25: interval distance accounts for request latency and Date's 1s
        # precision. Cost: a slow request widens uncertainty; bounded timeout limits it.
        # Escape: compare host/guest directly when TLS or the API is unavailable.
        epoch = api.timestamp()
        skew = epoch - (before + after) / 2
        excess = max(before - epoch - 1, epoch - after, 0)
        print(f'API clock skew={skew:+.1f}s; request interval={after-before:.1f}s; '
              f'minimum absolute skew={excess:.1f}s; threshold={threshold}s', flush=True)
        require(excess <= threshold, 'API clock skew exceeds threshold')
        nodes = subprocess.run(['kubectl', '--request-timeout=15s', 'get', 'nodes', '-o', 'json'],
                               env=env, capture_output=True, text=True, timeout=25)
        require(nodes.returncode == 0, 'cannot read node heartbeats')
        items = json.loads(nodes.stdout)['items']
        require(bool(items), 'no nodes returned')
        host = time.time()
        for node in items:
            ready = [c for c in node.get('status', {}).get('conditions', []) if c['type'] == 'Ready']
            require(len(ready) == 1, 'node Ready condition missing or ambiguous')
            stamp = ready[0]['lastHeartbeatTime']
            heartbeat = datetime.datetime.fromisoformat(re.sub(
                r'\.(\d+)', lambda m: '.' + (m[1] + '000000')[:6], stamp).replace('Z', '+00:00'))
            require(heartbeat.tzinfo is not None, 'heartbeat timezone missing')
            future = heartbeat.timestamp() - host
            print(f'Node {node["metadata"]["name"]}: Ready heartbeat future skew={future:+.1f}s', flush=True)
            require(future <= threshold, 'Ready heartbeat is too far in the future')
        print('PASS node clock sanity (operator-host reference; point-in-time only)')


try:
    check()
except ClockFailure as exc:
    raise SystemExit(f'FAIL node clock sanity: {exc}') from None
except (ValueError, KeyError, TypeError, OSError, OverflowError, subprocess.SubprocessError):
    # Do not print exception payloads: JSON/server/client diagnostics can contain secrets.
    raise SystemExit('FAIL node clock sanity: invalid threshold, missing/invalid Date or heartbeat, '
                     'excessive skew, or API/config request failure') from None
PY
