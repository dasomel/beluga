#!/usr/bin/env python3
"""Positive, missing and tampered offline lineage fixtures."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/ci/check-column-lineage.py'
spec = importlib.util.spec_from_file_location('column_lineage', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FIXTURES = ROOT / 'tests/fixtures/column-lineage'


class ColumnLineageTests(unittest.TestCase):
    def test_normal(self):
        result = module.parse((FIXTURES / 'normal.sql').read_text())
        self.assertEqual(len(result), 4)
        self.assertTrue(all(t['status'] == 'resolved' for t in result))
        self.assertEqual(result[0]['columns'][1]['sources'], [{'dataset': 'source_orders', 'column': 'amount'}])
        self.assertEqual(result[1]['columns'][1]['target_column'], 'customer_name')
        self.assertEqual(result[1]['columns'][1]['sources'], [{'dataset': 'customers', 'column': 'name'}])
        self.assertEqual(result[1]['columns'][4]['sources'], [])
        self.assertEqual(result[2]['columns'][1]['sources'], [{'dataset': 'source_orders', 'column': 'amount'}])
        self.assertEqual(result[3]['columns'][0]['target_column'], 'amount')

    def test_unknown(self):
        result = module.parse((FIXTURES / 'unknown.sql').read_text())
        self.assertEqual(len(result), 10)
        for transformation in result:
            with self.subTest(target=transformation['target']):
                self.assertEqual(transformation['status'], 'unknown')
                self.assertTrue(transformation['reasons'] or any(c['reasons'] for c in transformation['columns']))
                self.assertTrue(all(not c['sources'] for c in transformation['columns']))

    def test_repository(self):
        report = module.generate(ROOT)
        self.assertEqual(len(report['transformations']), 4)
        self.assertEqual(sum(len(t['columns']) for t in report['transformations']), 15)
        self.assertTrue(all(t['status'] == 'resolved' for t in report['transformations'][:3]))
        self.assertEqual(report, module.generate(ROOT))

    def test_quoted_comments_and_join_expression(self):
        result = module.parse('''-- SELECT bogus;
CREATE TABLE "Orders" ("Id" INT, amount INT);
CREATE TABLE b (id INT);
CREATE VIEW v AS SELECT a."Id" + b.id AS combined,
 replace('it''s; -- text', ';', '') AS label /* ; SELECT */
FROM "Orders" AS a JOIN b ON a."Id" = b.id;''')
        self.assertEqual(result[0]['status'], 'resolved')
        self.assertEqual(result[0]['columns'][0]['sources'], [
            {'dataset': 'Orders', 'column': 'Id'}, {'dataset': 'b', 'column': 'id'}])

    def test_missing_and_invalid_targets(self):
        for sql in (
            'CREATE TABLE a (id INT); INSERT INTO missing SELECT id FROM a;',
            'CREATE TABLE a (id INT); INSERT INTO a (missing) SELECT id FROM a;',
            'CREATE TABLE a (id INT); CREATE VIEW v AS SELECT FROM a;',
            'CREATE TABLE a (id INT); CREATE VIEW v AS SELECT AS id FROM a;',
        ):
            with self.subTest(sql=sql):
                self.assertEqual(module.parse(sql)[0]['status'], 'unknown')

    def test_keyword_column_and_multiplication(self):
        result = module.parse('CREATE TABLE a (date INT); CREATE VIEW v AS SELECT date * 2 AS doubled FROM a;')
        self.assertEqual(result[0]['columns'][0]['sources'], [{'dataset': 'a', 'column': 'date'}])

    def run_cli(self, root, *args):
        return subprocess.run([sys.executable, str(SCRIPT), '--root', str(root), *args], capture_output=True, text=True)

    def test_report_missing_tampered_and_sql_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sql = root / 'sql/example.sql'
            sql.parent.mkdir()
            sql.write_text((FIXTURES / 'normal.sql').read_text())
            output = root / module.REPORT
            self.assertEqual(self.run_cli(root, '--check').returncode, 1)
            self.assertEqual(self.run_cli(root, '--output', str(output)).returncode, 0)
            self.assertEqual(self.run_cli(root, '--check').returncode, 0)
            original = output.read_text()
            tampered = json.loads(original)
            tampered['transformations'][0]['columns'][0]['sources'] = []
            output.write_text(json.dumps(tampered, indent=2) + '\n')
            self.assertEqual(self.run_cli(root, '--check').returncode, 1)
            output.write_text(original)
            sql.write_text(sql.read_text().replace('upper(c.name)', 'upper(c.id)'))
            self.assertEqual(self.run_cli(root, '--check').returncode, 1)
            sql.unlink()
            self.assertEqual(self.run_cli(root, '--check').returncode, 1)


if __name__ == '__main__':
    unittest.main()
