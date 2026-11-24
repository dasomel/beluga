#!/usr/bin/env python3
"""Offline responses exercise the read-only live probe; no cluster access."""
import copy
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('onboarding', ROOT / 'scripts/ci/check-source-onboarding.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
template = (ROOT / checker.CONNECTOR).read_text()
CONFIG = json.loads(re.search(r"BODY=\$\(cat <<'EOF'\n(.*?)\n\s*EOF\n", template, re.S)[1])
SLOT = {'active': True, 'database': 'shop', 'plugin': 'pgoutput', 'wal_status': 'reserved',
        'retained_bytes': 1024, 'confirmed_flush_lsn': '5/560399F8'}
FS = {'capacityBytes': 100000, 'availableBytes': 50000}
GOOD = {'config': CONFIG, 'state': {'max_slot_wal_keep_size_bytes': 1073741824, 'slots': [SLOT]},
        'cluster': {'status': {'currentPrimary': 'postgres-main-1'}},
        'nodes': {'items': [{'metadata': {'name': 'node-1'}, 'status': {'conditions': [
            {'type': 'DiskPressure', 'status': 'False'}]}}]},
        'stats': {'node': {'fs': FS, 'runtime': {'imageFs': FS}}},
        'pods': {'items': [{'metadata': {'name': 'connect-new'}, 'status': {'phase': 'Running'}}]},
        'du': '1024\t/kafka/logs\n'}

# This fake accepts only the precise read operations used by the probe. Any new
# write command fails rather than reaching a real kubectl through PATH.
KUBECTL = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
data = json.loads(Path(os.environ['CDC_PROBE_FIXTURE']).read_text())
args = sys.argv[1:]
if args[:1] == ['--kubeconfig'] and args[2:] == ['config', 'view', '--minify', '--flatten']:
    print('apiVersion: v1')
    sys.exit(0)
assert args.pop(0) == '--request-timeout=30s', args
if args == ['-n', 'streaming', 'exec', 'deploy/debezium-connect', '--', 'curl', '-fsS',
            '--max-time', '20', 'http://localhost:8083/connectors/shop-cdc/config']:
    key = 'config'
elif args == ['-n', 'streaming', 'get', 'pods', '-l', 'app=debezium-connect', '-o', 'json']:
    key = 'pods'
elif args[:4] == ['-n', 'streaming', 'exec', 'connect-new']:
    assert args[4:] == ['-c', 'connect', '--', 'du', '-sk', '/kafka/logs'], args
    if data['du'] is None:
        sys.exit(1)
    print(data['du'], end='')
    sys.exit(0)
elif args == ['-n', 'database', 'get', 'cluster', 'postgres-main', '-o', 'json']:
    key = 'cluster'
elif args[:7] == ['-n', 'database', 'exec', 'postgres-main-1', '-c', 'postgres', '--']:
    assert args[7:17] == ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'shop', '-Atc', args[-1]], args
    assert args[-1].strip().startswith('SELECT json_build_object('), args
    assert not any(word in args[-1].upper() for word in ('CHECKPOINT', 'DROP ', 'UPDATE ', 'INSERT '))
    key = 'state'
elif args == ['get', 'nodes', '-o', 'json']:
    key = 'nodes'
elif args == ['get', '--raw', '/api/v1/nodes/node-1/proxy/stats/summary']:
    key = 'stats'
else:
    raise SystemExit('unexpected kubectl operation: ' + repr(args))
