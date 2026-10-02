#!/usr/bin/env python3
"""Fail unless every required check run for the release commit concluded `success`.

Reads GitHub check-runs as a JSON stream on stdin (e.g.
`gh api --paginate .../commits/<sha>/check-runs --jq '.check_runs[]'`). The newest
run (highest id) per name wins so a green re-run supersedes an earlier failure.
Fail closed: a required check that is absent, pending or non-success blocks the
release, as does empty/unparsable input (Issue #100: vulnerability gate).
"""
import json
import sys

REQUIRED = ("trivy-config", "trivy-secrets")


def evaluate(text: str, required=REQUIRED) -> list[str]:
    decoder, idx, runs = json.JSONDecoder(), 0, []
    text = text.strip()
    try:
        while idx < len(text):
            obj, end = decoder.raw_decode(text, idx)
            runs.extend(obj["check_runs"] if isinstance(obj, dict) and "check_runs" in obj else [obj])
            idx = end
            while idx < len(text) and text[idx].isspace():
                idx += 1
        latest = {}
        for run in runs:
            if run["name"] not in latest or run["id"] > latest[run["name"]]["id"]:
                latest[run["name"]] = run
    except (ValueError, KeyError, TypeError) as exc:
        return [f"unparsable check-runs input: {exc}"]
    errors = []
    for name in required:
        run = latest.get(name)
        if run is None:
            errors.append(f"required check not found for commit: {name}")
        elif run.get("conclusion") != "success":
            errors.append(f"required check {name}: status={run.get('status')} conclusion={run.get('conclusion')}")
    return errors


def main() -> int:
    errors = evaluate(sys.stdin.read())
    for err in errors:
        print(f"release check gate FAIL: {err}", file=sys.stderr)
    if not errors:
        print(f"release check gate PASS ({', '.join(REQUIRED)})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
