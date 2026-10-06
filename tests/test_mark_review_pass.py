#!/usr/bin/env python3
"""Decision-logic tests for scripts/ci/mark-review-pass.py (SHA-bound independent-review status)."""
import contextlib
import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mark_review_pass", ROOT / "scripts/ci/mark-review-pass.py")
mrp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mrp)
SHA = "a" * 40


def pr(**kw):
    base = {"headRefOid": SHA, "isDraft": False, "state": "OPEN"}
    base.update(kw)
    return base


class PlanStatusTests(unittest.TestCase):
    def test_full_sha_equal_ok(self):
        self.assertEqual(mrp.plan_status(pr(), SHA), (True, SHA))

    def test_uppercase_accepted_and_lowercased(self):
        head = "ab" * 20
        self.assertEqual(mrp.plan_status(pr(headRefOid=head), head.upper()), (True, head))

    def test_prefix_and_wrong_length_refused(self):
        for bad in (SHA[:7], SHA[:39], SHA + "a", SHA[:8]):
            ok, why = mrp.plan_status(pr(), bad)
            self.assertFalse(ok, bad)
            self.assertIn("40-hex", why)

    def test_non_hex_and_missing_refused(self):
        for bad in (None, "", "z" * 40, "g" + "a" * 39, 123):
            self.assertFalse(mrp.plan_status(pr(), bad)[0])

    def test_sha_mismatch_refused_naming_both(self):
        other = "b" * 40
        ok, why = mrp.plan_status(pr(), other)
        self.assertFalse(ok)
        self.assertIn(other, why)
        self.assertIn(SHA, why)

    def test_draft_refused(self):
        ok, why = mrp.plan_status(pr(isDraft=True), SHA)
        self.assertFalse(ok)
        self.assertIn("draft", why)

    def test_closed_and_merged_refused(self):
        for state in ("CLOSED", "MERGED", None):
            self.assertFalse(mrp.plan_status(pr(state=state), SHA)[0])

    def test_missing_or_malformed_head_refused(self):
        for bad in (None, "", "abc123", "Z" * 40):
            self.assertFalse(mrp.plan_status(pr(headRefOid=bad), SHA)[0])
        self.assertFalse(mrp.plan_status({"isDraft": False, "state": "OPEN"}, SHA)[0])

    def test_unknown_draft_state_and_non_dict_refused(self):
        self.assertFalse(mrp.plan_status({"headRefOid": SHA, "state": "OPEN"}, SHA)[0])
        self.assertFalse(mrp.plan_status(None, SHA)[0])


class FakeGh:
    """Injectable gh runner: serves queued `pr view` JSON and records every call."""

    def __init__(self, views, post_rc=0, view_rc=0):
        self.views, self.calls, self.post_rc, self.view_rc = list(views), [], post_rc, view_rc

    def __call__(self, args):
        self.calls.append(args)
        if args[0] == "pr":
            if self.view_rc:
                return subprocess.CompletedProcess(args, self.view_rc, "", "boom")
            return subprocess.CompletedProcess(args, 0, json.dumps(self.views.pop(0)), "")
        return subprocess.CompletedProcess(args, self.post_rc, "{}", "denied" if self.post_rc else "")

    def posts(self):
        return [c for c in self.calls if c[0] == "api"]


class MarkTests(unittest.TestCase):
    def test_posts_exact_status_then_success(self):
        gh = FakeGh([pr(), pr()])
        code, msg = mrp.mark("7", "dasomel/beluga", SHA, gh)
        self.assertEqual(code, 0)
        self.assertIn(SHA, msg)
        self.assertEqual(gh.posts(), [[
            "api", f"repos/dasomel/beluga/statuses/{SHA}", "-f", "state=success",
            "-f", "context=independent-review", "-f", f"description=independent review PASS @{SHA[:7]}"]])

    def test_head_moved_after_post_warns_exit_3_no_success(self):
        gh = FakeGh([pr(), pr(headRefOid="c" * 40)])
        code, msg = mrp.mark("7", "dasomel/beluga", SHA, gh)
        self.assertEqual(code, 3)
        self.assertIn("NO LONGER head", msg)
        self.assertNotIn("success posted", msg)

    def test_refusal_posts_nothing(self):
        for views, sha in (([pr(isDraft=True)], SHA), ([pr()], "b" * 40), ([pr()], SHA[:7])):
            gh = FakeGh(views)
            self.assertEqual(mrp.mark("7", "dasomel/beluga", sha, gh)[0], 1)
            self.assertEqual(gh.posts(), [])

    def test_gh_failures_exit_1_without_success(self):
        for gh in (FakeGh([pr()], post_rc=1), FakeGh([], view_rc=1)):
            code, msg = mrp.mark("7", "dasomel/beluga", SHA, gh)
            self.assertEqual(code, 1)
            self.assertNotIn("success posted", msg)

    def test_invalid_json_exit_1(self):
        gh = lambda args: subprocess.CompletedProcess(args, 0, "not json", "")  # noqa: E731
        self.assertEqual(mrp.mark("7", "dasomel/beluga", SHA, gh)[0], 1)


class CliStrictnessTests(unittest.TestCase):
    def run_main(self, argv):
        gh = FakeGh([pr(), pr()])
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            try:
                code = mrp.main(argv, gh)
            except SystemExit as exc:
                code = exc.code
        return code, gh

    def test_full_flag_works(self):
        code, gh = self.run_main(["7", "--sha", SHA])
        self.assertEqual(code, 0)
        self.assertEqual(len(gh.posts()), 1)

    def test_abbreviated_flag_refused(self):
        for flag in ("--s", "--sh"):
            code, gh = self.run_main(["7", flag, SHA])
            self.assertEqual(code, 2)
            self.assertEqual(gh.calls, [])

    def test_repeated_sha_refused(self):
        code, gh = self.run_main(["7", "--sha", "b" * 40, "--sha", SHA])
        self.assertEqual(code, 2)
        self.assertEqual(gh.calls, [])


if __name__ == "__main__":
    unittest.main()
