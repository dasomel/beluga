#!/usr/bin/env python3
"""Positive, missing and tampered ODCS fixtures; no cluster or dependencies."""

import copy
import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/ci/check-data-contracts.py"
GATE = runpy.run_path(str(CHECKER))
FIXTURES = ROOT / "tests/fixtures/data-contracts"
SQL = (ROOT / GATE["DDL"]).read_text(encoding="utf-8")


class DataContractsTest(unittest.TestCase):
    def setUp(self):
        self.good = GATE["load_contract"](FIXTURES / "good.json")

    def test_good_and_repository_contract(self):
        GATE["validate"](self.good, SQL)
        GATE["validate"](GATE["load_contract"](ROOT / GATE["CONTRACT"]), SQL)

    def test_bad_fixtures(self):
        for name, message in (("missing-id.json", "contract.id"),
                              ("tampered-type.json", "schema drift")):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, message):
                GATE["validate"](GATE["load_contract"](FIXTURES / name), SQL)

    def test_required_fields(self):
        for key in ("apiVersion", "kind", "id", "version", "status", "schema", "team"):
            for value in (None, [], "", 42):
                bad = copy.deepcopy(self.good)
                bad[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    GATE["validate"](bad, SQL)

    def test_contract_drift_and_duplicates(self):
        for change in ("remove", "add", "rename", "duplicate", "logical"):
            bad = copy.deepcopy(self.good)
            props = bad["schema"][0]["properties"]
            if change == "remove":
                props.pop()
            elif change in {"add", "duplicate"}:
                props.append(copy.deepcopy(props[0]))
                if change == "add":
                    props[-1]["name"] = "extra_column"
            elif change == "rename":
                props[0]["name"] = "renamed_user"
            else:
                props[0]["logicalType"] = "integer"
            with self.subTest(change=change), self.assertRaises(ValueError):
                GATE["validate"](bad, SQL)

    def test_ddl_changes(self):
        for old, new in (("event_count BIGINT", "event_count STRING"),
                         ("event_count BIGINT,", ""),
                         ("event_count BIGINT,", "event_count BIGINT, extra BIGINT,"),
                         ("event_count BIGINT", "event_count DECIMAL(10,2)"),
                         ("event_count BIGINT", "event_count BIGINT NOT NULL"),
                         ("lakekeeper.lake.events_enriched (", "lakekeeper.lake.other (")):
            with self.subTest(new=new), self.assertRaises(ValueError):
                GATE["validate"](self.good, SQL.replace(old, new))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            GATE["validate"](self.good, SQL + SQL)
        GATE["validate"](self.good, SQL.replace("event_count BIGINT", "event_count /* type */ bigint"))

    def test_cli_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "contract.json"
            for content, message in ((None, "FAIL data contracts"),
                                     ("{", "FAIL data contracts"),
                                     ('{"id": "first", "id": "second"}', "duplicate JSON key"),
                                     (json.dumps([]), "expected object")):
                if content is not None:
                    path.write_text(content, encoding="utf-8")
                result = subprocess.run([sys.executable, str(CHECKER), "--contract", str(path)],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(message, result.stderr)
            result = subprocess.run([sys.executable, str(CHECKER), "--root", directory],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
