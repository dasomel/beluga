#!/usr/bin/env python3
"""Offline Flink storage/fsync contract and fail-closed output fixtures (#412)."""
import copy
import os
from pathlib import Path
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "gitops/charts/beluga-data"
AWK = CHART / "files/seaweedfs/check-fsync.awk"


def validate(docs):
    flink = next(d for d in docs if d["kind"] == "FlinkDeployment")
    config = flink["spec"]["flinkConfiguration"]
    ha = config["high-availability.storageDir"]
    prefix = "/buckets/" + ha.removeprefix("s3://").rsplit("/", 1)[0] + "/"
    assert config["state.checkpoints.dir"] == ha.rsplit("/", 1)[0] + "/checkpoints"
    hook = next(d for d in docs if d["kind"] == "Job" and d["metadata"]["name"] == "seaweedfs-flink-fsync")
    assert hook["metadata"]["annotations"]["argocd.argoproj.io/hook"] == "Sync"
    assert hook["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "1"
    script = hook["spec"]["template"]["spec"]["containers"][0]["args"][0]
    assert f"fs.configure -locationPrefix={prefix} -fsync -apply" in script, "fsync prefix mismatch"
    assert f"check '{prefix}' ||" in script, "missing fail-closed verification"
    assert "-master=seaweedfs-admin:9333 -filer=seaweedfs-admin:" in script
    assert "printf '%s\\n' fs.configure | shell > /tmp/configuration" in script
    return prefix


def main():
    for flags in ([], ["--set", "flink.storage.bucket=fixture-lake,flink.storage.systemPrefix=fixture-state"],
                  ["-f", str(ROOT / "gitops/values/profile-full.yaml")]):
        rendered = subprocess.run(["helm", "template", str(CHART), *flags], check=True,
                                  capture_output=True, text=True, env={**os.environ, "KUBECONFIG": os.devnull})
        docs = [d for d in yaml.safe_load_all(rendered.stdout) if d]
        prefix = validate(docs)
        broken = copy.deepcopy(docs)
        job = next(d for d in broken if d["kind"] == "Job" and d["metadata"]["name"] == "seaweedfs-flink-fsync")
        container = job["spec"]["template"]["spec"]["containers"][0]
        container["args"][0] = container["args"][0].replace(prefix, "/buckets/wrong/state/")
        try:
            validate(broken)
        except AssertionError:
            pass
        else:
            raise AssertionError("prefix mismatch fixture passed")
        print(f"PASS: rendered {prefix}; mismatched prefix rejected")

    prefix = "/buckets/beluga-lake/flink-system/"
    for output, expected in (
        ('{"locations":[{"locationPrefix":"' + prefix + '","fsync":true}]}', 0),
        ('{\n "locations": [{"fsync": true, "locationPrefix": "' + prefix + '"}]}', 0),
        ('{"locations":[]}', 1),
        ('{"locations":[{"locationPrefix":"' + prefix + '","fsync":false}]}', 1),
        ('{"locations":[{"locationPrefix":"' + prefix + '"},{"locationPrefix":"/other/","fsync":true}]}', 1),
        ('{"locations":[{"locationPrefix":"' + prefix + 'extra/","fsync":true}]}', 1),
        ('connection refused', 1), ("", 1),
    ):
        result = subprocess.run(["awk", "-v", f"prefix={prefix}", "-f", str(AWK)], input=output, text=True)
        assert result.returncode == expected, f"fs.configure fixture: {output!r}"
    print("PASS: fs.configure parser accepts both field orders; rejects missing/false/other-prefix/empty/error output")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AssertionError, StopIteration, subprocess.CalledProcessError) as error:
        print(f"FAIL: SeaweedFS fsync: {error}", file=sys.stderr)
        sys.exit(1)
