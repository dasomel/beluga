#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "generate_release_qa_report.py"
SPEC = importlib.util.spec_from_file_location("release_qa_report", MODULE_PATH)
assert SPEC and SPEC.loader
reporter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reporter
SPEC.loader.exec_module(reporter)


def evidence_record() -> dict:
    return {
        "report": {
            "name": "v1.2.3",
            "type": "release",
            "commit": "a" * 40,
            "report_date": "2026-09-25",
            "environment": "staging",
            "owner": "release-owner",
        },
        "checks": [
            {
                "name": "make validate",
                "phase": "verification",
                "result": "pass",
                "owner": "platform-team",
                "evidence": "https://example.test/ci/123",
            }
        ],
        "findings": [],
    }


class ReleaseQAReportTests(unittest.TestCase):
    def test_report_is_deterministic_and_records_source_commit(self) -> None:
        data = evidence_record()
        first = reporter.render_report(data)
        second = reporter.render_report(data)
        self.assertEqual(first, second)
        self.assertIn("Readiness: **READY**", first)
        self.assertIn("`" + "a" * 40 + "`", first)
        self.assertIn("https://example.test/ci/123", first)

    def test_periodic_report_records_review_period(self) -> None:
        data = evidence_record()
        data["report"].update(
            {
                "name": "2026-Q3",
                "type": "periodic",
                "period_start": "2026-07-01",
                "period_end": "2026-09-30",
            }
        )
        report = reporter.render_report(data)
        self.assertIn("Report type: periodic", report)
        self.assertIn("Review period: 2026-07-01 to 2026-09-30", report)

    def test_cli_writes_report_from_recorded_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "release.json"
            output_path = Path(tmp) / "report.md"
            input_path.write_text(json.dumps(evidence_record()), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Readiness: **READY**", output_path.read_text(encoding="utf-8"))

    def test_unresolved_critical_finding_blocks_readiness(self) -> None:
        data = evidence_record()
        data["findings"] = [
            {
                "id": "SEC-1",
                "severity": "critical",
                "status": "open",
                "owner": "security-owner",
                "due_date": "2026-10-01",
                "summary": "Certificate validation is incomplete",
            }
        ]
        report = reporter.render_report(data)
        self.assertIn("Readiness: **NOT READY**", report)
        self.assertIn("SEC-1", report)

    def test_expired_risk_acceptance_does_not_authorize_critical_finding(self) -> None:
        data = evidence_record()
        data["findings"] = [
            {
                "id": "SEC-2",
                "severity": "critical",
                "status": "accepted",
                "owner": "security-owner",
                "due_date": "2026-10-01",
                "summary": "Legacy certificate remains in one dev path",
                "risk_acceptance": {
                    "approved_by": "risk-owner",
                    "rationale": "Temporary environment isolation",
                    "expires_on": "2026-09-24",
                },
            }
        ]
        self.assertIn("Readiness: **NOT READY**", reporter.render_report(data))

    def test_missing_evidence_is_rejected(self) -> None:
        data = evidence_record()
        del data["checks"][0]["evidence"]
        with self.assertRaisesRegex(reporter.ReportInputError, "checks\\[0\\].evidence"):
            reporter.render_report(data)

    def test_waived_check_requires_named_approval_and_expiry(self) -> None:
        data = evidence_record()
        data["checks"][0]["result"] = "waived"
        with self.assertRaisesRegex(reporter.ReportInputError, "approval is required"):
            reporter.render_report(data)

    def test_active_check_waiver_is_visible_in_reproducible_report(self) -> None:
        data = evidence_record()
        data["checks"][0].update(
            {
                "result": "waived",
                "approval": {
                    "approved_by": "release-owner",
                    "rationale": "The integration service is not in this profile",
                    "expires_on": "2026-10-01",
                },
            }
        )
        report = reporter.render_report(data)
        self.assertIn("Readiness: **READY**", report)
        self.assertIn("Approved by release-owner through 2026-10-01", report)

    def test_failed_check_cannot_be_overridden_by_waiver_fields(self) -> None:
        data = evidence_record()
        data["checks"][0].update(
            {
                "result": "fail",
                "approval": {
                    "approved_by": "release-owner",
                    "rationale": "Must still be fixed",
                    "expires_on": "2026-10-01",
                },
            }
        )
        self.assertIn("Readiness: **NOT READY**", reporter.render_report(data))

    def test_closed_finding_requires_closure_verification(self) -> None:
        data = evidence_record()
        data["findings"] = [
            {
                "id": "OPS-1",
                "severity": "high",
                "status": "closed",
                "owner": "ops-owner",
                "due_date": "2026-09-01",
                "summary": "Missing runbook",
            }
        ]
        with self.assertRaisesRegex(reporter.ReportInputError, "closure_evidence"):
            reporter.render_report(data)


if __name__ == "__main__":
    unittest.main()
