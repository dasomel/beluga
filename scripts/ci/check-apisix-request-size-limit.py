#!/usr/bin/env python3
"""Fail-closed rendered-manifest gate for APISIX request-body limits (Issue #48).

The APISIX nginx configuration defaults client_max_body_size to 0 (unlimited). This
gate renders every deployed chart combination and requires each APISIX ConfigMap to
set a finite global limit. There is no baseline: after this remediation no unlimited
APISIX gateway is an accepted pre-existing violation.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Matches scripts/gitops/01-argocd-bootstrap.sh and scripts/common/env.sh.
DEPLOYED_COMBOS: list[tuple[str, list[str]]] = [
    ("beluga-platform", []),
    ("beluga-data", []),
    ("beluga-data", ["--set", "trino.workerEnabled=true,openmetadata.enabled=true"]),
]
FINITE_SIZE = re.compile(r"^[1-9][0-9]*(?:[kKmMgG])?$")


def is_finite_size(value: Any) -> bool:
    """Accept nginx positive byte counts and k/m/g suffixes, but never booleans."""
    if type(value) is int:
        return value > 0
    return isinstance(value, str) and bool(FINITE_SIZE.fullmatch(value))


def apisix_configmaps(docs: list[dict[str, Any]], source: str) -> tuple[list[tuple[str, str]], list[str]]:
    """Return APISIX ConfigMap config text and structural errors.

    Name matching catches a broken/missing config.yaml in the known gateway ConfigMap.
    Content matching also covers a future renamed APISIX ConfigMap without accepting
    unrelated ConfigMaps as a substitute.
    """
    configs: list[tuple[str, str]] = []
    errors: list[str] = []
    for doc in docs:
        if doc.get("kind") != "ConfigMap":
            continue
        metadata = doc.get("metadata")
        if not isinstance(metadata, dict):
            errors.append(f"{source}: ConfigMap has malformed metadata")
            continue
        name = metadata.get("name")
        namespace = metadata.get("namespace", "default")
        if not isinstance(name, str) or not isinstance(namespace, str):
            errors.append(f"{source}: ConfigMap has invalid namespace/name")
            continue
        data = doc.get("data")
        if not isinstance(data, dict):
            if name == "apisix-config":
                errors.append(f"{source}: ConfigMap {namespace}/{name} has no data map")
            continue
        raw = data.get("config.yaml")
        identity = f"{source}: ConfigMap {namespace}/{name} data.config.yaml"
        if name == "apisix-config":
            if not isinstance(raw, str):
                errors.append(f"{identity} is missing or not a string")
            else:
                configs.append((identity, raw))
            continue
        if not isinstance(raw, str):
            continue
        try:
            parsed = yaml.safe_load(raw)
        except yaml.YAMLError as exc:
            errors.append(f"{identity} is invalid YAML: {exc}")
            continue
        # The ingress controller also has a config.yaml with an `apisix` section;
        # only nginx_config identifies a data-plane APISIX runtime configuration.
        if isinstance(parsed, dict) and "nginx_config" in parsed:
            configs.append((identity, raw))
    return configs, errors


def audit_manifest(manifest: str, source: str) -> tuple[list[str], list[str]]:
    """Validate every APISIX ConfigMap in one rendered manifest; fail closed."""
    try:
        docs = [doc for doc in yaml.safe_load_all(manifest) if isinstance(doc, dict)]
    except yaml.YAMLError as exc:
        return [f"{source}: rendered manifest is invalid YAML: {exc}"], []

    configs, errors = apisix_configmaps(docs, source)
    checked: list[str] = []
    for identity, raw in configs:
        try:
            config = yaml.safe_load(raw)
        except yaml.YAMLError as exc:
            errors.append(f"{identity} is invalid YAML: {exc}")
            continue
        if not isinstance(config, dict):
            errors.append(f"{identity} must contain a YAML map")
            continue
        nginx = config.get("nginx_config")
        if not isinstance(nginx, dict):
            errors.append(f"{identity}: missing nginx_config map")
            continue
        http = nginx.get("http")
        if not isinstance(http, dict):
            errors.append(f"{identity}: missing nginx_config.http map")
            continue
        value = http.get("client_max_body_size")
        if not is_finite_size(value):
            errors.append(
                f"{identity}: client_max_body_size must be a finite positive nginx size, got {value!r}"
            )
            continue
        checked.append(f"{identity}={value}")
    return errors, checked


def render_all_deployed() -> list[tuple[str, str]]:
    """Render all deployed chart/value combinations, as the route-limit gate does."""
    manifests: list[tuple[str, str]] = []
    for chart_name, extra_args in DEPLOYED_COMBOS:
        cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart_name), *extra_args]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "KUBECONFIG": os.devnull},
        )
        label = f"{chart_name}{' ' + ' '.join(extra_args) if extra_args else ''}"
        manifests.append((label, result.stdout))
    return manifests


def configmap(value: Any = "50m", *, include_nginx: bool = True, include_http: bool = True) -> str:
    """Build a compact APISIX ConfigMap fixture."""
    config: dict[str, Any] = {"apisix": {"node_listen": [9080]}}
    if include_nginx:
        config["nginx_config"] = {"http": {"client_max_body_size": value}} if include_http else {}
    raw = yaml.safe_dump(config, sort_keys=False)
    return yaml.safe_dump(
        {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "apisix-config", "namespace": "gateway"}, "data": {"config.yaml": raw}},
        sort_keys=False,
    )


def self_test() -> int:
    """Exercise valid, unsafe, missing, malformed, and multi-config manifest forms."""
    fixtures = 0
    errors, checked = audit_manifest(configmap("50m"), "positive")
    assert not errors and checked == ["positive: ConfigMap gateway/apisix-config data.config.yaml=50m"]
    fixtures += 1

    for unsafe in (0, "0", "0m", "unlimited", "", None, -1, True):
        errors, _ = audit_manifest(configmap(unsafe), f"unsafe-{unsafe!r}")
        assert errors and "client_max_body_size" in errors[0], f"unsafe size accepted: {unsafe!r}"
        fixtures += 1

    errors, _ = audit_manifest(configmap(include_nginx=False), "no-nginx")
    assert errors and "missing nginx_config map" in errors[0]
    fixtures += 1

    errors, _ = audit_manifest(configmap(include_http=False), "no-http")
    assert errors and "missing nginx_config.http map" in errors[0]
    fixtures += 1

    errors, _ = audit_manifest("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\n", "none")
    assert not errors, "per-manifest absence is evaluated after all deployed renders"
    fixtures += 1

    bad = """apiVersion: v1
