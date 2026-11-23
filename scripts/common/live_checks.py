"""Shared live-test transports; importing this module performs no cluster access."""
import json
import re
import subprocess
import time
import urllib.parse
import urllib.request


def kubectl(*args, input=None, timeout=60):
    return subprocess.check_output(
        ['kubectl', '--request-timeout=30s', *args], input=input, text=True, timeout=timeout)


def airflow(*args):
    out = kubectl('-n', 'orchestration', 'exec', 'deployment/airflow-webserver',
                  '-c', 'airflow', '--', 'airflow', *args)
    return '\n'.join(line for line in out.splitlines()
                     if not re.match(r'^\d{4}-\d{2}-\d{2}T\S+Z \[', line)).strip()


def request_token(url, form, context=None):
    request = urllib.request.Request(
        url, data=urllib.parse.urlencode(form).encode(),
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(request, context=context, timeout=20) as response:
        return json.load(response)['access_token']


def query(base, headers, context, sql, timeout=120):
    request = urllib.request.Request(base + '/v1/statement', data=sql.encode(), headers=headers)
    rows = []
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Trino query deadline exceeded')
        with urllib.request.urlopen(request, context=context, timeout=min(30, remaining)) as response:
            page = json.load(response)
        rows.extend(page.get('data') or [])
        if page.get('error'):
            return rows, page['error']
        if not page.get('nextUri'):
            return rows, None
        path = urllib.parse.urlsplit(page['nextUri'])
        request = urllib.request.Request(base + path.path + ('?' + path.query if path.query else ''),
                                         headers=headers)


def require_dags(dags, errors):
    if not isinstance(errors, list) or errors:
        raise ValueError(f'Airflow import errors: {errors}')
    expected = {'dbt_shop_medallion', 'iceberg_table_maintenance'}
    missing = expected - {item['dag_id'] for item in dags}
    if missing:
        raise ValueError(f'Airflow DAGs missing: {sorted(missing)}')


def data_rows(rows):
    # D-PIPE-1: read a real column, avoiding metadata-only count optimizations.
    # Cost: one bounded row read; escape hatch: choose another seeded Iceberg table.
    if not rows or any(len(row) != 1 or not isinstance(row[0], str) or not row[0] for row in rows):
        raise ValueError('Iceberg orders returned no sane status row')


def internal_query(sql, timeout=60):
    import base64
    from pathlib import Path
    def secret(namespace, name, key):
        obj = json.loads(kubectl('-n', namespace, 'get', 'secret', name, '-o', 'json'))
        return base64.b64decode(obj['data'][key]).decode()
    payload = {
        'password': secret('platform-system', 'beluga-credentials', 'user-password-analyst'),
        'client_secret': secret('iam', 'keycloak-client-secrets', 'trino'),
        'sql': sql, 'timeout': timeout,
    }
    # D-PIPE-2: same analyst ROPC as 07 and query protocol as 27/28, inside
    # Airflow's existing Python container. Cost: exec per query; escape: gateway tests 07/27.
    # Secrets travel only on stdin; no gateway DNS, new pod, RBAC or TLS bypass.
    out = kubectl('-n', 'orchestration', 'exec', '-i', 'deployment/airflow-webserver',
                  '-c', 'airflow', '--', 'python', '-c', Path(__file__).read_text(),
                  input=json.dumps(payload), timeout=timeout + 15)
    rows, error = json.loads(out)
    if error:
        raise ValueError(f'Trino query failed: {error}')
    return rows


if __name__ == '__main__':
    import ssl
    import sys
    payload = json.load(sys.stdin)
    context = ssl.create_default_context(cafile='/etc/ca-bundle/ca-bundle.crt')
    token = request_token(
        'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token',
        {'client_id': 'trino', 'client_secret': payload['client_secret'],
         'grant_type': 'password', 'username': 'beluga-analyst',
         'password': payload['password'], 'scope': 'openid'})
    print(json.dumps(query('https://trino.analytics.svc.cluster.local:8443',
                           {'Authorization': f'Bearer {token}', 'X-Trino-User': 'beluga-analyst'},
                           context, payload['sql'], payload['timeout'])))
