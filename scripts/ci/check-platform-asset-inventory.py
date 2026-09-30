#!/usr/bin/env python3
"""Fail-closed CI drift gate for platform asset inventory (Issue #42).

Enforces that committed platform asset inventory documentation
(`docs/platform-asset-inventory.md` and `docs/platform-asset-inventory-ko.md`)
matches the declared state statically generated from `helm template`
of both Helm charts (`beluga-platform` and `beluga-data`) with KUBECONFIG=/dev/null
and VERSIONS.md.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOC_EN = REPO_ROOT / "docs" / "platform-asset-inventory.md"
DOC_KO = REPO_ROOT / "docs" / "platform-asset-inventory-ko.md"
CI_HELM_VERSION = "v3.16.4"


def helm_version_report(actual: str) -> str:
    return f"Helm: {actual} (CI pin: {CI_HELM_VERSION}; reproducibility check scoped to CI pin)"

# Load generator module dynamically to support execution from any directory
GENERATOR_PATH = REPO_ROOT / "scripts" / "generate_platform_asset_inventory.py"
spec = importlib.util.spec_from_file_location("generate_platform_asset_inventory", GENERATOR_PATH)
if spec is None or spec.loader is None:
    print(f"FAIL: could not load {GENERATOR_PATH}", file=sys.stderr)
    sys.exit(1)
gen = importlib.util.module_from_spec(spec)
sys.modules["generate_platform_asset_inventory"] = gen
spec.loader.exec_module(gen)


def self_test() -> None:
    """Validate drift detection fail-closed behavior against synthetic fixtures."""
    inventory = gen.build_inventory()
    content_en = gen.render_markdown_en(inventory)
    content_ko = gen.render_markdown_ko(inventory)
    conditional = {item["id"] for item in inventory["workloads"] if "default" not in item["profiles"]}
    assert "Job/governance/openmetadata-migration" in conditional
    assert "Deployment/analytics/trino-worker" in conditional
    assert "openmetadata-db-init" not in content_en + content_ko
    assert {"KafkaUser/streaming/beluga-admin", "KafkaUser/streaming/beluga-analyst",
            "KafkaUser/streaming/beluga-engineer"} <= {item["id"] for item in inventory["customResources"]}
    for profile, listener_names, authorization in (
        ("oauth", {"oauth"}, "simple"),
        ("acl", {"plain"}, "simple"),
        ("external", {"plain", "external"}, None),
    ):
        rendered = gen.render_chart("beluga-data", gen.PROFILES[profile])
        kafka = next(doc for doc in rendered if doc["kind"] == "Kafka")
        assert {listener["name"] for listener in kafka["spec"]["kafka"]["listeners"]} == listener_names
        assert kafka["spec"]["kafka"].get("authorization", {}).get("type") == authorization
    assert "Unmapped" == next(item["version"] for item in inventory["images"] if item["image"].startswith("flink:"))
    assert "EOL not assessed" in content_en and "EOL 미평가" in content_ko
    assert "Unsupported/EOL assets are flagged. | **Complete**" not in content_en
    assert CI_HELM_VERSION in content_en and CI_HELM_VERSION in content_ko
    assert helm_version_report("v4-fixture").startswith("Helm: v4-fixture (CI pin: v3.16.4")
    assert "v4-fixture" not in content_en + content_ko

    cronjob = {"kind": "CronJob", "spec": {"jobTemplate": {"spec": {"template": {"spec": {
        "initContainers": [{"image": "init:1"}], "containers": [{"image": "main:2"}]
    }}}}}}
    assert gen.extract_workload_images(cronjob) == ["init:1", "main:2"]
    unknown = {"apiVersion": "example.io/v1", "kind": "NewResource", "metadata": {"name": "fixture"}}
    assert gen.extract_custom_resources([unknown])[0]["operator"] == "Uncategorized (example.io)"
    versions = gen.parse_versions(gen.VERSIONS_PATH)
    assert "flink:1.20.0-scala_2.12-java17" not in versions
    assert "apache/airflow:3.3.0-python3.11" in versions
    assert not gen.check_relative_links(content_en, gen.DOC_EN)
    assert not gen.check_relative_links(content_ko, gen.DOC_KO)
    assert gen.check_relative_links("[missing](../gitops/charts/no-such-template.yaml)", gen.DOC_EN)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        tmp_en = tmp_path / "test-en.md"
        tmp_ko = tmp_path / "test-ko.md"

        # Case 1: Matching files pass
        tmp_en.write_text(content_en, encoding="utf-8")
        tmp_ko.write_text(content_ko, encoding="utf-8")
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if errors:
            raise AssertionError(f"Expected clean match in self-test, got: {errors}")

        # Case 2: Missing English doc fails closed
        tmp_en.unlink()
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if not any("Missing English inventory doc" in err for err in errors):
            raise AssertionError("Expected missing English doc error, got None")
        tmp_en.write_text(content_en, encoding="utf-8")

        # Case 3: Missing Korean doc fails closed
        tmp_ko.unlink()
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if not any("Missing Korean inventory doc" in err for err in errors):
            raise AssertionError("Expected missing Korean doc error, got None")
        tmp_ko.write_text(content_ko, encoding="utf-8")

        # Case 4: Drift in English doc fails closed
        tampered_en = content_en + "\nchanged"
        tmp_en.write_text(tampered_en, encoding="utf-8")
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if not any("Drift detected in" in err for err in errors):
            raise AssertionError("Expected drift detection error in English doc, got None")
        tmp_en.write_text(content_en, encoding="utf-8")

        # Case 5: Drift in Korean doc fails closed
        tampered_ko = content_ko + "\n변경"
        tmp_ko.write_text(tampered_ko, encoding="utf-8")
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if not any("Drift detected in" in err for err in errors):
            raise AssertionError("Expected drift detection error in Korean doc, got None")
        tmp_ko.write_text(content_ko, encoding="utf-8")

        # Case 6: Empty file fails closed
        tmp_en.write_text("", encoding="utf-8")
        errors = gen.check_drift(tmp_en, tmp_ko, inventory)
        if not any("Drift detected in" in err for err in errors):
            raise AssertionError("Expected drift error for empty file, got None")

    print("Platform asset inventory self-test: profile, mapping, CR, CronJob, links, lifecycle and 6 drift fixtures passed.", file=sys.stderr)


def main() -> int:
    helm_version = subprocess.run(["helm", "version", "--short"], capture_output=True, text=True, check=True).stdout.strip()
    print(helm_version_report(helm_version), file=sys.stderr)
    try:
        self_test()
    except AssertionError as exc:
        print(f"FAIL: platform asset inventory self-test failed: {exc}", file=sys.stderr)
        return 1

    errors = gen.check_drift(DOC_EN, DOC_KO)
    if errors:
        print("=== Platform Asset Inventory Drift Gate Check FAIL ===", file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        print("\nRun 'python3 scripts/generate_platform_asset_inventory.py --write' to regenerate documentation.", file=sys.stderr)
        return 1

    print("OK: platform asset inventory documentation matches declared Helm charts and VERSIONS.md (no drift).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
