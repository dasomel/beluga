#!/usr/bin/env python3
"""Regression tests for scripts/ci/check-external-endpoints.py (Issue #36 static slice).

Fixtures are tiny temp repositories; image refs are injected so no helm is needed.
Negative cases: new host, new phase for a known host, stale entry, malformed baseline,
undocumented host. Extraction cases: comments/echo/internal/templated hosts are ignored.
"""
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci" / "check-external-endpoints.py"
spec = importlib.util.spec_from_file_location("check_external_endpoints", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def baseline_text(*entries):
    return "endpoints:\n" + "".join(
        f"- host: {h}\n  phase: {p}\n  reason: \"r\"\n" for h, p in entries)


class Fixture:
    """A temp repo whose docs mention every baseline host unless `docs` overrides."""

    def __init__(self, files, entries, docs=None, fill_roots=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        if fill_roots:  # the gate fails closed on a missing/empty source root, so give each a quiet file
            files = {"scripts/.fill.sh": "", "gitops/apps/fill.yaml": "", "gitops/charts/fill.yaml": "",
                     "demo/fill/Dockerfile": "", **files}
        for rel, text in files.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        self.baseline = self.root / "baseline.yaml"
        self.baseline.write_text(baseline_text(*entries), encoding="utf-8")
        doc = docs if docs is not None else " ".join(f"`{h}`" for h, _ in entries)
        for rel in mod.DOCS:
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(doc, encoding="utf-8")

    def run(self, refs=()):
        try:
            errors, _ = mod.evaluate(self.root, self.baseline, list(refs))
        finally:
            self.tmp.cleanup()
        return errors


# Built from parts so check-dependency-integrity.py does not read this fixture as a real unpinned install.
PIP_INSTALL = "pip" + " install"
SCRIPT_OK = {"scripts/cluster/a.sh": "curl -sfL https://get.example.com/install | sh\n"}
ENTRY_OK = [("get.example.com", "host-install")]


class ExtractionTest(unittest.TestCase):
    def hosts(self, rel, text):
        return {(h, p) for h, p, _ in mod.scan_text(rel, text)}

    def test_literal_url_and_phase_from_path(self):
        self.assertEqual(self.hosts("scripts/gitops/x.sh", "curl https://a.example.org/x\n"),
                         {("a.example.org", "deploy-bootstrap")})
        self.assertEqual(self.hosts("gitops/apps/x.yaml", "repoURL: https://a.example.org/r.git\n"),
                         {("a.example.org", "gitops-sync")})
        self.assertEqual(self.hosts("gitops/charts/c/t.yaml", "curl https://a.example.org/x\n"),
                         {("a.example.org", "pod-runtime")})

    def test_ignored_lines(self):
        text = "\n".join([
            "# curl https://comment.example.org/x",
            "  # indented https://comment2.example.org/x",
            'echo "see https://echo.example.org/doc"',
            'log_error "install: https://log.example.org/doc"',
            "run_it  # https://trailing.example.org",
            "curl http://svc.ns.svc.cluster.local:8080",
            "curl http://trino:8080 http://localhost:1 http://127.0.0.1:2 http://sso.local.beluga.internal",
            'curl https://sso.{{ .Values.baseDomain }}/x https://${HOST}/y https://sso.${D}/z https://x.<name>/',
            "curl https://kubernetes.default.svc",
        ])
        self.assertEqual(self.hosts("scripts/a.sh", text), set())

    def test_implicit_endpoints(self):
        self.assertEqual(self.hosts("gitops/charts/c/t.yaml", '"' + PIP_INSTALL + ' pkg"\n'),
                         {("pypi.org", "pod-runtime"), ("files.pythonhosted.org", "pod-runtime")})
        self.assertEqual(self.hosts("scripts/a.sh", "sudo apt-get install -y -qq dnsmasq\n"),
                         {("apt-os-mirrors", "host-install")})
        self.assertEqual(self.hosts("Vagrantfile", "  config.vm.box = box_name\n"),
                         {("app.vagrantup.com", "host-install")})
        self.assertEqual(self.hosts("demo/x/Dockerfile", "FROM python:3.12-slim AS b\nFROM b\nFROM ghcr.io/o/i:1\n"),
                         {("docker.io", "demo-build"), ("ghcr.io", "demo-build")})

    def test_userinfo_ftp_ssh_and_git_forms(self):
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://user:pw@evil5.example.net/x\n"),
                         {("evil5.example.net", "host-install")})
        self.assertEqual(self.hosts("scripts/a.sh", "curl ftp://f.example.net/x ssh://git@s.example.net/r\n"),
                         {("f.example.net", "host-install"), ("s.example.net", "host-install")})
        self.assertEqual(self.hosts("scripts/a.sh", "git clone git@git.example.net:o/r.git\n"),
                         {("git.example.net", "host-install")})
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://user@localhost/x https://u@svc.ns.svc/y\n"), set())
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://a.example.org?mail=x@y.example.net\n"),
                         {("a.example.org", "host-install")})
        # the last `@` of the authority delimits userinfo; an empty userinfo must not hide the host
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://a@b@evil8.example.net/x\n"),
                         {("evil8.example.net", "host-install")})
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://@evil7.example.net/x\n"),
                         {("evil7.example.net", "host-install")})
        self.assertEqual(self.hosts("scripts/a.sh", "curl https://a.example.org/p@q.example.net\n"),
                         {("a.example.org", "host-install")})

    def test_registry_of(self):
        self.assertEqual(mod.registry_of("flink:1.20"), "docker.io")
        self.assertEqual(mod.registry_of("apache/airflow:3"), "docker.io")
        self.assertEqual(mod.registry_of("quay.io/keycloak/keycloak:26"), "quay.io")
        self.assertEqual(mod.registry_of("registry.example.org:5000/a/b:1"), "registry.example.org")
        self.assertEqual(mod.registry_of("localhost:5000/a:1"), "localhost")


