#!/usr/bin/env python3
"""Render beluga-data for lakekeeper.openfga on/off and `sh -n` every Job/CronJob shell script.

Helm `{{-` trims the preceding newline, which can silently break shell line
continuations (`\\-H`, trailing `\\\\`) only for one value of a toggle.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CHART = REPO_ROOT / "gitops" / "charts" / "beluga-data"
# `\-H` (continuation glued to next arg) and a trailing `\\` (literal backslash) are
# valid shell syntax, so sh -n misses them, but they split the command in two.
ARTIFACT = re.compile(r"\\-[A-Za-z]|\\\\$", re.M)
SHELLS = {"sh", "bash", "/bin/sh", "/bin/bash"}


def scripts(docs):
    for doc in docs:
        if not doc or doc.get("kind") not in ("Job", "CronJob"):
            continue
        spec = doc["spec"]
        if doc["kind"] == "CronJob":
            spec = spec["jobTemplate"]["spec"]
        pod = spec["template"]["spec"]
        for c in pod.get("initContainers", []) + pod.get("containers", []):
            cmd = c.get("command") or []
            args = c.get("args") or []
            if len(cmd) >= 2 and cmd[0] in SHELLS and cmd[1] == "-c" and args:
                yield f"{doc['kind']}/{doc['metadata']['name']}/{c['name']}", args[0]
            elif len(cmd) >= 3 and cmd[0] in SHELLS and cmd[1] == "-c":
                yield f"{doc['kind']}/{doc['metadata']['name']}/{c['name']}", cmd[2]


def main() -> int:
    failures = []
    for value in ("true", "false"):
        out = subprocess.run(
            ["helm", "template", "t", str(CHART), "--set", f"lakekeeper.openfga.enabled={value}"],
            check=True, capture_output=True, text=True).stdout
        for name, script in scripts(yaml.safe_load_all(out)):
            if ARTIFACT.search(script):
                failures.append(f"openfga.enabled={value} {name}: broken line continuation (`\\-x` or trailing `\\\\`)")
            res = subprocess.run(["sh", "-n"], input=script, capture_output=True, text=True)
            if res.returncode != 0:
                failures.append(f"openfga.enabled={value} {name}: {res.stderr.strip()}")
    if failures:
        print("FAIL: rendered shell script has a syntax error (broken line continuation?):", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("PASS: rendered Job/CronJob shell scripts parse with sh -n (openfga on/off)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
