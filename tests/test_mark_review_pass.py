#!/usr/bin/env python3
"""Decision-logic tests for scripts/ci/mark-review-pass.py (SHA-bound independent-review status)."""
import importlib.util
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
    def test_sha_matches_ok(self):
        self.assertEqual(mrp.plan_status(pr(), SHA), (True, SHA))

    def test_short_prefix_resolves_to_full_sha(self):
        self.assertEqual(mrp.plan_status(pr(), SHA[:7]), (True, SHA))
        self.assertEqual(mrp.plan_status(pr(), SHA[:7].upper()), (True, SHA))

    def test_sha_mismatch_refused_naming_both(self):
        other = "b" * 40
        ok, why = mrp.plan_status(pr(), other)
        self.assertFalse(ok)
        self.assertIn(other, why)
        self.assertIn(SHA, why)
        self.assertFalse(mrp.plan_status(pr(), "b" * 7)[0])

    def test_too_short_or_malformed_or_missing_sha_refused(self):
        for bad in (None, "", "aaaaaa", "zzzzzzz", "a" * 41):
            self.assertFalse(mrp.plan_status(pr(), bad)[0])

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


if __name__ == "__main__":
    unittest.main()
