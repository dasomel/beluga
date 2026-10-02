#!/usr/bin/env python3
"""Fail unless the SAST workflow run for the release commit succeeded (Issue #100).

Usage: verify_required_checks.py <RUNS.jsonl> <JOBS.jsonl> <commit-sha>

RUNS.jsonl: workflow runs (`gh api --paginate .../actions/runs?head_sha=<sha> --jq
'.workflow_runs[]'`); JOBS.jsonl: their jobs (`.../actions/runs/<id>/jobs --jq '.jobs[]'`).
A run counts only if it is `.github/workflows/sast.yml`, event `push`, branch `main`
and head_sha equals the release commit — matching by workflow identity rather than a
check name any app could publish. The newest such run (highest id) must be completed,
and each required job in it must have conclusion `success`; skipped, neutral,
cancelled, pending, absent or unparsable input all block the release (fail closed).
"""
import json
import sys

WORKFLOW_PATH = ".github/workflows/sast.yml"
REQUIRED_JOBS = ("trivy-config", "trivy-secrets")


def parse_stream(text: str) -> list:
    """Concatenated/line-delimited JSON values (multi-page gh output); lists are flattened."""
    decoder, idx, out, text = json.JSONDecoder(), 0, [], text.strip()
    while idx < len(text):
        obj, idx = decoder.raw_decode(text, idx)
        out.extend(obj if isinstance(obj, list) else [obj])
        while idx < len(text) and text[idx].isspace():
            idx += 1
    return out


def evaluate(runs_text: str, jobs_text: str, sha: str, required=REQUIRED_JOBS) -> list[str]:
    try:
        runs, jobs = parse_stream(runs_text), parse_stream(jobs_text)
        candidates = [r for r in runs
                      if str(r["path"]).split("@")[0] == WORKFLOW_PATH and r["event"] == "push"
                      and r["head_branch"] == "main" and r["head_sha"] == sha]
        if not candidates:
            return [f"no {WORKFLOW_PATH} push run on main for commit {sha}"]
        run = max(candidates, key=lambda r: r["id"])
        if run["status"] != "completed" or run["conclusion"] != "success":
            return [f"{WORKFLOW_PATH} run {run['id']}: status={run['status']} conclusion={run['conclusion']}"]
        mine = {}
        for job in jobs:
            if job["run_id"] == run["id"]:
                mine[job["name"]] = job
        errors = []
        for name in required:
            job = mine.get(name)
            if job is None:
                errors.append(f"required job not found in run {run['id']}: {name}")
            elif job["conclusion"] != "success":
                errors.append(f"required job {name}: status={job['status']} conclusion={job['conclusion']}")
        return errors
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        return [f"unparsable runs/jobs input: {exc!r}"]


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        runs_text = open(argv[1], encoding="utf-8").read()
        jobs_text = open(argv[2], encoding="utf-8").read()
    except OSError as exc:
        print(f"release check gate FAIL: {exc}", file=sys.stderr)
        return 1
    errors = evaluate(runs_text, jobs_text, argv[3])
    for err in errors:
        print(f"release check gate FAIL: {err}", file=sys.stderr)
    if not errors:
        print(f"release check gate PASS ({', '.join(REQUIRED_JOBS)})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
