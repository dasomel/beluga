"""Offline protocol/decision regressions; no cluster or network access."""
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts/common'), str(ROOT / 'scripts/ops')]
import live_checks as live
import pipeline_e2e as pipeline


class PipelineTests(unittest.TestCase):
    def test_key_and_marker_both_required(self):
        event = {'op': 'c', 'after': {'order_id': 7, 'status': 'unique'}}
        line = json.dumps({'order_id': 7}) + '\t' + json.dumps(event)
        self.assertTrue(pipeline.event_matches(line, 7, 'unique'))
        self.assertFalse(pipeline.event_matches(line, 8, 'unique'))
        self.assertFalse(pipeline.event_matches(line, 7, 'different'))
        event['op'] = 'u'
        self.assertFalse(pipeline.event_matches(json.dumps({'order_id': 7}) + '\t' + json.dumps(event), 7, 'unique'))

    def test_schema_envelopes_and_tombstones(self):
        line = json.dumps({'payload': {'order_id': 7}}) + '\t' + json.dumps({
            'payload': {'op': 'c', 'after': {'order_id': 7, 'status': 'unique'}}})
        self.assertTrue(pipeline.event_matches(line, 7, 'unique'))
        for line in ('null\tnull', 'noise', '{}\t{}', '{}\tnull'):
            self.assertFalse(pipeline.event_matches(line, 7, 'unique'))

    def test_shared_token_form_encoding(self):
        with patch.object(live.urllib.request, 'urlopen', return_value=io.StringIO('{"access_token":"token"}')) as opened:
            token = live.request_token('https://issuer', {'password': 'p&a=ss', 'scope': 'openid'})
            self.assertEqual(token, 'token')
            self.assertEqual(opened.call_args.args[0].data, b'password=p%26a%3Dss&scope=openid')

    def test_query_accumulates_first_and_last_pages_and_trusts_base(self):
        pages = [{'data': [[1]], 'nextUri': 'http://untrusted:9080/v1/next?q=1'}, {'data': [[2]]}]
        responses = [io.StringIO(json.dumps(page)) for page in pages]
        with patch.object(live.urllib.request, 'urlopen', side_effect=responses) as opened:
            self.assertEqual(live.query('https://trusted', {}, None, 'SELECT status'), ([[1], [2]], None))
            self.assertEqual(opened.call_args_list[1].args[0].full_url, 'https://trusted/v1/next?q=1')

    def test_query_error_and_deadline(self):
        with patch.object(live.urllib.request, 'urlopen', return_value=io.StringIO('{"error":{"errorName":"DENIED"}}')):
            self.assertEqual(live.query('https://trusted', {}, None, 'SELECT status')[1]['errorName'], 'DENIED')
        with patch.object(live.urllib.request, 'urlopen') as opened:
            with self.assertRaises(TimeoutError):
                live.query('https://trusted', {}, None, 'SELECT status', timeout=0)
            opened.assert_not_called()

    def poll(self, observe, expected):
        now = [0]
        def advance(seconds):
            now[0] += seconds
        with patch.object(pipeline.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(pipeline.time, 'sleep', side_effect=advance):
            pipeline.wait_for('Iceberg UPDATE', observe, expected, seconds=10)

    def test_transient_observer_errors_retry_then_succeed(self):
        for error in (ValueError('Trino unavailable'), TimeoutError('Trino timeout'),
                      subprocess.CalledProcessError(1, ['kubectl']),
                      subprocess.TimeoutExpired('consumer', 60)):
            with self.subTest(error=error), patch.object(pipeline, 'internal_query',
                    side_effect=[error, [['new']]]) as observe:
                self.poll(observe, [['new']])

    def test_persistent_observer_error_reports_hop_and_last_error(self):
        with self.assertRaisesRegex(RuntimeError, 'Iceberg UPDATE: timeout.*last error=Trino unavailable'):
            self.poll(lambda: (_ for _ in ()).throw(ValueError('Trino unavailable')), [])

    def test_poll_requires_exact_rows(self):
        with self.assertRaisesRegex(RuntimeError, 'Iceberg UPDATE: timeout'):
            self.poll(lambda: [['old'], ['new']], [['new']])

    def test_secret_values_never_enter_subprocess_argv(self):
        import base64
        secrets = ['analyst-password-fixture', 'client-secret-fixture']
        outputs = [json.dumps({'data': {key: base64.b64encode(value.encode()).decode()}})
                   for key, value in zip(('user-password-analyst', 'trino'), secrets)]
        outputs.append('[[["ok"]], null]')
        with patch.object(live.subprocess, 'check_output', side_effect=outputs) as run:
            self.assertEqual(live.internal_query('SELECT status'), [['ok']])
        for call in run.call_args_list:
            for secret in secrets:
                self.assertNotIn(secret, ' '.join(call.args[0]))
        payload = json.loads(run.call_args.kwargs['input'])
        self.assertEqual(payload['password'], secrets[0])
        self.assertEqual(payload['client_secret'], secrets[1])

    def test_kafka_preflight_rejects_incompatible_listeners(self):
        for config in ({'listeners': []},
                       {'listeners': [{'port': 9092, 'tls': True}]},
                       {'listeners': [{'port': 9092, 'tls': False}], 'authorization': {'type': 'simple'}},
                       {'listeners': [{'port': 9092, 'tls': False, 'authentication': {'type': 'oauth'}}]}):
            with self.subTest(config=config), \
                    patch.object(pipeline, 'kubectl', return_value=json.dumps({'spec': {'kafka': config}})), \
                    patch.object(pipeline.signal, 'signal'):
                with self.assertRaisesRegex(RuntimeError, 'aclAuthorizer.*oauthListener'):
                    pipeline.main()

    def lifecycle(self, fail_insert=False, fail_update=False):
        marker = 'e2e_' + 'a' * 16
        statements = []
        def kube(*args, **kwargs):
            if 'shop-cdc/status' in args[-1]:
                return json.dumps({'connector': {'state': 'RUNNING'}, 'tasks': [{'state': 'RUNNING'}]})
            if 'kafka' in args:
                return json.dumps({'spec': {'kafka': {'listeners': [{'port': 9092, 'tls': False}]}}})
            if 'cluster' in args:
                return '{"status":{"currentPrimary":"primary-fixture"}}'
            if any('kafka-get-offsets' in arg for arg in args):
                return 'cdc.shop.public.orders:0:42'
            sql = args[-1]
            statements.append(sql)
            if sql.startswith('SELECT customer_id'):
                return '1'
            if sql.startswith('INSERT'):
                if fail_insert:
                    raise subprocess.TimeoutExpired('kubectl', 60)
                return '7\nINSERT 0 1'
            if sql.startswith('UPDATE'):
                if fail_update:
                    raise RuntimeError('source unavailable')
                return 'UPDATE 1'
            if sql.startswith('DELETE'):
                return 'DELETE 1'
            raise AssertionError(args)
        event = json.dumps({'order_id': 7}) + '\t' + json.dumps({
            'op': 'c', 'after': {'order_id': 7, 'status': marker}})
        proc = subprocess.CompletedProcess([], 1, event, 'TimeoutException')
        with patch.object(pipeline, 'kubectl', side_effect=kube), \
                patch.object(pipeline.uuid, 'uuid4', return_value=type('ID', (), {'hex': 'a' * 32})()), \
                patch.object(pipeline.signal, 'signal'), \
                patch.object(pipeline.subprocess, 'run', return_value=proc), \
                patch.object(pipeline, 'internal_query', side_effect=[[[marker, '12.34']], [[marker, '56.78']], []]), \
                patch('sys.stdout', new_callable=io.StringIO):
            if fail_insert or fail_update:
                with self.assertRaisesRegex(RuntimeError, 'Postgres INSERT' if fail_insert else 'Postgres UPDATE'):
                    pipeline.main()
            else:
                pipeline.main()
        self.assertEqual(statements[-1], f"DELETE FROM public.orders WHERE status = '{marker}'")
        return statements

    def test_complete_lifecycle_and_cleanup(self):
        statements = self.lifecycle()
        self.assertTrue(any(statement.startswith('UPDATE') for statement in statements))
        insert = next(statement for statement in statements if statement.startswith('INSERT'))
        self.assertIn('customer_id, total_amount, status', insert)
        self.assertIn('VALUES (1, 12.34,', insert)
        self.assertTrue(any(statement.startswith('DELETE') and 'order_id=7' in statement
                            for statement in statements))

    def test_cleanup_after_uncertain_insert(self):
        self.lifecycle(fail_insert=True)

    def test_cleanup_after_update_failure(self):
        self.lifecycle(fail_update=True)

    def test_sigterm_preserves_kubeconfig_until_child_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'kubectl').write_text('#!/bin/sh\necho fixture-config\n')
            (root / 'python3').write_text(
                '#!' + sys.executable + '\n'
                'import os, signal, time\nfrom pathlib import Path\n'
                'root = Path(os.environ["FIXTURE_ROOT"])\n'
                'config = Path(os.environ["KUBECONFIG"])\n'
                'def stop(*args):\n'
                '    time.sleep(0.1)\n'
                '    (root / "result").write_text(config.read_text())\n'
                '    raise SystemExit(143)\n'
                'signal.signal(signal.SIGTERM, stop)\n'
                '(root / "ready").write_text(str(config))\n'
                'while True: time.sleep(0.01)\n')
            for name in ('kubectl', 'python3'):
                (root / name).chmod(0o755)
            env = {**os.environ, 'PIPELINE_E2E': '1', 'KUBECONFIG': '/dev/null',
                   'PATH': directory + os.pathsep + os.environ['PATH'], 'FIXTURE_ROOT': directory}
            proc = subprocess.Popen(['bash', str(ROOT / 'tests/33-pipeline-e2e.sh')], env=env)
            try:
                deadline = time.monotonic() + 5
                while not (root / 'ready').exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue((root / 'ready').exists(), 'child did not start')
                config = Path((root / 'ready').read_text())
                proc.send_signal(signal.SIGTERM)
                self.assertEqual(proc.wait(timeout=5), 143)
                self.assertEqual((root / 'result').read_text(), 'fixture-config\n')
                self.assertFalse(config.exists())
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=5)

    def test_gate_skips_without_kubectl(self):
        result = subprocess.run(['bash', str(ROOT / 'tests/33-pipeline-e2e.sh')],
                                env={**os.environ, 'PIPELINE_E2E': '0', 'KUBECONFIG': '/dev/null'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SKIP: set PIPELINE_E2E=1', result.stdout)


if __name__ == '__main__':
    unittest.main()
