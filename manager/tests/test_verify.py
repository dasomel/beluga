from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify.py"
SPEC = importlib.util.spec_from_file_location("beluga_manager_verify", SCRIPT)
assert SPEC and SPEC.loader
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class VerifyTests(unittest.TestCase):
    def test_cli_fails_nonzero_for_invalid_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", tmp],
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("Missing required file", result.stdout)

    def test_broken_local_markdown_link_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("[missing](docs/missing.md)\n", encoding="utf-8")
            errors = VERIFY.validate_markdown_links(root)
        self.assertTrue(any("Broken local link" in error for error in errors))

    def test_workflow_requires_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows"
            workflow.mkdir(parents=True)
            (workflow / "ci.yml").write_text("name: CI\non: [push]\n", encoding="utf-8")
            errors = VERIFY.validate_workflows(root)
        self.assertTrue(any("missing jobs" in error.lower() for error in errors))


if __name__ == "__main__":
    unittest.main()
