#!/usr/bin/env python3
"""Regression tests for the independent-review gate (review:pass must postdate the last push)."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "independent_review", ROOT / "scripts/ci/check-independent-review.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def commit(date, sha="abcdef123"):
    return {"sha": sha, "commit": {"committer": {"date": date}}}


def labeled(date, actor="reviewer", name="review:pass"):
    return {"event": "labeled", "created_at": date, "label": {"name": name}, "actor": {"login": actor}}


def pr(draft=False, labels=("review:pass",)):
    return {"draft": draft, "labels": [{"name": n} for n in labels]}


class IndependentReviewGateTests(unittest.TestCase):
    def test_pass_when_label_after_last_commit(self):
        ok, why = gate.evaluate(pr(), [commit("2026-10-07T10:00:00Z")], [labeled("2026-10-07T10:05:00Z")])
        self.assertTrue(ok, why)
        self.assertIn("reviewer", why)

    def test_fail_without_label(self):
        ok, why = gate.evaluate(pr(labels=()), [commit("2026-10-07T10:00:00Z")], [labeled("2026-10-07T10:05:00Z")])
        self.assertFalse(ok)
        self.assertIn("not on the PR", why)

    def test_fail_stale_label_older_than_newest_commit(self):
        commits = [commit("2026-10-07T10:00:00Z"), commit("2026-10-07T10:10:00Z", "bbb")]
        ok, why = gate.evaluate(pr(), commits, [labeled("2026-10-07T10:05:00Z")])
        self.assertFalse(ok)
        self.assertIn("not after", why)

    def test_fail_equal_timestamps_is_strict(self):
        ok, _ = gate.evaluate(pr(), [commit("2026-10-07T10:00:00Z")], [labeled("2026-10-07T10:00:00Z")])
        self.assertFalse(ok)

    def test_relabel_after_push_passes_uses_latest_label_event(self):
        timeline = [labeled("2026-10-07T10:05:00Z"), {"event": "unlabeled", "created_at": "2026-10-07T10:11:00Z",
                    "label": {"name": "review:pass"}}, labeled("2026-10-07T10:20:00Z", actor="second")]
        commits = [commit("2026-10-07T10:00:00Z"), commit("2026-10-07T10:10:00Z", "bbb")]
        ok, why = gate.evaluate(pr(), commits, timeline)
        self.assertTrue(ok, why)
        self.assertIn("second", why)

    def test_fail_draft(self):
        ok, why = gate.evaluate(pr(draft=True), [commit("2026-10-07T10:00:00Z")], [labeled("2026-10-07T10:05:00Z")])
        self.assertFalse(ok)
        self.assertIn("draft", why)

    def test_fail_force_push_after_label(self):
        timeline = [labeled("2026-10-07T10:05:00Z"),
                    {"event": "head_ref_force_pushed", "created_at": "2026-10-07T10:07:00Z"}]
        ok, why = gate.evaluate(pr(), [commit("2026-10-07T10:00:00Z")], timeline)
        self.assertFalse(ok)
        self.assertIn("force-push", why)

    def test_fail_closed_on_empty_or_missing_timeline(self):
        for timeline in ([], [{"event": "commented", "created_at": "2026-10-07T10:05:00Z"}]):
            ok, _ = gate.evaluate(pr(), [commit("2026-10-07T10:00:00Z")], timeline)
            self.assertFalse(ok)

    def test_fail_closed_on_missing_commits_or_bad_dates(self):
        self.assertFalse(gate.evaluate(pr(), [], [labeled("2026-10-07T10:05:00Z")])[0])
        self.assertFalse(gate.evaluate(pr(), [{"sha": "x"}], [labeled("2026-10-07T10:05:00Z")])[0])
        self.assertFalse(gate.evaluate({}, [commit("2026-10-07T10:00:00Z")], [labeled("2026-10-07T10:05:00Z")])[0])

    def test_other_label_events_ignored(self):
        ok, _ = gate.evaluate(pr(), [commit("2026-10-07T10:00:00Z")],
                              [labeled("2026-10-07T10:05:00Z", name="bug")])
        self.assertFalse(ok)

    def test_paginated_stream_is_flattened(self):
        self.assertEqual(gate._decode_stream('[{"a":1}]\n[{"a":2}]\n'), [{"a": 1}, {"a": 2}])


if __name__ == "__main__":
    unittest.main()
