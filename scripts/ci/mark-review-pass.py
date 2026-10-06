#!/usr/bin/env python3
"""Post the `independent-review` commit status for a PR's CURRENT head SHA.

Usage: mark-review-pass.py <pr-number> --sha <reviewed-sha> [--repo owner/name]
Run by the independent reviewer (not the author lane) after a PASS verdict, passing the SHA it
actually reviewed (full or >=7-char prefix); refused if that is not the PR head now, so a push
between review and posting never earns a PASS. The status is bound to one SHA, so any later push (new SHA) has no status and stays blocked from merge.
D1: procedural control only; any writer can post it, it is not identity proof. Escape hatch is
an admin merge stated in the PR (AGENTS.md).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

CONTEXT = "independent-review"
DEFAULT_REPO = "dasomel/beluga"


HEX = "0123456789abcdef"


def plan_status(pr: dict, reviewed_sha: object) -> tuple[bool, str]:
    """Pure decision: may a success status be posted for `reviewed_sha` on this `gh pr view` JSON?

    On success the reason is the full 40-char head SHA the status must be posted on.
    """
    if not isinstance(pr, dict):
        return False, "refused: PR data missing"
    sha = pr.get("headRefOid")
    if not isinstance(sha, str) or len(sha) != 40 or any(c not in HEX for c in sha):
        return False, "refused: headRefOid missing or not a 40-char SHA"
    want = reviewed_sha.lower() if isinstance(reviewed_sha, str) else ""
    if len(want) < 7 or len(want) > 40 or any(c not in HEX for c in want):
        return False, "refused: --sha is required (7-40 hex chars)"
    if not sha.startswith(want):
        return False, f"refused: reviewed SHA {want} is not the PR head {sha}; head moved, re-review"
    if pr.get("isDraft") is not False:
        return False, "refused: PR is a draft (or draft state unknown)"
    if pr.get("state") != "OPEN":
        return False, f"refused: PR state is {pr.get('state')!r}, not OPEN"
    return True, sha


def view(pr_number: str, repo: str) -> dict:
    proc = subprocess.run(
        ["gh", "pr", "view", pr_number, "-R", repo, "--json", "headRefOid,isDraft,state"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"gh pr view failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def post(sha: str, repo: str) -> None:
    proc = subprocess.run(
        ["gh", "api", f"repos/{repo}/statuses/{sha}", "-f", "state=success",
         "-f", f"context={CONTEXT}", "-f", f"description=independent review PASS @{sha[:7]}"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"posting status failed: {proc.stderr.strip()}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pr", help="pull request number")
    parser.add_argument("--sha", required=True, help="SHA the reviewer actually reviewed (full or >=7 chars)")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    args = parser.parse_args(argv)
    if not args.pr.isdigit():
        print("refused: PR number must be numeric", file=sys.stderr)
        return 2
    try:
        ok, detail = plan_status(view(args.pr, args.repo), args.sha)
        if not ok:
            print(detail, file=sys.stderr)
            return 1
        post(detail, args.repo)
        print(f"independent-review success posted for {detail}")
        after = view(args.pr, args.repo).get("headRefOid")
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if after != detail:
        print(f"WARNING: head moved to {after}; the reviewed SHA {detail} is NO LONGER head. "
              "The status is bound to the old SHA; the new head has none: re-review it.", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
