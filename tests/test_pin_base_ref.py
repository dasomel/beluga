#!/usr/bin/env python3
"""PR base wiring and fail-closed image baseline regression tests (#103)."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "pin_enforcement", ROOT / "scripts/ci/check-pin-enforcement.py"
)
pin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pin)
BASE_SHA = "a" * 40


class PinBaseRefTests(unittest.TestCase):
    def compare(self, current, ceiling, base="images:\n- repository: old/image\n"):
        responses = [
            subprocess.CompletedProcess([], 0, base),
            subprocess.CompletedProcess([], 0, "BASELINE_CEILING = 1\n"),
        ]
        with patch.object(pin.subprocess, "run", side_effect=responses) as run, \
                patch.object(pin, "load_baseline", return_value=current), \
                patch.object(pin, "BASELINE_CEILING", ceiling):
            errors = pin.base_growth_errors(BASE_SHA)
        self.assertEqual(run.call_args_list[0].args[0], [
            "git", "show", f"{BASE_SHA}:scripts/ci/image-digest-baseline.yaml"
        ])
        self.assertEqual(run.call_args_list[1].args[0], [
            "git", "show", f"{BASE_SHA}:scripts/ci/check-pin-enforcement.py"
        ])
        return errors

    def test_existing_baseline_is_allowed(self):
        self.assertEqual(self.compare({"old/image": "existing"}, 1), [])

    def test_baseline_can_shrink(self):
        self.assertEqual(self.compare({}, 0), [])

    def test_new_image_cannot_be_hidden_by_raising_ceiling(self):
        errors = self.compare({"old/image": "existing", "new/image": "new"}, 2)
        self.assertTrue(any("new/image" in error for error in errors))
        self.assertTrue(any("BASELINE_CEILING grew" in error for error in errors))

    def test_replacement_fails_even_without_count_growth(self):
        self.assertTrue(any("new/image" in error for error in
                            self.compare({"new/image": "replacement"}, 1)))

    def test_invalid_ref_fails_closed(self):
        with patch.object(pin.subprocess, "run", return_value=
                          subprocess.CompletedProcess([], 1, "")):
            self.assertIn("not a valid ref", pin.base_growth_errors(BASE_SHA)[0])

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", repo, *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def test_missing_object_sha_fails_closed_in_real_repo(self):
        with tempfile.TemporaryDirectory() as repo:
            self.git(repo, "init", "-q")
            self.git(repo, "-c", "user.name=t", "-c", "user.email=t@t",
                     "commit", "-q", "--allow-empty", "-m", "init")
            with patch.object(pin, "REPO_ROOT", Path(repo)):
                errors = pin.base_growth_errors(BASE_SHA)
        self.assertEqual(len(errors), 1)
        self.assertIn("not a valid ref", errors[0])

    def test_existing_commit_without_gate_is_first_introduction(self):
        with tempfile.TemporaryDirectory() as repo:
            self.git(repo, "init", "-q")
            self.git(repo, "-c", "user.name=t", "-c", "user.email=t@t",
                     "commit", "-q", "--allow-empty", "-m", "init")
            sha = self.git(repo, "rev-parse", "HEAD")
            with patch.object(pin, "REPO_ROOT", Path(repo)):
                self.assertEqual(pin.base_growth_errors(sha), [])

    def test_push_without_base_skips_git_reads(self):
        with patch.object(pin.subprocess, "run") as run:
            self.assertEqual(pin.base_growth_errors(""), [])
        run.assert_not_called()

    def test_ci_passes_event_base_sha_with_full_history(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
        steps = workflow["jobs"]["validate"]["steps"]
        checkout = next(step for step in steps if step.get("name") == "Checkout")
        self.assertEqual(checkout["with"]["fetch-depth"], 0)
        validate = next(step for step in steps if step.get("run") == "make validate")
        self.assertEqual(validate["env"]["PIN_BASE_REF"],
                         "${{ github.event_name == 'pull_request' && "
                         "github.event.pull_request.base.sha || '' }}")


if __name__ == "__main__":
    unittest.main()
