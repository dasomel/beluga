#!/usr/bin/env python3
"""Generate a deterministic release QA report from recorded verification evidence."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any


class ReportInputError(ValueError):
    pass


def _required_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReportInputError(f"{field} must be a non-empty string")
    return value.strip()


def _iso_date(value: Any, field: str) -> date:
    text = _required_text(value, field)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ReportInputError(f"{field} must use YYYY-MM-DD")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ReportInputError(f"{field} must use YYYY-MM-DD") from exc


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def validate_input(data: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    if not isinstance(data, dict):
        raise ReportInputError("input must be a JSON object")

    report = data.get("report")
    if not isinstance(report, dict):
        raise ReportInputError("report must be an object")
    report_name = _required_text(report.get("name"), "report.name")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", report_name):
        raise ReportInputError("report.name may contain only letters, digits, dot, underscore, plus, and hyphen")
    report["name"] = report_name
    report["environment"] = _required_text(report.get("environment"), "report.environment")
    report["owner"] = _required_text(report.get("owner"), "report.owner")
    report_type = _required_text(report.get("type"), "report.type").lower()
    if report_type not in {"release", "periodic"}:
        raise ReportInputError("report.type must be release or periodic")
    report["type"] = report_type
    if report_type == "periodic":
        period_start = _iso_date(report.get("period_start"), "report.period_start")
        period_end = _iso_date(report.get("period_end"), "report.period_end")
        if period_start > period_end:
            raise ReportInputError("report.period_start must not be after report.period_end")
    commit = _required_text(report.get("commit"), "report.commit")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ReportInputError("report.commit must be a 40-character lowercase Git SHA")
    report_date = _iso_date(report.get("report_date"), "report.report_date")

    raw_checks = data.get("checks")
    if not isinstance(raw_checks, list) or not raw_checks:
        raise ReportInputError("checks must be a non-empty array")
    checks: list[dict[str, Any]] = []
    check_names: set[str] = set()
    ready = True
    for index, raw in enumerate(raw_checks):
        field = f"checks[{index}]"
        if not isinstance(raw, dict):
            raise ReportInputError(f"{field} must be an object")
        check = dict(raw)
        for name in ("name", "phase", "owner", "evidence"):
            check[name] = _required_text(check.get(name), f"{field}.{name}")
        check_name = check["name"]
        if check_name in check_names:
            raise ReportInputError(f"duplicate check name: {check_name}")
        check_names.add(check_name)
        result = _required_text(check.get("result"), f"{field}.result").lower()
        if result not in {"pass", "fail", "waived"}:
            raise ReportInputError(f"{field}.result must be pass, fail, or waived")
        check["result"] = result
        # D1: only a skipped check can be waived; explicit approver/expiry data costs
        # extra release-record fields, with the escape hatch of recording a real failure
        # instead, which always leaves the report NOT READY.
        if result == "waived":
            approval = check.get("approval")
            if not isinstance(approval, dict):
                raise ReportInputError(f"{field}.approval is required for waived checks")
            for name in ("approved_by", "rationale"):
                _required_text(approval.get(name), f"{field}.approval.{name}")
            expiry = _iso_date(approval.get("expires_on"), f"{field}.approval.expires_on")
            if expiry < report_date:
                ready = False
        elif result == "fail":
            ready = False
        checks.append(check)

    raw_findings = data.get("findings", [])
    if not isinstance(raw_findings, list):
        raise ReportInputError("findings must be an array")
    findings: list[dict[str, Any]] = []
    finding_ids: set[str] = set()
    for index, raw in enumerate(raw_findings):
        field = f"findings[{index}]"
        if not isinstance(raw, dict):
            raise ReportInputError(f"{field} must be an object")
        finding = dict(raw)
        for name in ("id", "severity", "owner", "status", "due_date"):
            finding[name] = _required_text(finding.get(name), f"{field}.{name}")
        finding["severity"] = finding["severity"].lower()
        if finding["id"] in finding_ids:
            raise ReportInputError(f"duplicate finding id: {finding['id']}")
        finding_ids.add(finding["id"])
        if finding["severity"].lower() not in {"critical", "high", "medium", "low"}:
            raise ReportInputError(f"{field}.severity is not recognized")
        _iso_date(finding["due_date"], f"{field}.due_date")
        status = finding["status"].lower()
        if status not in {"open", "accepted", "closed"}:
            raise ReportInputError(f"{field}.status must be open, accepted, or closed")
        finding["status"] = status
        if status == "closed":
            _required_text(finding.get("closure_evidence"), f"{field}.closure_evidence")
            _required_text(finding.get("verified_by"), f"{field}.verified_by")
        if status == "accepted":
            approval = finding.get("risk_acceptance")
            if not isinstance(approval, dict):
                raise ReportInputError(f"{field}.risk_acceptance is required")
            for name in ("approved_by", "rationale"):
                _required_text(approval.get(name), f"{field}.risk_acceptance.{name}")
            expiry = _iso_date(approval.get("expires_on"), f"{field}.risk_acceptance.expires_on")
            if expiry < report_date:
                ready = False
        if status == "open" and finding["severity"].lower() == "critical":
            ready = False
        finding["summary"] = _required_text(finding.get("summary"), f"{field}.summary")
        findings.append(finding)

    checks.sort(key=lambda item: item["name"].casefold())
    findings.sort(key=lambda item: item["id"].casefold())
    return checks, findings, ready


def render_report(data: Any) -> str:
    checks, findings, ready = validate_input(data)
    metadata = data["report"]
    status = "READY" if ready else "NOT READY"
    lines = [
        f"# Quality Assurance Report — {metadata['name']}",
        "",
        f"- Readiness: **{status}**",
        f"- Report type: {metadata['type'].lower()}",
        f"- Report date: {metadata['report_date']}",
        f"- Source commit: `{metadata['commit']}`",
        f"- Environment: {_cell(metadata['environment'])}",
        f"- Report owner: {_cell(metadata['owner'])}",
    ]
    if metadata["type"].lower() == "periodic":
        lines.append(f"- Review period: {metadata['period_start']} to {metadata['period_end']}")
    lines.extend([
        "",
        "## Verification evidence",
        "",
        "| Check | Phase | Result | Owner | Evidence | Approval / expiry |",
        "|-------|-------|--------|-------|----------|--------------------|",
    ])
    for check in checks:
        lines.append(
            "| {name} | {phase} | {result} | {owner} | {evidence} | {approval} |".format(
                name=_cell(check["name"]),
                phase=_cell(check["phase"]),
                result=check["result"].upper(),
                owner=_cell(check["owner"]),
                evidence=_cell(check["evidence"]),
                approval=(
                    _cell(
                        "Approved by {approved_by} through {expires_on}: {rationale}".format(
                            **check["approval"]
                        )
                    )
                    if check["result"] == "waived"
                    else ""
                ),
            )
        )
    lines.extend(["", "## Quality findings", ""])
    if findings:
        lines.extend(
            [
                "| ID | Severity | Status | Owner | Due date | Summary | Closure / risk evidence |",
                "|----|----------|--------|-------|----------|---------|--------------------------|",
            ]
        )
        for finding in findings:
            evidence = finding.get("closure_evidence", "")
            if finding["status"] == "closed":
                evidence = f"{evidence} (verified by {finding['verified_by']})"
            if finding["status"] == "accepted":
                approval = finding["risk_acceptance"]
                evidence = (
                    f"Accepted by {approval['approved_by']} through {approval['expires_on']}: "
                    f"{approval['rationale']}"
                )
            lines.append(
                "| {id} | {severity} | {status} | {owner} | {due} | {summary} | {evidence} |".format(
                    id=_cell(finding["id"]),
                    severity=_cell(finding["severity"].upper()),
                    status=finding["status"].upper(),
                    owner=_cell(finding["owner"]),
                    due=finding["due_date"],
                    summary=_cell(finding["summary"]),
                    evidence=_cell(evidence),
                )
            )
    else:
        lines.append("No findings recorded.")
    lines.extend(
        [
            "",
            "> Readiness is derived from the submitted evidence record. It does not itself",
            "> authorize a release; the release owner records the final decision separately.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="JSON release evidence record")
    parser.add_argument("--output", required=True, type=Path, help="Markdown report path")
    args = parser.parse_args()
    try:
        data = json.loads(args.input.read_text(encoding="utf-8"))
        report = render_report(data)
        args.output.write_text(report, encoding="utf-8")
    except (OSError, json.JSONDecodeError, ReportInputError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"Release QA report written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