kind: ConfigMap
metadata:
  name: apisix-config
  namespace: gateway
data:
  config.yaml: |
    nginx_config:
      http:
        client_max_body_size: [
"""
    errors, _ = audit_manifest(bad, "invalid-nested-yaml")
    assert errors and "invalid YAML" in errors[0]
    fixtures += 1
    return fixtures


def read_manifest(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", metavar="PATH", help="audit one rendered manifest (use - for stdin)")
    args = parser.parse_args()
    try:
        fixture_count = self_test()
    except Exception as exc:
        print(f"FAIL: APISIX request-size self-test failed: {exc}", file=sys.stderr)
        return 1
    print(f"Self-tests OK: {fixture_count} positive/negative fixtures validated.")
    print("=== APISIX request-body-size gate check ===")

    try:
        manifests = [(args.manifest, read_manifest(args.manifest))] if args.manifest else render_all_deployed()
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited with code {exc.returncode}:\n{exc.stderr}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError) as exc:
        print(f"FAIL: cannot read/render manifest: {exc}", file=sys.stderr)
        return 1

    errors: list[str] = []
    checked: list[str] = []
    for source, manifest in manifests:
        source_errors, source_checked = audit_manifest(manifest, source)
        errors.extend(source_errors)
        checked.extend(source_checked)
    if not checked:
        errors.append("fail closed: zero APISIX ConfigMaps with a finite request-body limit found")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        print(f"APISIX request-body-size check FAILED with {len(errors)} error(s).", file=sys.stderr)
        return 1
    for entry in checked:
        print(f"OK: {entry}")
    print(f"APISIX request-body-size check PASSED: {len(checked)} finite global limit(s) verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
