#!/usr/bin/env python3
"""Check rendered ArgoCD hook coverage and SHA-256 sensitivity offline (#404)."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[2]
HOOK = "argocd.argoproj.io/hook"
CHARTS = ("beluga-platform", "beluga-data")


def checksum(resource: dict) -> str:
    # D-HOOK-3: Match Helm fromYaml | toJson (Go encoding/json), including HTML
    # escapes. Cost: a second canonicalizer; escape hatch: use one shared format
    # if Helm exposes a portable canonical serializer. Hash all fields, not scripts only.
    canonical = json.dumps(resource, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    for char in "<>&\u2028\u2029":
        canonical = canonical.replace(char, f"\\u{ord(char):04x}")
    return hashlib.sha256(canonical.encode()).hexdigest()


def key(resource: dict) -> str:
    meta = resource["metadata"]
    return f"{resource['kind']}.{meta.get('namespace', '')}.{meta['name']}"


def validate(docs: list[dict], chart: str) -> dict[str, str]:
    revisions = [d for d in docs if d.get("kind") == "ConfigMap"
                 and d.get("metadata", {}).get("name") == f"{chart}-hook-revision"]
    if len(revisions) != 1:
        raise ValueError(f"{chart}: expected exactly one revision ConfigMap")
    revision = revisions[0]
    if HOOK in revision["metadata"].get("annotations", {}):
        raise ValueError(f"{chart}: revision ConfigMap must not be a hook")
    expected = {}
    for doc in docs:
        if HOOK not in doc.get("metadata", {}).get("annotations", {}):
            continue
        identity = key(doc)
        if identity in expected:
            raise ValueError(f"{chart}: duplicate hook {identity}")
        expected[identity] = checksum(doc)
    if not expected:
        raise ValueError(f"{chart}: no hooks rendered (coverage fixture is empty)")
    actual = revision.get("data") or {}
    if actual != expected:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        stale = sorted(k for k in expected.keys() & actual.keys() if expected[k] != actual[k])
        raise ValueError(f"{chart}: missing={missing}, extra={extra}, stale={stale}")
    return actual


def render(chart_path: Path, release: str, flags: list[str]) -> tuple[str, list[dict]]:
    result = subprocess.run(
        ["helm", "template", release, str(chart_path), *flags],
        capture_output=True, text=True, check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    return result.stdout, [d for d in yaml.safe_load_all(result.stdout) if d]


def profiles(chart: str) -> dict[str, list[str]]:
    values = ROOT / "gitops/values"
    # D-HOOK-4: Read actual Application overlays, so Kakao profile additions cannot
    # silently escape coverage. Cost: two extra renders; escape hatch: extend this
    # matrix if another deployment root is introduced.
    result = {
        "default": [],
        "sso": ["-f", str(values / "sso.yaml")],
        "profile-full": ["-f", str(values / "profile-full.yaml")],
        "sso-full": ["-f", str(values / "sso.yaml"), "-f", str(values / "profile-full.yaml")],
        "hooks-disabled": ["--set", "flink.sqlJobsEnabled=false,openmetadata.enabled=false"],
    }
    for name, directory in (("application", "gitops/apps"), ("kakao", "csp/kakao-cloud/gitops/apps")):
        app = yaml.safe_load((ROOT / directory / f"{chart}.yaml").read_text())
        source = app["spec"]["source"]
        if source["path"] != f"gitops/charts/{chart}":
            raise ValueError(f"{name}/{chart}: unexpected chart path")
        chart_path = ROOT / source["path"]
        result[name] = [flag for value in source.get("helm", {}).get("valueFiles", [])
                        for flag in ("-f", str((chart_path / value).resolve()))]
    return result


def self_test() -> None:
    hook = {"apiVersion": "batch/v1", "kind": "Job",
            "metadata": {"name": "fixture", "namespace": "storage", "annotations": {HOOK: "Sync"}},
            "spec": {"script": "echo '<>& 한글'\n", "image": "test:1", "env": {"A": "1"}}}
    revision = {"apiVersion": "v1", "kind": "ConfigMap",
                "metadata": {"name": "fixture-hook-revision", "namespace": "storage"},
                "data": {key(hook): checksum(hook)}}
    validate([hook, revision], "fixture")
    for field, value in (("script", "echo changed\n"), ("image", "test:2"), ("env", {"A": "2"})):
        changed = copy.deepcopy(hook)
        changed["spec"][field] = value
        if checksum(changed) == checksum(hook):
            raise ValueError(f"self-test: {field} mutation did not change SHA-256")
        expect_failure([changed, revision], "stale=")
    changed = copy.deepcopy(hook)
    changed["metadata"]["annotations"]["test"] = "changed"
    expect_failure([changed, revision], "stale=")
    expect_failure([hook, {**revision, "data": {}}], "missing=")
    annotated = copy.deepcopy(revision)
    annotated["metadata"]["annotations"] = {HOOK: "Sync"}
    expect_failure([hook, annotated], "must not be a hook")

    # Exercise the production Helm hashing path too: an included file and values
    # alter the named template's output, then a hook-only annotation edit does so.
    with tempfile.TemporaryDirectory(prefix="beluga-hook-revision-") as tmp:
        fixture = Path(tmp)
        (fixture / "templates").mkdir()
        (fixture / "files").mkdir()
        (fixture / "Chart.yaml").write_text("apiVersion: v2\nname: fixture\nversion: 0.1.0\n")
        (fixture / "files/script.sh").write_text("echo '<>& 한글'\n")
        source = '''{{- define "fixture.hook" -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: fixture
  namespace: storage
  annotations:
    argocd.argoproj.io/hook: Sync
spec:
  image: {{ .Values.image | default "test:1" | quote }}
  script: {{ .Files.Get "files/script.sh" | quote }}
{{- end }}
{{ include "fixture.hook" . }}
'''
        hook_path = fixture / "templates/hook.yaml"
        hook_path.write_text(source)
        for chart in CHARTS:
            production = (ROOT / f"gitops/charts/{chart}/templates/hook-revision.yaml").read_text()
            start = production.index('{{- range $template := list')
            end = production.index('\n}}', start)
            production = production[:start] + '{{- range $template := list "fixture.hook"' + production[end:]
            (fixture / "templates/revision.yaml").write_text(production.replace(chart, "fixture"))
            _, docs = render(fixture, "fixture", [])
            baseline = validate(docs, "fixture")
            _, changed = render(fixture, "fixture", ["--set", "image=test:2"])
            if validate(changed, "fixture") == baseline:
                raise ValueError("self-test: Helm value mutation was invisible")
            (fixture / "files/script.sh").write_text("echo changed\n")
            _, changed = render(fixture, "fixture", [])
            if validate(changed, "fixture") == baseline:
                raise ValueError("self-test: .Files.Get mutation was invisible")
            (fixture / "files/script.sh").write_text("echo '<>& 한글'\n")
            hook_path.write_text(source.replace("    argocd.argoproj.io/hook: Sync", "    test: changed\n    argocd.argoproj.io/hook: Sync"))
            _, changed = render(fixture, "fixture", [])
            if validate(changed, "fixture") == baseline:
                raise ValueError("self-test: hook-only annotation mutation was invisible")
            hook_path.write_text(source)
    print("PASS: self-test rejects missing/stale coverage and hook revision; Helm values/files/annotation sensitivity")


def expect_failure(docs: list[dict], diagnostic: str) -> None:
    try:
        validate(docs, "fixture")
    except ValueError as error:
        if diagnostic in str(error):
            return
        raise
    raise ValueError(f"self-test accepted invalid fixture: {diagnostic}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="Save offline manifests and revision ConfigMaps as evidence")
    args = parser.parse_args()
    try:
        self_test()
        for chart in CHARTS:
            for profile, flags in profiles(chart).items():
                rendered, docs = render(ROOT / f"gitops/charts/{chart}", chart, flags)
                checksums = validate(docs, chart)
                # A repeat render must be identical: timestamps/random data would
                # otherwise create permanent OutOfSync and repeated hook execution.
                _, repeated = render(ROOT / f"gitops/charts/{chart}", chart, flags)
                if validate(repeated, chart) != checksums:
                    raise ValueError(f"{chart}/{profile}: non-deterministic hook revision")
                if args.output_dir:
                    args.output_dir.mkdir(parents=True, exist_ok=True)
                    (args.output_dir / f"{chart}-{profile}.yaml").write_text(rendered)
                    revision = next(d for d in docs if d.get("kind") == "ConfigMap"
                                    and d["metadata"]["name"] == f"{chart}-hook-revision")
                    (args.output_dir / f"{chart}-{profile}-revision.yaml").write_text(yaml.safe_dump(revision, sort_keys=False))
                print(f"PASS: {chart}/{profile}: {len(checksums)} hooks covered; deterministic SHA-256")
    except (OSError, ValueError, yaml.YAMLError, subprocess.CalledProcessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
