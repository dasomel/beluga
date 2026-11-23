"""Offline protocol/decision regressions; no cluster or network access."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
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

    def test_dags_fail_closed_but_allow_paused(self):
        dags = [{'dag_id': name, 'is_paused': True} for name in
                ('dbt_shop_medallion', 'iceberg_table_maintenance')]
        live.require_dags(dags, [])
        for entries, errors in ((dags[:1], []), (dags, [{'error': 'bad import'}]), (dags, {})):
            with self.assertRaises(ValueError):
                live.require_dags(entries, errors)

    def test_data_path_requires_real_value(self):
        live.data_rows([['COMPLETED']])
        for rows in ([], [[None]], [[0]], [['']], [['a', 'b']]):
            with self.assertRaises(ValueError):
                live.data_rows(rows)

    def test_shared_token_form_encoding(self):
        with patch.object(live.urllib.request, 'urlopen', return_value=io.StringIO('{"access_token":"token"}')) as opened:
            token = live.request_token('https://issuer', {'password': 'p&a=ss', 'scope': 'openid'})
            self.assertEqual(token, 'token')
            self.assertEqual(opened.call_args.args[0].data, b'password=p%26a%3Dss&scope=openid')

    def test_airflow_structlog_filter(self):
        with patch.object(live, 'kubectl', return_value='2026-11-24T00:00:00Z [info] init\n[]\n') as kube:
            self.assertEqual(live.airflow('dags', 'list', '-o', 'json'), '[]')
            self.assertIn('deployment/airflow-webserver', kube.call_args.args)

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

    def test_poll_requires_exact_rows_and_times_out(self):
        with patch.object(pipeline.time, 'sleep'), patch.object(pipeline.time, 'monotonic', side_effect=[0, 0, 0, 241]):
            with self.assertRaisesRegex(RuntimeError, 'UPDATE.*timeout'):
                pipeline.wait_for('UPDATE', lambda: [['old'], ['new']], [['new']])

    def lifecycle(self, fail_insert=False, fail_update=False):
        marker = 'e2e_' + 'a' * 16
        statements = []
        def kube(*args, **kwargs):
            if 'shop-cdc/status' in args[-1]:
                return json.dumps({'connector': {'state': 'RUNNING'}, 'tasks': [{'state': 'RUNNING'}]})
            if 'cluster' in args:
                return '{"status":{"currentPrimary":"primary-fixture"}}'
            if any('kafka-get-offsets' in arg for arg in args):
                return 'cdc.shop.public.orders:0:42'
            sql = args[-1]
            statements.append(sql)
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
        self.assertEqual(sum(statement.startswith('DELETE') for statement in statements), 2)

    def test_cleanup_after_uncertain_insert(self):
        self.lifecycle(fail_insert=True)

    def test_cleanup_after_update_failure(self):
        self.lifecycle(fail_update=True)

    def test_gate_skips_without_kubectl(self):
        result = subprocess.run(['bash', str(ROOT / 'tests/33-pipeline-e2e.sh')],
                                env={**os.environ, 'PIPELINE_E2E': '0', 'KUBECONFIG': '/dev/null'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SKIP: set PIPELINE_E2E=1', result.stdout)


if __name__ == '__main__':
    unittest.main()
