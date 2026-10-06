#!/usr/bin/env python3
"""Post the `independent-review` commit status for the SHA the reviewer actually reviewed.

Usage: mark-review-pass.py <pr-number> --sha <full-40-hex-sha> [--repo owner/name]
Run by the independent reviewer (not the author lane) after a PASS verdict. `--sha` must be the
FULL 40-hex SHA (no prefixes: a short prefix can be ground by an author) and must equal the PR's
current head, else refused (exit 1). The status is bound to that SHA, so any later push (new SHA)
has no status and stays blocked from merge. Success is printed only after the post and a re-read
both succeeded and the head still equals the reviewed SHA.
Exit codes: 0 posted and head unchanged; 1 refused or error; 2 bad usage; 3 head moved.
D1: procedural control only; any writer can post it, it is not identity proof. Escape hatch is
an admin merge stated in the PR (AGENTS.md).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Callable

CONTEXT = "independent-review"
DEFAULT_REPO = "dasomel/beluga"
FULL_SHA = re.compile(r"[0-9a-f]{40}")

Gh = Callable[[list], "subprocess.CompletedProcess"]


def plan_status(pr: dict, reviewed_sha: object) -> tuple[bool, str]:
    """Pure decision: may a success status be posted for `reviewed_sha` on this `gh pr view` JSON?

    On success the reason is the full 40-char SHA the status must be posted on.
    """
    if not isinstance(pr, dict):
        return False, "refused: PR data missing"
    head = pr.get("headRefOid")
    if not isinstance(head, str) or not FULL_SHA.fullmatch(head):
        return False, "refused: headRefOid missing or not a 40-char SHA"
    want = reviewed_sha.lower() if isinstance(reviewed_sha, str) else ""
    if not FULL_SHA.fullmatch(want):
        return False, "refused: --sha must be the full 40-hex SHA"
    if want != head:
        return False, f"refused: reviewed SHA {want} is not the PR head {head}; head moved, re-review"
    if pr.get("isDraft") is not False:
        return False, "refused: PR is a draft (or draft state unknown)"
    if pr.get("state") != "OPEN":
        return False, f"refused: PR state is {pr.get('state')!r}, not OPEN"
    return True, head


def real_gh(args: list) -> "subprocess.CompletedProcess":
    return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)


def _view(pr: str, repo: str, gh: Gh) -> dict:
    proc = gh(["pr", "view", pr, "-R", repo, "--json", "headRefOid,isDraft,state"])
    if proc.returncode != 0:
        raise RuntimeError(f"gh pr view failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def mark(pr: str, repo: str, sha: str, gh: Gh) -> tuple[int, str]:
    """Do the work; returns (exit_code, one-line message). Never returns success unless verified."""
    try:
        ok, detail = plan_status(_view(pr, repo, gh), sha)
        if not ok:
            return 1, detail
        proc = gh(["api", f"repos/{repo}/statuses/{detail}", "-f", "state=success",
                   "-f", f"context={CONTEXT}", "-f", f"description=independent review PASS @{detail[:7]}"])
        if proc.returncode != 0:
            return 1, f"error: posting status failed: {proc.stderr.strip()}"
        after = _view(pr, repo, gh).get("headRefOid")
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        return 1, f"error: {exc}"
    if after != detail:
        return 3, (f"WARNING: head moved to {after}; reviewed SHA {detail} is NO LONGER head. The status "
                   "is bound to the old SHA and the new head has none: re-review it.")
    return 0, f"independent-review success posted for {detail}"


def main(argv: list[str] | None = None, gh: Gh = real_gh) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pr", help="pull request number")
    parser.add_argument("--sha", required=True, help="full 40-hex SHA the reviewer actually reviewed")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    args = parser.parse_args(argv)
    if not args.pr.isdigit():
        print("refused: PR number must be numeric", file=sys.stderr)
        return 2
    code, msg = mark(args.pr, args.repo, args.sha.lower(), gh)
    print(msg, file=sys.stdout if code == 0 else sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
