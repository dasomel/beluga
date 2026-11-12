"""Offline execution of the actual maintenance bootstrap, with synthetic transport."""
import ast
import contextlib
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DAGS = ROOT / 'gitops/charts/beluga-data/files/dags'
SOURCE = (DAGS / 'iceberg_maintenance.py').read_text()
TREE = ast.parse(SOURCE)
BOOTSTRAP = next(ast.literal_eval(n.value) for n in TREE.body
                 if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'BOOTSTRAP' for t in n.targets))
TABLES = ('lake.orders', 'lake.customers', 'lake.events_enriched', 'silver_shop.orders', 'gold_shop.daily_revenue')


class UserError(Exception):
    def __init__(self, name):
        self.error_name = name


class MaintenanceTest(unittest.TestCase):
    def run_bootstrap(self, error_name=None, failed_table='silver_shop.orders', fail_fetch=False):
        env = {'MAINTENANCE_CLIENT_SECRET': 'synthetic-secret'}
        executed, fetched = [], []
        def post(url, data, timeout):
            self.assertEqual(url, 'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token')
            self.assertEqual(data, {'grant_type': 'client_credentials', 'client_id': 'maintenance',
                                    'scope': 'openid', 'client_secret': 'synthetic-secret'})
            self.assertEqual(timeout, 30)
            self.assertNotIn('MAINTENANCE_CLIENT_SECRET', env)
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'access_token': 'synthetic-token'})
        class Cursor:
            def execute(self, sql):
                executed.append(sql)
                if error_name and f'iceberg.{failed_table} ' in sql and not fail_fetch:
                    raise UserError(error_name)
            def fetchall(self):
                if error_name and f'iceberg.{failed_table} ' in executed[-1] and fail_fetch:
                    raise UserError(error_name)
                fetched.append(executed[-1])
            def close(self):
                pass
        def connect(**kwargs):
            self.assertEqual(kwargs, dict(host='trino.analytics.svc.cluster.local', port=8443,
                http_scheme='https', user='svc-maintenance', auth=('jwt', 'synthetic-token'),
                verify='/etc/internal-ca/ca.crt'))
            return SimpleNamespace(cursor=Cursor, close=lambda: None)
        modules = {'os': SimpleNamespace(environ=env), 'requests': SimpleNamespace(post=post),
                   'trino.auth': SimpleNamespace(JWTAuthentication=lambda token: ('jwt', token)),
                   'trino.dbapi': SimpleNamespace(connect=connect),
                   'trino.exceptions': SimpleNamespace(TrinoUserError=UserError)}
        output = io.StringIO()
        with patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
            exec(BOOTSTRAP, {})
        self.assertNotIn('synthetic-secret', output.getvalue())
        self.assertNotIn('synthetic-token', output.getvalue())
        return executed, fetched, output.getvalue()

    def test_all_tables_and_procedures_fetch_results(self):
        executed, fetched, output = self.run_bootstrap()
        expected = [f'ALTER TABLE iceberg.{table} EXECUTE {procedure}' for table in TABLES
                    for procedure in ('optimize', "expire_snapshots(retention_threshold => '7d')")]
        self.assertEqual(executed, expected)
        self.assertEqual(fetched, expected)
        self.assertEqual(output, '')

    def test_missing_table_skips_only_that_table(self):
        for table in TABLES:
            for fail_fetch in (False, True):
                executed, fetched, output = self.run_bootstrap('TABLE_NOT_FOUND', table, fail_fetch)
                self.assertIn(f'SKIP: iceberg.{table}: TABLE_NOT_FOUND', output)
                self.assertEqual(len(executed), 9)
                self.assertEqual(len(fetched), 8)
                self.assertIn('iceberg.gold_shop.daily_revenue', executed[-1])

    def test_other_errors_fail_task(self):
        for name in ('PERMISSION_DENIED', 'SCHEMA_NOT_FOUND', 'GENERIC_INTERNAL_ERROR'):
            for fail_fetch in (False, True):
                with self.assertRaises(UserError):
                    self.run_bootstrap(name, fail_fetch=fail_fetch)

    def test_both_kpo_resource_bounds(self):
        for name in ('dbt_shop_medallion.py', 'iceberg_maintenance.py'):
            tree = ast.parse((DAGS / name).read_text())
            pod = next(n for n in ast.walk(tree) if isinstance(n, ast.Call)
                       and isinstance(n.func, ast.Name) and n.func.id == 'KubernetesPodOperator')
            resources = next(k.value for k in pod.keywords if k.arg == 'container_resources')
            self.assertIsInstance(resources.func, ast.Attribute)
            self.assertEqual(resources.func.value.id, 'k8s')
            self.assertEqual(resources.func.attr, 'V1ResourceRequirements')
            values = {k.arg: ast.literal_eval(k.value) for k in resources.keywords}
            for section in ('requests', 'limits'):
                self.assertEqual(set(values[section]), {'cpu', 'memory', 'ephemeral-storage'})
                self.assertTrue(all(values[section].values()))
            # These pods mount only a CA ConfigMap; no scratch volume is being hidden.
            self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'V1EmptyDirVolumeSource'
                                 for n in ast.walk(pod)))
            self.assertFalse(any(k.arg in ('security_context', 'container_security_context')
                                 for k in pod.keywords))
        image = (ROOT / 'images/dbt/Dockerfile').read_text()
        self.assertIn('install -d -o dbt -g dbt /opt/beluga/dbt', image)
        self.assertIn('COPY --chown=dbt:dbt dbt/ /opt/beluga/dbt/', image)
        self.assertIn('USER dbt', image)

    def test_operator_contract_and_bootstrap_credential_isolation(self):
        def kwargs(tree, name):
            return next({k.arg: k.value for k in n.keywords} for n in ast.walk(tree)
                        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name)
        dag = kwargs(TREE, 'DAG')
        for key, value in {'schedule': '@hourly', 'catchup': False,
                           'is_paused_upon_creation': True, 'max_active_runs': 1}.items():
            self.assertEqual(ast.literal_eval(dag[key]), value)
        pod = kwargs(TREE, 'KubernetesPodOperator')
        dbt_pod = kwargs(ast.parse((DAGS / 'dbt_shop_medallion.py').read_text()), 'KubernetesPodOperator')
        self.assertEqual(ast.literal_eval(pod['image']), ast.literal_eval(dbt_pod['image']))
        for key, value in {'namespace': 'analytics', 'log_pod_spec_on_failure': False,
                           'on_finish_action': 'delete_pod', 'cmds': ['python', '-c']}.items():
            self.assertEqual(ast.literal_eval(pod[key]), value)
        self.assertIn('name="keycloak-maintenance-client-secret", key="maintenance"', SOURCE)
        self.assertIn('name="internal-ca", mount_path="/etc/internal-ca", read_only=True', SOURCE)
        self.assertIn('name="beluga-internal-ca"', SOURCE)
        bootstrap = (ROOT / 'scripts/gitops/01-argocd-bootstrap.sh').read_text()
        self.assertIn('ensure_cred client-secret-maintenance', bootstrap)
        self.assertIn('CLIENT_SECRET_MAINTENANCE="$(get_cred client-secret-maintenance)"', bootstrap)
        loops = bootstrap.split('for ns in ')
        dedicated = next(b for b in loops if 'create secret generic keycloak-maintenance-client-secret ' in b)
        self.assertTrue(dedicated.startswith('iam analytics; do\n'))
        self.assertIn('--from-literal=maintenance="${CLIENT_SECRET_MAINTENANCE}"', dedicated.split('done', 1)[0])
        shared = next(b for b in loops if b.startswith('iam analytics orchestration governance platform-system; do'))
        self.assertNotIn('--from-literal=maintenance=', shared.split('done', 1)[0])


if __name__ == '__main__':
    unittest.main()
