"""Offline mounted-rule, runtime endpoint and live-input coverage contracts."""
from __future__ import annotations

import ast
import fnmatch
import re
from pathlib import PurePosixPath

import yaml


def require(ok, message):
    if not ok:
        raise ValueError(message)


def live_selectors(root):
    script = (root / 'tests/31-alerting-pipeline.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
    tree = ast.parse(script)
    return set(next(ast.literal_eval(n.value) for n in ast.walk(tree)
                    if isinstance(n, ast.Assign) and any(
                        isinstance(t, ast.Name) and t.id == 'required_series' for t in n.targets)))


def validate_rule_inputs(data, selectors, jobs):
    # D-ALERT-17: compare full selectors, including labels, so presence checks
    # cannot silently drift. Cost: bounded PromQL syntax; escape: a real parser.
    for content in data.values():
        for selector in re.findall(r'\b[A-Za-z_:][A-Za-z0-9_:]*\{[^{}]*\}', content):
            require(selector in selectors or selector.startswith('up{'),
                    f'live metric presence check missing: {selector}')
    root_usage = 'container_fs_usage_bytes{job="kubelet-cadvisor",id="/",device=~"/dev/.+",device!="/dev/shm"}'
    root_limit = 'container_fs_limit_bytes{job="kubelet-cadvisor",id="/",device=~"/dev/.+",device!="/dev/shm"}'
    rules = yaml.safe_load(data['storage.yml'])['groups'][0]['rules']
    for rule in rules:
        if rule['alert'] == 'NodeRootFilesystemLow':
            require(rule['expr'] == f'min by (node, device) (100 * (1 - {root_usage} / ({root_limit} > 1073741824))) < '
                    + ('20' if rule['labels']['severity'] == 'warning' else '12'), 'node/device filesystem selector or capacity filter drift')
        if rule['alert'] == 'NodeRootFilesystemMetricAbsent':
            require(rule['expr'] == f'absent({root_usage}) or absent({root_limit})' and
                    rule['for'] == '15m' and rule['labels']['severity'] == 'warning', 'root absence drift')
    filters = jobs['kubelet-cadvisor']['metric_relabel_configs']
    require(filters == [
        {'source_labels': ['__name__'], 'action': 'keep', 'regex': 'container_fs_(usage|limit)_bytes'},
        {'source_labels': ['id'], 'action': 'keep', 'regex': '/'},
        {'source_labels': ['device'], 'action': 'keep', 'regex': '/dev/.+'},
        {'source_labels': ['device'], 'action': 'drop', 'regex': '/dev/shm'},
    ], 'cAdvisor block-device keep filter drift')


def validate_wiring(docs, find, chart):
    pod = find(docs, 'Deployment', 'vmalert')['spec']['template']['spec']
    container = pod['containers'][0]
    args = container['args']
    for flag, service, port in (
        ('notifier.url', 'alertmanager', 9093),
        ('datasource.url', 'victoria-metrics', 8428),
        ('remoteWrite.url', 'victoria-metrics', 8428),
        ('remoteRead.url', 'victoria-metrics', 8428),
    ):
        svc = find(docs, 'Service', service)
        require(any(p['port'] == port for p in svc['spec']['ports']), f'{service}: port drift')
        require([a for a in args if a.startswith(f'-{flag}=')] ==
                [f'-{flag}=http://{service}.platform-system.svc.cluster.local:{port}'], f'{flag}: endpoint drift')
    # D-ALERT-18: resolve rule globs against projected ConfigMap paths, not just
    # flag text. Cost: local path model; escape: extend for subPath/other volumes.
    mounted = {}
    for volume in pod['volumes']:
        if volume.get('configMap', {}).get('name') != 'vmalert-rules':
            continue
        cm = volume['configMap']
        data = find(docs, 'ConfigMap', cm['name'])['data']
        items = cm.get('items', [{'key': k, 'path': k} for k in data])
        for mount in container['volumeMounts']:
            if mount['name'] != volume['name']:
                continue
            require('subPath' not in mount and 'subPathExpr' not in mount, 'rule subPath unsupported')
            for item in items:
                require(item['key'] in data, 'projected rule key missing')
                mounted[item['key']] = str(PurePosixPath(mount['mountPath']) / item['path'])
    globs = [a.split('=', 1)[1] for a in args if a.startswith('-rule=')]
    required = {p.name for p in (chart / 'files/observability/rules').glob('*') if p.is_file()}
    require(required <= mounted.keys() and all(any(fnmatch.fnmatchcase(mounted[k], g) for g in globs)
                                              for k in required), 'rule glob does not cover mounted rule files')
