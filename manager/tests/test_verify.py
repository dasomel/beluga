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

    def test_ignored_dependency_directory_is_excluded_from_markdown_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dependency = root / "node_modules" / "some-package"
            dependency.mkdir(parents=True)
            (dependency / "README.md").write_text("[missing](does/not/exist.md)\n", encoding="utf-8")
            errors = VERIFY.verify(root)
        self.assertFalse(any("node_modules" in error for error in errors))

    def test_workflow_requires_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows"
            workflow.mkdir(parents=True)
            (workflow / "ci.yml").write_text("name: CI\non: [push]\n", encoding="utf-8")
            errors = VERIFY.validate_workflows(root)
        self.assertTrue(any("missing jobs" in error.lower() for error in errors))

    def test_agents_ko_is_a_required_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            errors = VERIFY.validate_required_files(root)
        self.assertTrue(any("AGENTS-ko.md" in error for error in errors))

    def test_broken_link_in_nested_build_output_directory_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "docs" / "build"
            nested.mkdir(parents=True)
            (nested / "guide.md").write_text("[missing](does/not/exist.md)\n", encoding="utf-8")
            errors = VERIFY.validate_markdown_links(root)
        self.assertTrue(any("docs/build/guide.md" in error for error in errors))

    def test_root_level_build_output_and_any_depth_node_modules_stay_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root_build = root / "build"
            root_build.mkdir()
            (root_build / "guide.md").write_text("[missing](does/not/exist.md)\n", encoding="utf-8")
            nested_dependency = root / "packages" / "x" / "node_modules" / "y"
            nested_dependency.mkdir(parents=True)
            (nested_dependency / "README.md").write_text("[missing](does/not/exist.md)\n", encoding="utf-8")
            errors = VERIFY.verify(root)
        self.assertFalse(any("build" in error for error in errors))
        self.assertFalse(any("node_modules" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
