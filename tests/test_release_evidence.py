#!/usr/bin/env python3
"""Release SBOM / evidence bundle / required-check gate: positive and fail-closed tests (Issue #100)."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a" * 40
RENDERED = "kind: Pod\nspec:\n  containers:\n    - image: quay.io/x/app:1.2.3\n    - image: ghcr.io/y/z@sha256:" + "b" * 64 + "\n"


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sbom = load("t_sbom", "scripts/release/generate_sbom.py")
bundle = load("t_bundle", "scripts/release/evidence_bundle.py")
checks = load("t_checks", "scripts/release/verify_required_checks.py")

VERSIONS = """| 컴포넌트 | 버전 | 이미지 | 라이선스 | 비고 |
|---|---|---|---|---|
| Foo | 1.0 | `quay.io/x/app:1.2.3` | Apache-2.0 | n |
"""
POLICY = """approved_licenses: [Apache-2.0]
own_project_marker: {value: "해당 없음 — 자체 프로젝트", rationale: r}
license_classifications: {Apache-2.0: permissive}
"""


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.versions = self.tmp / "VERSIONS.md"
        self.versions.write_text(VERSIONS, encoding="utf-8")
        self.policy = self.tmp / "policy.yaml"
        self.policy.write_text(POLICY, encoding="utf-8")
        self.notice = self.tmp / "NOTICE"
        self.notice.write_text((ROOT / "NOTICE").read_text(encoding="utf-8"), encoding="utf-8")
        self.out = self.tmp / "out"

    def build(self, rendered=RENDERED, version="v1.2.3", commit=COMMIT):
        bundle.build(self.out, version, commit, self.versions, self.notice, self.policy, rendered)


class SbomTests(Fixture):
    def test_components_from_versions_and_images(self):
        bom = sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, RENDERED)
        refs = {c["bom-ref"] for c in bom["components"]}
        self.assertIn("image:quay.io/x/app:1.2.3", refs)
        self.assertEqual(bom["specVersion"], "1.5")
        digest = [c for c in bom["components"] if c["name"] == "ghcr.io/y/z"][0]
        self.assertEqual(digest["version"], "sha256:" + "b" * 64)

    def test_deterministic(self):
        a = sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, RENDERED)
        b = sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, RENDERED)
        self.assertEqual(a, b)

    def test_fail_closed_no_images(self):
        with self.assertRaises(sbom.SbomError):
            sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, "kind: ConfigMap\n")

    def test_fail_closed_untagged_image(self):
        with self.assertRaises(sbom.SbomError):
            sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, "image: quay.io/x/app\n")

    def test_fail_closed_empty_versions(self):
        self.versions.write_text("no table\n", encoding="utf-8")
        with self.assertRaises(sbom.SbomError):
            sbom.build_bom("v1.2.3", COMMIT, self.versions, self.policy, RENDERED)

    def test_fail_closed_bad_commit(self):
        with self.assertRaises(sbom.SbomError):
            sbom.build_bom("v1.2.3", "short", self.versions, self.policy, RENDERED)


class BundleTests(Fixture):
    def test_roundtrip_and_cli_offline_verify(self):
        self.build()
        bundle.verify(self.out, COMMIT)
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/release/evidence_bundle.py"), "verify", str(self.out)],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_unapproved_license_blocks_bundle(self):
        self.versions.write_text(VERSIONS.replace("Apache-2.0", "GPL-3.0"), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse((self.out / "SHA256SUMS").exists())

    def test_sbom_failure_blocks_bundle(self):
        with self.assertRaises(ValueError):
            self.build(rendered="kind: ConfigMap\n")
        self.assertFalse((self.out / "SHA256SUMS").exists())

    def test_bad_version_rejected(self):
        with self.assertRaises(bundle.EvidenceError):
            self.build(version="latest")

    def test_tampered_file_detected(self):
        self.build()
        (self.out / "sbom.cdx.json").write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "checksum mismatch"):
            bundle.verify(self.out)

    def test_missing_file_detected(self):
        self.build()
        (self.out / "release-license-inventory.md").unlink()
        with self.assertRaisesRegex(bundle.EvidenceError, "missing"):
            bundle.verify(self.out)

    def test_extra_file_detected(self):
        self.build()
        (self.out / "extra.txt").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "unlisted"):
            bundle.verify(self.out)

    def test_missing_sums_detected(self):
        self.build()
        (self.out / "SHA256SUMS").unlink()
        with self.assertRaises(bundle.EvidenceError):
            bundle.verify(self.out)

    def test_path_traversal_entry_rejected(self):
        self.build()
        sums = self.out / "SHA256SUMS"
        sums.write_text(sums.read_text(encoding="utf-8") + "0" * 64 + "  ../evil\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "malformed"):
            bundle.verify(self.out)

    def test_consistent_but_forged_manifest_commit_detected(self):
        self.build()
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        manifest["commit"] = "c" * 40
        (self.out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "does not match manifest"):
            bundle.verify(self.out)

    def test_expected_commit_mismatch(self):
        self.build()
        with self.assertRaisesRegex(bundle.EvidenceError, "expected"):
            bundle.verify(self.out, "d" * 40)


class RequiredChecksTests(unittest.TestCase):
    def run_json(self, *runs):
        return checks.evaluate("\n".join(json.dumps(r) for r in runs))

    def ok(self, name, id_=1, conclusion="success"):
        return {"id": id_, "name": name, "status": "completed", "conclusion": conclusion}

    def test_pass(self):
        self.assertEqual(self.run_json(self.ok("trivy-config"), self.ok("trivy-secrets")), [])

    def test_missing_check_blocks(self):
        self.assertTrue(self.run_json(self.ok("trivy-config")))

    def test_failed_check_blocks(self):
        self.assertTrue(self.run_json(self.ok("trivy-config", conclusion="failure"), self.ok("trivy-secrets")))

    def test_pending_check_blocks(self):
        pending = {"id": 1, "name": "trivy-secrets", "status": "in_progress", "conclusion": None}
        self.assertTrue(self.run_json(self.ok("trivy-config"), pending))

    def test_newest_rerun_wins(self):
        self.assertEqual(self.run_json(self.ok("trivy-config", 1, "failure"), self.ok("trivy-config", 2),
                                       self.ok("trivy-secrets")), [])

    def test_empty_or_garbage_blocks(self):
        self.assertTrue(checks.evaluate(""))
        self.assertTrue(checks.evaluate("not json"))


if __name__ == "__main__":
    unittest.main()
