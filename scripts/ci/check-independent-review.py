#!/usr/bin/env python3
"""Pre-merge independent-review gate: `review:pass` must postdate the PR's last change.

Green only when the PR is not a draft, carries the label `review:pass` now, and the
LATEST `labeled` event for that label is strictly newer than every commit's
committer date and every `head_ref_force_pushed` event. Any later push therefore
invalidates an earlier review. Everything else fails closed with a reason.

D1: committer.date (not author date) so rebases/amends count as a change; the cost is that
a client-forged committer date could look old, mitigated by also counting force-push events.
Escape hatch is an admin merge, documented in AGENTS.md.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

LABEL = "review:pass"


def parse_ts(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing or non-string timestamp: {value!r}")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def evaluate(pr: dict, commits: list, timeline: list) -> tuple[bool, str]:
    """Pure decision core. Returns (passed, reason); never raises on malformed data."""
    try:
        return _evaluate(pr, commits, timeline)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return False, f"FAIL (closed): unreadable review/commit data: {exc}"


def _evaluate(pr: dict, commits: list, timeline: list) -> tuple[bool, str]:
    if not isinstance(pr, dict) or not pr:
        return False, "FAIL (closed): PR data missing"
    if pr.get("draft"):
        return False, "FAIL: PR is a draft"
    names = [label.get("name") for label in (pr.get("labels") or [])]
    if LABEL not in names:
        return False, f"FAIL: label `{LABEL}` is not on the PR"
    if not commits:
        return False, "FAIL (closed): PR commit list is empty or missing"
    if not timeline:
        return False, "FAIL (closed): issue timeline is empty or missing"

    labeled = [
        e for e in timeline
        if e.get("event") == "labeled" and (e.get("label") or {}).get("name") == LABEL
    ]
    if not labeled:
        return False, f"FAIL (closed): no `labeled` event for `{LABEL}` in the timeline"
    latest = max(labeled, key=lambda e: parse_ts(e.get("created_at")))
    label_time = parse_ts(latest.get("created_at"))
    who = (latest.get("actor") or {}).get("login") or "unknown"

    changes = [
        (parse_ts(((c.get("commit") or {}).get("committer") or {}).get("date")), "commit " + str(c.get("sha", "?"))[:7])
        for c in commits
    ]
    changes += [
        (parse_ts(e.get("created_at")), "force-push")
        for e in timeline if e.get("event") == "head_ref_force_pushed"
    ]
    last_change, what = max(changes, key=lambda x: x[0])

    if label_time > last_change:
        return True, (f"PASS: `{LABEL}` applied by {who} at {label_time.isoformat()} "
                      f"after last change ({what} at {last_change.isoformat()})")
    return False, (f"FAIL: `{LABEL}` applied by {who} at {label_time.isoformat()} is not after "
                   f"last change ({what} at {last_change.isoformat()}); re-review and re-apply the label")


def _decode_stream(text: str) -> list:
    """`gh api --paginate` prints one JSON array per page back to back; flatten them."""
    decoder, idx, out = json.JSONDecoder(), 0, []
    text = text.strip()
    while idx < len(text):
        value, end = decoder.raw_decode(text, idx)
        out.extend(value if isinstance(value, list) else [value])
        idx = end
        while idx < len(text) and text[idx].isspace():
            idx += 1
    return out


def gh_api(path: str, paginate: bool = False) -> list:
    cmd = ["gh", "api"] + (["--paginate"] if paginate else []) + [path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"`gh api {path}` failed: {proc.stderr.strip()}")
    return _decode_stream(proc.stdout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/name")
    parser.add_argument("--pr", default=os.environ.get("PR_NUMBER"), help="pull request number")
    args = parser.parse_args(argv)
    if not args.repo or not args.pr or not str(args.pr).isdigit() or args.repo.count("/") != 1:
        print("FAIL (closed): --repo owner/name and numeric --pr are required", file=sys.stderr)
        return 2
    try:
        pr_pages = gh_api(f"repos/{args.repo}/pulls/{args.pr}")
        pr = pr_pages[0] if pr_pages else {}
        commits = gh_api(f"repos/{args.repo}/pulls/{args.pr}/commits?per_page=100", paginate=True)
        timeline = gh_api(f"repos/{args.repo}/issues/{args.pr}/timeline?per_page=100", paginate=True)
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f"FAIL (closed): could not fetch PR data: {exc}", file=sys.stderr)
        return 1
    ok, reason = evaluate(pr, commits, timeline)
    print(reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
