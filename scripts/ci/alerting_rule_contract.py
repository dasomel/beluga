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
        {'source_labels': ['__name__'], 'action': 'keep', 'regex': 'container_fs_(usage|limit)_bytes|machine_memory_bytes'},
        {'source_labels': ['__name__', 'id'], 'action': 'keep',
         'regex': 'machine_memory_bytes;|container_fs_(usage|limit)_bytes;/'},
        {'source_labels': ['__name__', 'device'], 'action': 'keep',
         'regex': 'machine_memory_bytes;|container_fs_(usage|limit)_bytes;/dev/.+'},
        {'source_labels': ['device'], 'action': 'drop', 'regex': '/dev/shm'},
    ], 'cAdvisor block-device keep filter drift')
    require(jobs['kubelet-resource']['metric_relabel_configs'] == [
        {'source_labels': ['__name__'], 'action': 'keep',
         'regex': '(node|pod)_(cpu|memory)_.*|container_start_time_seconds'},
    ], 'kubelet-resource container_start_time_seconds keep filter drift')
    entries = yaml.safe_load(data['pipeline.yml'])['groups'][0]['rules']
    require({r['labels']['severity'] for r in entries if r['alert'] == 'NodeMemoryLow'} ==
            {'warning', 'critical'}, 'memory severity tiers missing')
    for rule in entries:
        if rule['alert'] == 'NodeMemoryLow':
            severity = rule['labels']['severity']
            require(rule['expr'] == '100 * (1 - max by (node) (node_memory_working_set_bytes{job="kubelet-resource"}) / (max by (node) (machine_memory_bytes{job="kubelet-cadvisor"}) > 0)) < ' +
                    ('15' if severity == 'warning' else '10') and
                    rule['for'] == ('5m' if severity == 'warning' else '2m'), 'memory headroom drift')
    pipeline_rules = {r['alert']: r for r in entries}
    missing = pipeline_rules.get('NodeMemoryMetricsMissing', {})
    require(missing.get('expr') ==
            'absent(node_memory_working_set_bytes{job="kubelet-resource"}) or absent(machine_memory_bytes{job="kubelet-cadvisor"})' and
            missing.get('for') == '15m' and missing.get('labels', {}).get('severity') == 'warning',
            'memory input absence rule missing or drifted')
    restart = pipeline_rules['ContainerRestartingFrequently']
    require(restart['expr'] == 'changes(container_start_time_seconds{job="kubelet-resource",pod=~"(apisix|apisix-ingress-controller|apisix-etcd|manager-domain-api|manager-web|vmalert|alertmanager|grafana|keycloak|opa|openfga|openldap|debezium-connect|lakekeeper|trino-coordinator|trino-worker|opensearch|openmetadata|airflow-webserver|superset|clickstream-gen|shop-gen)-[bcdfghjklmnpqrstvwxz2456789]+-[a-z0-9]+|(victoria-metrics|seaweedfs)-[0-9]+"}[30m]) >= 3' and
            restart['for'] == '5m' and restart['labels']['severity'] == 'warning', 'container restart drift')
    require(pipeline_rules['FlinkNoRunningJobs']['expr'] ==
            'up{job="flink"} == 0 or absent(flink_jobmanager_numRunningJobs{job="flink"}) '
            'or flink_jobmanager_numRunningJobs{job="flink"} < 1' and
            pipeline_rules['FlinkNoRunningJobs']['for'] == '5m' and
            pipeline_rules['FlinkNoRunningJobs']['labels']['severity'] == 'critical',
            'FlinkNoRunningJobs rule drift')
    require(pipeline_rules['FlinkJobManagerRestarting']['expr'] ==
            'changes(container_start_time_seconds{job="kubelet-resource",namespace="streaming",'
            'container="flink-main-container"}[15m]) >= 2 or '
            'resets(flink_jobmanager_Status_JVM_CPU_Time{job="flink"}[15m]) >= 2' and
            pipeline_rules['FlinkJobManagerRestarting']['for'] == '5m' and
            pipeline_rules['FlinkJobManagerRestarting']['labels']['severity'] == 'warning',
            'FlinkJobManagerRestarting rule drift')
    # D-ALERT-29: freshness rules keep exact expressions, windows and severities.
    require(pipeline_rules['FlinkCheckpointsStalled']['expr'] == 'changes(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink"}[10m]) == 0' and
            pipeline_rules['FlinkCheckpointsStalled']['for'] == '5m' and
            pipeline_rules['FlinkCheckpointsStalled']['labels']['severity'] == 'critical',
            'FlinkCheckpointsStalled rule drift')
    require(pipeline_rules['FlinkCheckpointsFailing']['expr'] == 'changes(flink_jobmanager_job_numberOfFailedCheckpoints{job="flink"}[15m]) >= 3' and
            pipeline_rules['FlinkCheckpointsFailing']['for'] == '5m' and
            pipeline_rules['FlinkCheckpointsFailing']['labels']['severity'] == 'warning',
            'FlinkCheckpointsFailing rule drift')
    # D-ALERT-30: one absent() per expected SQL job, exact names.
    require(pipeline_rules['FlinkJobMissing']['expr'] == '(absent(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink",job_name="beluga_cdc_orders"}) or absent(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink",job_name="beluga_cdc_customers"}) or absent(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink",job_name="beluga_events_sessionization"})) and on() up{job="flink"} == 1' and
            pipeline_rules['FlinkJobMissing']['for'] == '10m' and
            pipeline_rules['FlinkJobMissing']['labels']['severity'] == 'critical',
            'FlinkJobMissing rule drift')


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


def validate_restart_owners(docs, data):
    # D-ALERT-23: prove exclusion against rendered Jobs, including hooks, in each
    # profile. Cost: naming contract; escape: owner metadata for arbitrary workloads.
    rules = yaml.safe_load(data['pipeline.yml'])['groups'][0]['rules']
    expr = next(r['expr'] for r in rules if r['alert'] == 'ContainerRestartingFrequently')
    pattern = re.search(r'pod=~"([^" ]+)"', expr)[1]
    for doc in docs:
        kind = doc['kind']
        name = doc['metadata']['name']
        if kind == 'Deployment':
            pod = name + '-bcdfg24567-bcdfg'
        elif kind == 'StatefulSet':
            pod = name + '-0'
        elif kind == 'Job':
            pod = name + '-bcdfg'
            require(not re.fullmatch(pattern, pod), f'Job included in restart rule: {name}')
            continue
        else:
            continue
        require(re.fullmatch(pattern, pod), f'chart controller missing from restart rule: {name}')


def validate_memory_inhibition(config):
    # D-ALERT-27: rationale in gitops/charts/beluga-platform/values.yaml.
    expected = {
        'source_matchers': ['alertname="NodeMemoryLow"', 'severity="critical"'],
        'target_matchers': ['alertname="NodeMemoryLow"', 'severity="warning"'],
        'equal': ['node'],
    }
    require(expected in config.get('inhibit_rules', []), 'node memory inhibition missing or drifted')