print(json.dumps(data[key]))
'''


class CdcWalProbeTests(unittest.TestCase):
    def run_probe(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'kubectl').write_text(KUBECTL)
            (path / 'kubectl').chmod(0o755)
            fixture = path / 'response.json'
            fixture.write_text(json.dumps(data))
            env = {**os.environ, 'PATH': f'{path}:/usr/bin:/bin',
                   'CDC_PROBE_FIXTURE': str(fixture), 'KUBECONFIG': str(path / 'unused')}
            env.pop('CDC_WAL_MAX_BYTES', None)
            env.pop('NODE_FS_MIN_FREE_PERCENT', None)
            result = subprocess.run(['bash', str(ROOT / 'tests/29-cdc-slot-wal-retention.sh')],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertNotIn('__PGPASSWORD__', result.stdout + result.stderr)
            return result

    def test_healthy_responses(self):
        result = self.run_probe(GOOD)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('retained_bytes=1024', result.stdout)
        self.assertIn('filesystem=imagefs', result.stdout)

    def test_unhealthy_and_missing_responses_fail(self):
        cases = [
            (['state', 'max_slot_wal_keep_size_bytes'], -1, 'unlimited'),
            (['state', 'slots'], [], 'missing or ambiguous'),
            (['state', 'slots', 0, 'active'], False, 'inactive'),
            (['state', 'slots', 0, 'retained_bytes'], 1073741824, 'must be below'),
            (['state', 'slots', 0, 'retained_bytes'], None, 'must be below'),
            (['state', 'slots', 0, 'wal_status'], 'lost', 'WAL unavailable'),
            (['config', 'heartbeat.interval.ms'], '0', 'absent/disabled'),
            (['config', 'heartbeat.action.query'], '', 'singleton UPSERT'),
            (['nodes', 'items', 0, 'status', 'conditions', 0, 'status'], 'True', 'DiskPressure=True'),
            (['stats', 'node', 'runtime', 'imageFs', 'availableBytes'], 10000, 'free 10.00%'),
            (['stats', 'node', 'fs'], None, 'missing filesystem stats'),
            (['du'], '204801\t/kafka/logs\n', 'connect-new: /kafka/logs'),
            (['du'], 'garbage', 'invalid Connect log usage'),
            (['du'], '12\t/elsewhere\n', 'invalid Connect log usage'),
            (['du'], None, 'connect-new: Connect log usage exec failed'),
            (['pods', 'items'], [], 'no Running debezium-connect pod'),
            (['pods', 'items', 0, 'status', 'phase'], 'Pending', 'no Running debezium-connect pod'),
        ]
        for keys, value, error in cases:
            with self.subTest(keys=keys, value=value):
                data = copy.deepcopy(GOOD)
                target = data
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                result = self.run_probe(data)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(error, result.stderr)

    def test_log_usage_at_limit_passes(self):
        data = copy.deepcopy(GOOD)
        data['du'] = '204800\t/kafka/logs\n'
        result = self.run_probe(data)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('connect_log_bytes=209715200', result.stdout)

    def test_non_running_pods_are_skipped_and_other_checks_still_report(self):
        data = copy.deepcopy(GOOD)
        data['pods']['items'] += [
            {'metadata': {'name': 'connect-old', 'deletionTimestamp': 'x'}, 'status': {'phase': 'Running'}},
            {'metadata': {'name': 'connect-pending'}, 'status': {'phase': 'Pending'}}]
        self.assertEqual(self.run_probe(data).returncode, 0)
        data['state']['slots'][0]['active'] = False
        data['du'] = None
        result = self.run_probe(data)
        self.assertEqual(result.returncode, 1)
        self.assertIn('exec failed', result.stderr)
        self.assertIn('inactive', result.stderr)


class DemoTopicContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['helm', 'template', 'gitops/charts/beluga-data'],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        cls.documents = list(yaml.safe_load_all(result.stdout))

    def check_topics(self, documents):
        expected = {
            'cdc.shop.public.orders': 604800000,
            'cdc.shop.public.customers': 604800000,
            'events.clickstream': 604800000,
            'cdc.shop.public.cdc_heartbeat': 86400000,
            '__debezium-heartbeat.cdc.shop': 86400000,
        }
        topics = [doc for doc in documents if doc and doc.get('kind') == 'KafkaTopic']
        self.assertEqual(len(topics), len(expected))
        self.assertEqual({doc['spec']['topicName'] for doc in topics}, set(expected))
        for doc in topics:
            topic = doc['spec']['topicName']
            self.assertEqual(doc['metadata']['namespace'], 'streaming')
            self.assertEqual(doc['metadata']['labels']['strimzi.io/cluster'], 'beluga-kafka')
            self.assertNotIn('argocd.argoproj.io/hook', doc['metadata'].get('annotations', {}))
            self.assertEqual(doc['spec']['replicas'], 1)
            if topic in ('cdc.shop.public.cdc_heartbeat', '__debezium-heartbeat.cdc.shop'):
                self.assertEqual(doc['spec']['partitions'], 1)
                self.assertNotIn('argocd.argoproj.io/sync-options',
                                 doc['metadata'].get('annotations', {}))
                config = {'cleanup.policy': 'delete', 'retention.ms': expected[topic],
                          'segment.ms': 3600000}
            else:
                # Unpinned broker default: adoption must preserve existing partitions.
                self.assertNotIn('partitions', doc['spec'])
                self.assertEqual(doc['metadata'].get('annotations', {}).get(
                    'argocd.argoproj.io/sync-options'), 'Prune=false,Delete=false')
                # Adoption only makes the effective seven-day retention explicit.
                config = {'retention.ms': expected[topic]}
            self.assertEqual(doc['spec']['config'], config)

    def test_rendered_topics_and_adoption_defaults(self):
        self.check_topics(self.documents)
        kafka = next(doc for doc in self.documents if doc and doc.get('kind') == 'Kafka')
        self.assertEqual(kafka['metadata']['namespace'], 'streaming')
        self.assertEqual(kafka['spec']['entityOperator']['topicOperator'], {})
        config = kafka['spec']['kafka']['config']
        self.assertEqual(config['default.replication.factor'], 1)
        for key in ('num.partitions', 'min.insync.replicas', 'auto.create.topics.enable'):
            self.assertNotIn(key, config)
        self.assertFalse(any(key.startswith('log.retention.') for key in config))
        self.assertNotIn('topic.creation.', template)

    def test_missing_or_drifted_demo_topic_fails(self):
        for topic in ('cdc.shop.public.orders', 'cdc.shop.public.customers', 'events.clickstream'):
            for change in ('remove', 'partitions', 'replicas', 'retention.ms',
                           'guard', 'prune', 'delete', 'segment.ms', 'cleanup.policy'):
                with self.subTest(topic=topic, change=change):
                    documents = copy.deepcopy(self.documents)
                    doc = next(doc for doc in documents if doc and doc.get('kind') == 'KafkaTopic'
                               and doc['spec']['topicName'] == topic)
                    if change == 'remove':
                        documents.remove(doc)
                    elif change in ('retention.ms', 'segment.ms', 'cleanup.policy'):
                        doc['spec']['config'][change] = 1000
                    elif change == 'guard':
                        del doc['metadata']['annotations']['argocd.argoproj.io/sync-options']
                    elif change in ('prune', 'delete'):
                        doc['metadata']['annotations']['argocd.argoproj.io/sync-options'] = (
                            'Delete=false' if change == 'prune' else 'Prune=false')
                    else:
                        doc['spec'][change] = 2
                    with self.assertRaises(AssertionError):
                        self.check_topics(documents)


if __name__ == '__main__':
    unittest.main()
