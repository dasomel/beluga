#!/usr/bin/env python3
"""Good/missing/tampered fixtures exercise the preflight CLI, offline."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/ci/check-source-onboarding.py"
FIXTURES = ROOT / "tests/fixtures/source-onboarding"
spec = importlib.util.spec_from_file_location("source_onboarding", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class SourceOnboardingTests(unittest.TestCase):
    def run_check(self, root):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(root)],
            capture_output=True, text=True, check=False,
        )

    def prepare(self, root):
        for path in (checker.CONNECTOR, checker.SCHEMA):
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / path).read_bytes())
        target = root / checker.MANIFEST
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((FIXTURES / "good.json").read_bytes())

    def test_repository_and_good_fixture(self):
        result = self.run_check(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.prepare(root)
            result = self.run_check(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("static only", result.stdout)

    def test_bad_fixtures_fail_closed(self):
        cases = json.loads((FIXTURES / "bad-cases.json").read_text())
        good = json.loads((FIXTURES / "good.json").read_text())
        for case in cases:
            with self.subTest(case=case["name"]), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.prepare(root)
                if "file" in case:
                    path = root / {"connector": checker.CONNECTOR, "schema": checker.SCHEMA}[case["file"]]
                    original = path.read_text()
                    self.assertEqual(original.count(case["old"]), 1, "stale tamper fixture")
                    path.write_text(original.replace(case["old"], case["new"]))
                else:
                    manifest = copy.deepcopy(good)
                    keys = case.get("delete", case.get("set"))
                    target = manifest
                    for key in keys[:-1]:
                        target = target[key]
                    if "delete" in case:
                        del target[keys[-1]]
                    else:
                        target[keys[-1]] = case["value"]
                    (root / checker.MANIFEST).write_text(json.dumps(manifest))
                result = self.run_check(root)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(case["error"], result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_missing_files(self):
        for path in (checker.MANIFEST, checker.CONNECTOR, checker.SCHEMA):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.prepare(root)
                (root / path).unlink()
                result = self.run_check(root)
                self.assertEqual(result.returncode, 1)
                self.assertIn("FAIL source onboarding:", result.stderr)

    def test_invalid_json_and_duplicate_keys(self):
        for content in ("{", "[]", '{"owner":"one","owner":"two"}'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.prepare(root)
                (root / checker.MANIFEST).write_text(content)
                result = self.run_check(root)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
