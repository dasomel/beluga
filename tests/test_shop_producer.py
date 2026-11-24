#!/usr/bin/env python3
"""Offline behavior and rendered deployment contracts for shop CDC traffic."""
import ast
import importlib.util
import os
import subprocess
import sys
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/ci"))
from alerting_network_contract import SHOP_SPECS

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'gitops/charts/beluga-data/files/shop-producer.py'
spec = importlib.util.spec_from_file_location('shop_producer', SCRIPT)
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ProducerTest(unittest.TestCase):
    def test_mix_and_caps_across_restarts(self):
        orders, customers = 3, 3
        seen = Counter()
        # Tick resets on restart; the DB counts remain authoritative.
        for _ in range(3):
            for tick in range(200):
                action = producer.operation(tick, orders, customers, 10, 5)
                seen[action] += 1
                orders += (action == 'insert_order') - (action == 'delete_order')
                customers += action == 'insert_customer'
                self.assertTrue(0 <= orders <= 11)
                self.assertTrue(1 <= customers <= 5)
        self.assertEqual(set(seen), set(producer.SQL))

    def test_empty_database_and_lowered_cap(self):
        self.assertEqual(producer.operation(0, 0, 0, 1, 1), 'insert_customer')
        self.assertEqual(producer.operation(0, 0, 1, 1, 1), 'insert_order')
        self.assertEqual(producer.operation(5, 10, 3, 2, 3), 'delete_order')
        self.assertEqual(producer.operation(8, 0, 3, 10, 3), 'update_customer')
        for tick in range(10):
            self.assertNotIn(producer.operation(tick, 0, 1, 10, 2), ('delete_order', 'update_order'))

    def test_delete_only_above_cap_at_low_rate(self):
        for count in (3, 9, 10):
            for tick in range(30):
                self.assertNotEqual(producer.operation(tick, count, 3, 10, 3), 'delete_order')
        deletes = [tick for tick in range(30)
                   if producer.operation(tick, 11, 3, 10, 3) == 'delete_order']
        self.assertEqual(deletes, [5, 15, 25])

    def test_delete_preserves_seed_and_unowned_rows(self):
        import sqlite3
        db = sqlite3.connect(':memory:')
        db.execute('CREATE TABLE orders (order_id INTEGER, generator_owned BOOLEAN NOT NULL DEFAULT false)')
        db.executemany('INSERT INTO orders VALUES (?, ?)',
                       [(1, False), (2, False), (3, False), (4, True)])
        for order_id in (1, 2, 3, 4):
            db.execute(producer.SQL['delete_order'].replace('public.', '').replace('%s', '?'), (order_id,))
        self.assertEqual(db.execute('SELECT order_id FROM orders ORDER BY order_id').fetchall(),
                         [(1,), (2,), (3,)])
        for tick in range(4):
            _, params = producer.statement('insert_order', None, 1, tick, 'unit.invalid')
            self.assertIn(params[2], ('PENDING', 'SHIPPED', 'COMPLETED', 'CANCELLED'))
            self.assertIn('generator_owned) VALUES (%s, %s, %s, true)', producer.SQL['insert_order'])
            self.assertLessEqual(len(params[2]), 20)

    def test_parameterization_and_schema_values(self):
        hostile = "1; DROP TABLE public.orders; --"
        for action in producer.SQL:
            sql, params = producer.statement(action, hostile, hostile, 10, "unit.invalid")
            self.assertEqual(sql.count('%s'), len(params))
            self.assertNotIn(hostile, sql)
            self.assertIn('public.', sql)
        # Runtime execute calls accept only literal SQL or the parameterized statement tuple.
        for node in ast.walk(ast.parse(SCRIPT.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'execute':
                self.assertTrue(isinstance(node.args[0], (ast.Constant, ast.Starred)))

    def test_config_defaults_and_email_bound(self):
        with patch.dict(os.environ, {'EMAIL_DOMAIN': 'x' * 67}, clear=True):
            self.assertEqual(producer.config(), (3.0, 1000, 100, 20, 'x' * 67))
        _, params = producer.statement('insert_customer', None, None, 0, 'x' * 67)
        self.assertEqual(len(params[1]), 100)

    def test_bad_config(self):
        for name, value in [('MAX_ORDERS', '0'), ('MAX_CUSTOMERS', '-1'),
                            ('LOG_EVERY', 'x'), ('WRITE_INTERVAL_SECONDS', 'nan'),
                            ('WRITE_INTERVAL_SECONDS', '0.1'), ('WRITE_INTERVAL_SECONDS', 'inf'),
                            ('EMAIL_DOMAIN', ''), ('EMAIL_DOMAIN', 'x' * 68)]:
            with self.subTest(name=name, value=value), patch.dict(os.environ, {'EMAIL_DOMAIN': 'unit.invalid', name: value}):
                self.assertEqual(producer.main(), 2)

    def test_transaction_and_bound_parameters(self):
        from unittest.mock import MagicMock
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.side_effect = [(11,), (3,), (11,), (9,)]
        self.assertEqual(producer.write_once(conn, 5, 10, 3, "unit.invalid"), 'delete_order')
        self.assertEqual(cur.execute.call_args.args, (producer.SQL['delete_order'], (11,)))
        conn.__exit__.assert_called_once_with(None, None, None)

    def test_transaction_rolls_back_on_write_error(self):
        from unittest.mock import MagicMock
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.side_effect = [(3,), (3,), (11,), (9,)]
        cur.execute.side_effect = [None] * 5 + [RuntimeError('write failed')]
        with self.assertRaises(RuntimeError):
            producer.write_once(conn, 1, 10, 3, "unit.invalid")
        self.assertEqual(conn.__exit__.call_args.args[0], RuntimeError)

    def test_reconnect_backoff_and_no_secret_logging(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        class DatabaseError(Exception):
            pass
        driver = SimpleNamespace(Error=DatabaseError, connect=MagicMock(side_effect=DatabaseError('secret')))
        sleeps = []
        def sleep(delay):
            sleeps.append(delay)
        with patch.dict(os.environ, {'EMAIL_DOMAIN': 'unit.invalid'}), patch.dict('sys.modules', {'psycopg2': driver}), patch.object(producer.time, 'sleep', sleep), patch('builtins.print') as log:
            self.assertEqual(producer.main(), 1)
        self.assertEqual(sleeps, [1, 2, 4, 8, 16, 32])
        self.assertNotIn('secret', str(log.call_args_list))


class RenderTest(unittest.TestCase):
    @classmethod
    def render(cls, enabled=None):
        output = subprocess.check_output(['helm', 'template', str(ROOT / 'gitops/charts/beluga-data')] +
                                        (['--set', 'shopGenerator.enabled=' + enabled] if enabled else []),
                                        env={**os.environ, 'KUBECONFIG': '/dev/null'}, text=True)
        return [d for d in yaml.safe_load_all(output) if d]

    def test_lab_and_kakao_default_off(self):
        chart = ROOT / 'gitops/charts/beluga-data'
        for app_path in ('gitops/apps/beluga-data.yaml',
                         'csp/kakao-cloud/gitops/apps/beluga-data.yaml'):
            app = yaml.safe_load((ROOT / app_path).read_text())
            flags = [arg for path in app['spec']['source']['helm']['valueFiles']
                     for arg in ('-f', str(chart / path))]
            output = subprocess.check_output(['helm', 'template', str(chart), *flags],
                                             env={**os.environ, 'KUBECONFIG': '/dev/null'}, text=True)
            docs = [d for d in yaml.safe_load_all(output) if d]
            self.assertFalse(any(d['metadata']['name'].startswith('shop-gen') for d in docs))
            self.assertNotIn('managed', next(d for d in docs if d['kind'] == 'Cluster')['spec'])

    def test_enabled_and_disabled(self):
        docs = self.render('true')
        by_name = {d['metadata']['name']: d for d in docs}
        role = by_name['postgres-main']['spec']['managed']['roles'][0]
        self.assertEqual(role['name'], 'shop_generator')
        self.assertFalse(role['inherit'])
        self.assertNotIn('inRoles', role)
        self.assertNotIn('superuser', role)
        self.assertEqual(role['passwordSecret']['name'], 'shop-generator-db')
        self.assertEqual(by_name['shop-gen']['metadata']['annotations']['argocd.argoproj.io/ignore-healthcheck'], 'true')
        pod = by_name['shop-gen']['spec']['template']['spec']
        self.assertFalse(pod['automountServiceAccountToken'])
        env = {e['name']: e for e in pod['containers'][0]['env']}
        self.assertEqual(env['PGPASSWORD']['valueFrom']['secretKeyRef']['name'], 'shop-generator-db')
        ingress = by_name['shop-gen-db-ingress']['spec']
        self.assertFalse(ingress['enableDefaultDeny']['ingress'])
        self.assertEqual(ingress['ingress'][0]['toPorts'][0]['ports'], [{'port': '5432', 'protocol': 'TCP'}])
        for name, expected in SHOP_SPECS.items():
            self.assertEqual(by_name[name]['spec'], expected)
        grants = by_name['db-roles-schema']['data']['shop-generator-grants.sql']
        self.assertIn('public.orders, public.customers TO shop_generator', grants)
        self.assertIn('ADD COLUMN IF NOT EXISTS generator_owned BOOLEAN NOT NULL DEFAULT false', grants)
        self.assertNotIn('ALL TABLES', grants)
        self.assertNotIn('ALL SEQUENCES', grants)
        self.assertEqual(env['PGSSLMODE']['value'], 'verify-full')
        self.assertEqual(env['PGSSLROOTCERT']['value'], '/etc/postgres-ca/ca.crt')
        ca = next(v for v in pod['volumes'] if v['name'] == 'postgres-ca')['secret']
        self.assertEqual(ca, {'secretName': 'postgres-main-ca', 'items': [{'key': 'ca.crt', 'path': 'ca.crt'}]})
        hook = by_name['db-roles-setup']['spec']['template']['spec']['containers'][0]['command'][2]
        self.assertIn('while [ "$i" -lt 60 ]', hook)
        self.assertIn('sleep 5', hook)
        self.assertNotRegex(hook, r'until[^\n]*shop_generator')
        # Execute the rendered optional block without a DB or real sleeps.
        optional = hook[hook.index('i=0'):]
        for role, grant_rc in (('', 0), ('1', 0), ('1', 1)):
            fake = f'psql() {{ case "$*" in *pg_roles*) echo "{role}";; *) return {grant_rc};; esac; }}; sleep() {{ :; }}; '
            result = subprocess.run(['/bin/sh', '-c', 'set -eu; ' + fake + optional],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('db roles and D19 inheritance applied', result.stdout)
            if not role:
                self.assertEqual(result.stdout.count('waiting for CNPG'), 60)
                self.assertIn('skipping optional shop_generator grants', result.stderr)
            elif grant_rc:
                self.assertIn('apply failed', result.stderr)
        disabled = self.render()
        self.assertNotIn('shop_generator', next(d for d in disabled if d['metadata']['name'] == 'db-roles-setup')['spec']['template']['spec']['containers'][0]['command'][2])
        self.assertNotIn('shop-generator-grants.sql', next(d for d in disabled if d['metadata']['name'] == 'db-roles-schema')['data'])
        self.assertEqual(disabled, self.render('false'))
        self.assertFalse(any(d['metadata']['name'].startswith('shop-gen') for d in disabled))
        cluster = next(d for d in disabled if d['kind'] == 'Cluster')
        self.assertNotIn('managed', cluster['spec'])


if __name__ == '__main__':
    unittest.main()
