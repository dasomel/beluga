#!/usr/bin/env python3
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/generate_release_license_inventory.py"
SPEC = importlib.util.spec_from_file_location("release_license_inventory", SCRIPT)
assert SPEC and SPEC.loader
inventory_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inventory_module
SPEC.loader.exec_module(inventory_module)


class ReleaseLicenseInventoryTests(unittest.TestCase):
    def test_inventory_is_sorted_and_contains_policy_and_notice_fields(self):
        rows = inventory_module.build_inventory(
            ROOT / "VERSIONS.md", ROOT / "NOTICE", ROOT / "policies/license-policy.yaml"
        )
        second_build = inventory_module.build_inventory(
            ROOT / "VERSIONS.md", ROOT / "NOTICE", ROOT / "policies/license-policy.yaml"
        )
        self.assertEqual(rows, sorted(rows, key=lambda item: item["component"].casefold()))
        self.assertEqual(inventory_module.render_markdown(rows), inventory_module.render_markdown(second_build))
        self.assertTrue(all({"component", "version", "image_chart", "license", "license_policy_classification",
                            "notice_obligation", "named_in_notice"} <= item.keys() for item in rows))
        self.assertTrue(any(item["named_in_notice"] for item in rows))
        self.assertTrue(any(item["license_policy_classification"] == "own-project" for item in rows))
        own_project = next(item for item in rows if item["license_policy_classification"] == "own-project")
        self.assertEqual(own_project["notice_obligation"], "none (Beluga-owned)")
        curl = next(item for item in rows if item["component"] == "curl (유틸)")
        self.assertEqual(curl["notice_obligation"], "attribution + license text")
        self.assertTrue(curl["named_in_notice"])
        ldapium_ui = next(item for item in rows if item["component"] == "ldapium UI")
        self.assertFalse(ldapium_ui["named_in_notice"])
        self.assertIn("Image / chart", inventory_module.render_markdown(rows))

    def test_cli_writes_deterministic_markdown_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            command = [sys.executable, str(SCRIPT), "--out", str(out)]
            first = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(first.returncode, 0, first.stderr)
            first_json = (out / "release-license-inventory.json").read_text(encoding="utf-8")
            first_md = (out / "release-license-inventory.md").read_text(encoding="utf-8")
            second = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(first_json, (out / "release-license-inventory.json").read_text(encoding="utf-8"))
            self.assertEqual(first_md, (out / "release-license-inventory.md").read_text(encoding="utf-8"))
            data = json.loads(first_json)
            parsed_count = len(inventory_module.license_policy.parse_versions_md(ROOT / "VERSIONS.md"))
            self.assertEqual(len(data), parsed_count)
            self.assertIn("| Component | Version | Image / chart | License |", first_md)

    def test_unknown_license_classification_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = Path(tmp) / "policy.yaml"
            source = (ROOT / "policies/license-policy.yaml").read_text(encoding="utf-8")
            policy.write_text(source.replace("  Apache-2.0: permissive\n", ""), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no license classification"):
                inventory_module.build_inventory(ROOT / "VERSIONS.md", ROOT / "NOTICE", policy)


if __name__ == "__main__":
    unittest.main()
