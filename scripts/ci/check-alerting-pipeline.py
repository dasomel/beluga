#!/usr/bin/env python3
"""Offline #408 structural contract; stdlib + the repository's existing PyYAML.

No new binary/dependency: this validates rendered YAML and known metric names,
not PromQL evaluation, TLS reachability or notification delivery (test 31).
"""
from __future__ import annotations

import argparse
import copy
import os
import re
import subprocess
from pathlib import Path

import yaml

from alerting_network_contract import self_test_network, validate_network
from alerting_rule_contract import live_selectors, validate_rule_inputs, validate_wiring

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / 'gitops/charts/beluga-platform'
SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount/'
METRICS = {
    'up', 'container_fs_usage_bytes', 'container_fs_limit_bytes',
    'kubelet_volume_stats_used_bytes', 'kubelet_volume_stats_capacity_bytes',
    'kubelet_volume_stats_available_bytes', 'cnpg_pg_replication_slots_pg_wal_lsn_diff',
    'cnpg_pg_replication_slots_active', 'cnpg_collector_pg_wal',
    'cnpg_collector_pg_wal_archive_status', 'vm_rows_inserted_total',
    'vm_promscrape_scrapes_failed_total',
}
# D-ALERT-10: deliberately bounded lexer rejects unreviewed metric/function names.
# Cost: new PromQL syntax needs a reviewed extension; escape: use a real offline evaluator.
FUNCTIONS = {'vector', 'absent', 'absent_over_time', 'rate', 'min', 'max', 'sum', 'avg', 'count'}
OPERATORS = {'and', 'or', 'unless', 'bool'}
ALERTS = {'NodeRootFilesystemMetricAbsent', 'NodeRootFilesystemLow', 'DataFilesystemLow', 'ReplicationSlotRetainedWALHigh',
          'ReplicationSlotInactive', 'PgWalDirectoryLarge', 'WalArchiveBacklog',
          'ScrapeTargetDown', 'Watchdog'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def find(docs, kind, name, namespace='platform-system'):
    found = [d for d in docs if d['kind'] == kind and d['metadata']['name'] == name
             and d['metadata'].get('namespace', '') == namespace]
    require(len(found) == 1, f'{kind}/{namespace}/{name}: expected one resource')
    return found[0]


def parsed(docs, name, key):
    return yaml.safe_load(find(docs, 'ConfigMap', name)['data'][key])


def auth(config):
    require(config.get('bearer_token_file') == SA_DIR + 'token', 'bearer token file missing')
    require(config.get('tls_config') == {'ca_file': SA_DIR + 'ca.crt'}, 'TLS CA/verification drift')


def validate(docs, expected_config):
    data = find(docs, 'ConfigMap', 'vmalert-rules')['data']
    require(set(data) == {'storage.yml', 'cdc-wal.yml', 'pipeline.yml'}, 'rule ConfigMap keys drift')
    selectors = live_selectors(ROOT)
    covered_metrics = {s.split("{", 1)[0] for s in selectors} | {"up"}
    names = set()
    identities = set()
    for content in data.values():
        groups = yaml.safe_load(content)['groups']
        require(bool(groups), 'empty rule groups')
        for group in groups:
            require(bool(group.get('name')) and bool(group.get('rules')), 'invalid rule group')
            for rule in group['rules']:
                name = rule.get('alert')
                require(name in ALERTS, f'unknown alert: {name}')
                names.add(name)
                severity = rule.get('labels', {}).get('severity')
                identity = (name, severity)
                require(identity not in identities, 'duplicate alert/severity')
                identities.add(identity)
                require(severity in {'info', 'warning', 'critical'}, 'severity missing/invalid')
                require(re.fullmatch(r'\d+[smhd]', str(rule.get('for', ''))), 'for missing/invalid')
                annotations = rule.get('annotations', {})
                require(all(isinstance(annotations.get(k), str) and annotations[k].strip()
                            for k in ('summary', 'description', 'runbook_url')), 'annotations missing')
                require(annotations['runbook_url'].endswith('/docs/runbooks/cdc-slot-wal-retention.md'),
                        'runbook path drift')
                expr = rule.get('expr')
                require(isinstance(expr, str) and bool(expr.strip()), 'expr missing')
                # Strip label matchers, grouping labels, ranges, numeric literals; remaining
                # identifiers must be exact known metrics, operators or approved functions.
                lexed = re.sub(r'\{[^{}]*\}|\[[^\]]*\]', '', expr)
                lexed = re.sub(r'\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)', '', lexed)
                lexed = re.sub(r'\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b', '', lexed)
                tokens = set(re.findall(r'[A-Za-z_:][A-Za-z0-9_:]*', lexed))
                require(tokens <= METRICS | FUNCTIONS | OPERATORS,
                        f'unknown metric/function: {sorted(tokens - METRICS - FUNCTIONS - OPERATORS)}')
                require(tokens & METRICS <= covered_metrics, 'rule metric missing from live test list')
    require(names == ALERTS and len(identities) == 12, 'required alerts/severities missing')

    scrape = parsed(docs, 'victoria-metrics-scrape', 'scrape.yml')
    jobs = {j['job_name']: j for j in scrape['scrape_configs']}
    expected = {'victoria-metrics', 'grafana', 'argocd-application-controller', 'argocd-server',
                'argocd-repo-server', 'argocd-notifications-controller', 'cert-manager', 'opa',
                'kubelet', 'kubelet-cadvisor', 'kubelet-resource', 'cnpg'}
    require(set(jobs) == expected and len(scrape['scrape_configs']) == len(expected), 'scrape jobs drift')
    for name, job in jobs.items():
        if name.startswith('kubelet') or name == 'cnpg':
            sd = job['kubernetes_sd_configs']
            require(len(sd) == 1 and sd[0]['api_server'] == 'https://kubernetes.default.svc', 'SD API drift')
            auth(sd[0])
            require(sd[0]['role'] == ('pod' if name == 'cnpg' else 'node'), 'SD role drift')
            require(bool(job.get('metric_relabel_configs')), 'metric cardinality filter missing')
            if name == 'cnpg':
                require(sd[0]['namespaces']['names'] == ['database', 'platform-system'], 'pod discovery scope')
                require(job['scheme'] == 'http', 'CNPG exporter scheme drift')
                require(any(r.get('regex') == '9187' and r.get('action') == 'keep'
                            for r in job['relabel_configs']), 'CNPG port filter missing')
            else:
                auth(job)
                path = {'kubelet': '/metrics', 'kubelet-cadvisor': '/metrics/cadvisor',
                        'kubelet-resource': '/metrics/resource'}[name]
                require(job['scheme'] == 'https' and job['metrics_path'] == path, 'kubelet endpoint drift')
                require(not any(r.get('target_label') == '__address__' for r in job['relabel_configs']),
                        'kubelet must retain node SD InternalIP:10250 address')
        else:
            require(bool(job.get('static_configs')) and job.get('scheme', 'http') == 'http', 'static job drift')
            require(not any(k in job for k in ('tls_config', 'bearer_token', 'bearer_token_file')), 'static auth drift')

    validate_rule_inputs(data, selectors, jobs)
    role = find(docs, 'ClusterRole', 'victoria-metrics-scraper', '')
    require(role['rules'] == [dict(apiGroups=[''], resources=['nodes'], verbs=['list', 'watch']),
                              dict(apiGroups=[''], resources=['nodes/metrics'], verbs=['get'])], 'RBAC scope drift')
    expected_bindings = {('ClusterRoleBinding', '', 'victoria-metrics-scraper'),
                         ('RoleBinding', 'database', 'victoria-metrics-pod-discovery'),
                         ('RoleBinding', 'platform-system', 'victoria-metrics-pod-discovery')}
    actual = set()
    for d in docs:
        if d['kind'] not in {'RoleBinding', 'ClusterRoleBinding'}:
            continue
        if not any(s.get('name') == 'victoria-metrics' and s.get('namespace') == 'platform-system'
                   for s in d.get('subjects', [])):
            continue
        key = (d['kind'], d['metadata'].get('namespace', ''), d['metadata']['name'])
        actual.add(key)
        require(d['subjects'] == [dict(kind='ServiceAccount', name='victoria-metrics', namespace='platform-system')],
                'RBAC subject drift')
        require(d['roleRef'] == dict(apiGroup='rbac.authorization.k8s.io',
                kind='ClusterRole' if key[0] == 'ClusterRoleBinding' else 'Role', name=key[2]), 'RBAC binding drift')
    require(actual == expected_bindings, 'RBAC bindings drift')
    for ns in ('database', 'platform-system'):
        require(find(docs, 'Role', 'victoria-metrics-pod-discovery', ns)['rules'] ==
                [dict(apiGroups=[''], resources=['pods'], verbs=['list', 'watch'])], 'pod RBAC drift')
    vm = find(docs, 'StatefulSet', 'victoria-metrics')['spec']['template']['spec']
    require(vm['serviceAccountName'] == 'victoria-metrics' and vm['automountServiceAccountToken'], 'VM SA missing')
    for name in ('vmalert', 'alertmanager'):
        pod = find(docs, 'Deployment', name)['spec']['template']
        container = pod['spec']['containers'][0]
        require(re.fullmatch(r'.+:[^@]+@sha256:[0-9a-f]{64}', container['image']), 'image not digest-pinned')
        require(bool(pod['metadata']['annotations'].get('checksum/config')), 'rollout checksum missing')
        require(pod['spec']['automountServiceAccountToken'] is False, 'unneeded SA token')
    validate_wiring(docs, find, CHART)
    sources = parsed(docs, 'grafana-provisioning', 'datasource.yaml')['datasources']
    prometheus = next(s for s in sources if s['uid'] == 'victoriametrics')
    require(prometheus['jsonData']['manageAlerts'] is True and
            prometheus['jsonData']['prometheusType'] == 'Prometheus', 'Grafana rules visibility missing')
    am = next(s for s in sources if s['uid'] == 'alertmanager')
    require(am['type'] == 'alertmanager' and am['jsonData'] ==
            dict(implementation='prometheus', handleGrafanaManagedAlerts=False), 'Grafana AM datasource drift')
    require(any(a.startswith('-vmalert.proxyURL=http://vmalert.platform-system.svc.cluster.local:')
                for a in vm['containers'][0]['args']), 'VM rules proxy missing')
    config = parsed(docs, 'alertmanager-config', 'alertmanager.yml')
    require(config == expected_config, 'Alertmanager receiver/config differs from values')
    require(config['route']['group_by'] == ['alertname', 'namespace'], 'alert grouping drift')
    require(config['route']['receiver'] in {r['name'] for r in config['receivers']}, 'undefined receiver')


def self_test(docs, config):
    def corrupt_rule(d, field, value):
        cm = find(d, 'ConfigMap', 'vmalert-rules')['data']
        rules = yaml.safe_load(cm['pipeline.yml'])
        rules['groups'][0]['rules'][0][field] = value
        cm['pipeline.yml'] = yaml.safe_dump(rules)

    def corrupt_filesystem(d, old, new):
        data = find(d, 'ConfigMap', 'vmalert-rules')['data']
        data['storage.yml'] = data['storage.yml'].replace(old, new)

    def change_args(d, flag, replacement=None):
        args = find(d, 'Deployment', 'vmalert')['spec']['template']['spec']['containers'][0]['args']
        args[:] = [a for a in args if not a.startswith('-' + flag + '=')]
        if replacement is not None:
            args.append(f'-{flag}={replacement}')

    mutations = [
        lambda d: corrupt_filesystem(d, ',device=~"/dev/.+"', ''),
        lambda d: corrupt_filesystem(d, ' > 1073741824', ''),
        lambda d: change_args(d, 'notifier.url'),
        lambda d: change_args(d, 'rule', '/etc/vmalert/missing/*.yml'),
        lambda d: corrupt_rule(d, 'expr', 'vm_rows_inserted_total{job="unknown"} > 0'),
        lambda d: corrupt_rule(d, 'expr', 'cnpg_pg_replication_slots_typo > 1'),
        lambda d: corrupt_rule(d, 'for', ''),
        lambda d: corrupt_rule(d, 'labels', {}),
        lambda d: corrupt_rule(d, 'annotations', {}),
        lambda d: find(d, 'ConfigMap', 'vmalert-rules')['data'].update({'pipeline.yml': 'groups: ['}),
        lambda d: find(d, 'Deployment', 'vmalert')['spec']['template']['spec']['containers'][0].update(image='vm:v1'),
        lambda d: find(d, 'ClusterRole', 'victoria-metrics-scraper', '')['rules'][1].update(resources=['nodes/proxy']),
        lambda d: find(d, 'ConfigMap', 'alertmanager-config')['data'].update({'alertmanager.yml': 'receivers: []'}),
    ]
    for mutate in mutations:
        bad = copy.deepcopy(docs)
        mutate(bad)
        try:
            validate(bad, config)
        except (ValueError, KeyError, TypeError, yaml.YAMLError):
            continue
        raise ValueError('negative fixture unexpectedly passed')
    for field in ('bearer_token_file', 'tls_config'):
        bad = copy.deepcopy(docs)
        cm = find(bad, 'ConfigMap', 'victoria-metrics-scrape')['data']
        scrape = yaml.safe_load(cm['scrape.yml'])
        next(j for j in scrape['scrape_configs'] if j['job_name'] == 'kubelet').pop(field)
        cm['scrape.yml'] = yaml.safe_dump(scrape)
        try:
            validate(bad, config)
        except ValueError:
            continue
        raise ValueError('missing auth/TLS fixture unexpectedly passed')
    override = copy.deepcopy(config)
    override['route']['receiver'] = 'owner-selected'
    override['receivers'] = [{'name': 'owner-selected'}]
    good = copy.deepcopy(docs)
    find(good, 'ConfigMap', 'alertmanager-config')['data']['alertmanager.yml'] = yaml.safe_dump(override)
    validate(good, override)
    print('PASS: 15 negative fixtures rejected (rules, YAML, RBAC, auth/TLS, pin, receiver); receiver override accepted')


def merge(base, override):
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = merge(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--values', action='append', default=[])
    args = parser.parse_args()
    observability = yaml.safe_load((CHART / 'values.yaml').read_text())['observability']
    for path in args.values:
        override = yaml.safe_load(Path(path).read_text()) or {}
        observability = merge(observability, override.get('observability', {}))
    config = observability['alertmanager']['config']
    cilium_enabled = observability.get('ciliumEntityEgress', True)
    combos = [('default', []), ('sso', ['-f', str(ROOT / 'gitops/values/sso.yaml')]),
              ('full', ['-f', str(ROOT / 'gitops/values/profile-full.yaml'),
                        '-f', str(ROOT / 'gitops/values/sso.yaml')]),
              ('kakao', ['-f', str(CHART / 'values-kakao.yaml'), '-f', str(ROOT / 'gitops/values/sso.yaml'),
                         '-f', str(ROOT / 'gitops/values/domain-kakao.yaml')])]
    for label, flags in combos:
        for path in args.values:
            flags.extend(['-f', path])
        result = subprocess.run(['helm', 'template', 'beluga-platform', str(CHART), *flags],
                                capture_output=True, text=True, check=True,
                                env={**os.environ, 'KUBECONFIG': os.devnull})
        docs = [d for d in yaml.safe_load_all(result.stdout) if d]
        data = subprocess.run(['helm', 'template', 'beluga-data', str(ROOT / 'gitops/charts/beluga-data'), *flags],
                              capture_output=True, text=True, check=True,
                              env={**os.environ, 'KUBECONFIG': os.devnull})
        docs.extend(d for d in yaml.safe_load_all(data.stdout) if d)
        validate_network(docs, cilium_enabled)
        validate(docs, config)
        if label == 'default':
            self_test(docs, config)
            if cilium_enabled:
                self_test_network(docs)
                disabled = subprocess.run(['helm', 'template', 'beluga-platform', str(CHART), *flags,
                                          '--set', 'observability.ciliumEntityEgress=false'],
                                         capture_output=True, text=True, check=True,
                                         env={**os.environ, 'KUBECONFIG': os.devnull})
                validate_network([d for d in yaml.safe_load_all(disabled.stdout) if d], False)
                print('PASS non-Cilium opt-out: no entity policy; pod network paths retained')
        print(f'PASS {label}: 12 rules, 12 scrape jobs, least-privilege RBAC, pinned images, receiver + Cilium/network contracts')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, yaml.YAMLError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f'FAIL alerting pipeline: {exc}') from exc