class RatchetTest(unittest.TestCase):
    def test_matching_baseline_passes(self):
        self.assertEqual(Fixture(SCRIPT_OK, ENTRY_OK).run(), [])

    def test_new_host_fails(self):
        files = {**SCRIPT_OK, "scripts/cluster/b.sh": "wget https://new.example.net/f\n"}
        errors = Fixture(files, ENTRY_OK).run()
        self.assertEqual(len(errors), 1)
        self.assertIn("NEW external endpoint new.example.net", errors[0])
        self.assertIn("scripts/cluster/b.sh:1", errors[0])

    def test_host_hidden_behind_userinfo_fails(self):
        files = {**SCRIPT_OK, "scripts/cluster/b.sh": "wget https://user@evil5.example.net/x\n"}
        errors = Fixture(files, ENTRY_OK).run()
        self.assertEqual(len(errors), 1)
        self.assertIn("NEW external endpoint evil5.example.net (phase host-install)", errors[0])

    def test_missing_or_empty_source_root_fails_explicitly(self):
        for root in ("scripts", "gitops/apps", "gitops/charts", "demo"):
            fx = Fixture(SCRIPT_OK, ENTRY_OK)
            shutil.rmtree(fx.root / root)
            if root == "demo":  # empty (not missing) root: dir present, no Dockerfile
                (fx.root / root).mkdir()
            with self.assertRaises(ValueError) as ctx:
                try:
                    mod.evaluate(fx.root, fx.baseline, [])
                finally:
                    fx.tmp.cleanup()
            self.assertIn(f"source root {root}/ is missing or yields zero files", str(ctx.exception))

    def test_known_host_in_new_phase_fails(self):
        files = {**SCRIPT_OK, "gitops/charts/c/t.yaml": "curl https://get.example.com/x\n"}
        errors = Fixture(files, ENTRY_OK).run()
        self.assertEqual(len(errors), 1)
        self.assertIn("get.example.com (phase pod-runtime)", errors[0])

    def test_removed_host_is_stale_failure(self):
        errors = Fixture({"scripts/cluster/a.sh": "echo none\n"}, ENTRY_OK).run()
        self.assertEqual(len(errors), 1)
        self.assertIn("STALE baseline entry get.example.com", errors[0])

    def test_new_image_registry_fails(self):
        entries = ENTRY_OK
        errors = Fixture(SCRIPT_OK, entries).run(refs=["quay.io/x/y:1", "flink:1.20"])
        self.assertEqual(sorted(e.split()[3] for e in errors), ["docker.io", "quay.io"])

    def test_listed_image_registry_passes(self):
        entries = ENTRY_OK + [("quay.io", "image-registry")]
        self.assertEqual(Fixture(SCRIPT_OK, entries).run(refs=["quay.io/x/y:1"]), [])

    def test_undocumented_host_fails(self):
        errors = Fixture(SCRIPT_OK, ENTRY_OK, docs="nothing here").run()
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("get.example.com" in e and "not documented" in e for e in errors))


class MalformedBaselineTest(unittest.TestCase):
    def load(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "b.yaml"
            path.write_text(text, encoding="utf-8")
            return mod.load_baseline(path)

    def assert_rejected(self, text, fragment):
        with self.assertRaises(ValueError) as ctx:
            self.load(text)
        self.assertIn(fragment, str(ctx.exception))

    def test_reserved_implicit_placeholder_is_accepted(self):
        self.assertIn(("apt-os-mirrors", "host-install"), self.load(baseline_text(("apt-os-mirrors", "host-install"))))

    def test_valid(self):
        self.assertEqual(set(self.load(baseline_text(*ENTRY_OK))), set(ENTRY_OK))

    def test_rejections(self):
        self.assert_rejected("- host: a.example.org\n", "mapping")
        self.assert_rejected("endpoints: []\n", "empty")
        self.assert_rejected("endpoints: x\n", "mapping")
        self.assert_rejected("endpoints:\n- host: a.example.org\n  phase: host-install\n", "exactly host, phase, reason")
        self.assert_rejected("endpoints:\n- host: a.example.org\n  phase: nowhere\n  reason: r\n", "unknown phase")
        for bad in ("apt-os-mirrors2", "localhost", "not a host", "a..b.org", "-a.org", "evil"):
            self.assert_rejected(f"endpoints:\n- host: '{bad}'\n  phase: host-install\n  reason: r\n", "invalid host")
        self.assert_rejected("endpoints:\n- host: A_B\n  phase: host-install\n  reason: r\n", "invalid host")
        self.assert_rejected("endpoints:\n- host: a.example.org\n  phase: host-install\n  reason: ' '\n", "empty reason")
        self.assert_rejected(baseline_text(*ENTRY_OK, *ENTRY_OK), "duplicate")
        self.assert_rejected("endpoints: [", "invalid YAML")


class RealRepoTest(unittest.TestCase):
    def test_real_baseline_loads_and_hosts_are_documented(self):
        baseline = mod.load_baseline(mod.BASELINE_PATH)
        self.assertEqual(mod.check_docs(mod.REPO_ROOT, baseline), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
