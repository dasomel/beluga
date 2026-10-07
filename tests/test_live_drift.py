#!/usr/bin/env python3
"""Offline fixture tests for scripts/ops/check-live-drift.py (Issue #39). No cluster is contacted."""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/ops/check-live-drift.py"
SPEC = importlib.util.spec_from_file_location("check_live_drift", SCRIPT)
cld = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cld)

REV = "a" * 40
IGNORE = [{"group": "apps", "kind": "StatefulSet", "jqPathExpressions": [".spec.volumeClaimTemplates[]?.status"]}]
DECLARED = {"Deployment/ns/web": {"containers": {"web": "repo/web:1.0"}, "initContainers": {}},
            "StatefulSet/ns/db": {"containers": {"db": "repo/db:2.0"}, "initContainers": {"init": "repo/init:1"}}}


def app(name="app1", sync="Synced", rev=REV, health="Healthy", resources=None, ignore=None):
    return {"metadata": {"name": name},
            "spec": {"ignoreDifferences": ignore or []},
            "status": {"sync": {"status": sync, "revision": rev}, "health": {"status": health},
                       "resources": resources if resources is not None else [
                           {"kind": "Deployment", "name": "web", "namespace": "ns", "status": "Synced", "group": "apps"},
                           {"kind": "StatefulSet", "name": "db", "namespace": "ns", "status": "Synced", "group": "apps"}]}}


def workload(kind, name, images, init=()):
    """images/init: {container name: image}, or a list (auto-named c0..)."""
    if not isinstance(images, dict):
        images = {f"c{n}": i for n, i in enumerate(images)}
    pod = {"containers": [{"name": n, "image": i} for n, i in images.items()],
           "initContainers": [{"name": n, "image": i} for n, i in dict(init).items()]}
    return {"kind": kind, "metadata": {"namespace": "ns", "name": name}, "spec": {"template": {"spec": pod}}}


def workloads():
    return [workload("Deployment", "web", {"web": "repo/web:1.0"}),
            workload("StatefulSet", "db", {"db": "repo/db:2.0"}, init={"init": "repo/init:1"}),
            workload("Deployment", "operator-managed", {"op": "x/op:1"})]


def run(apps=None, wl=None, declared=None):
    return cld.evaluate(apps if apps is not None else [app()], wl if wl is not None else workloads(),
                        declared if declared is not None else DECLARED, ["app1"], REV)


def classes(report, check):
    return sorted(f["class"] for f in report["findings"] if f["check"] == check)


class EvaluateTests(unittest.TestCase):
    def test_clean_state_passes_and_operator_workload_is_skipped(self):
        r = run()
        self.assertEqual(r["summary"]["unauthorized"], 0)
        self.assertEqual(len(r["skipped"]), 1)
        self.assertIn("operator-managed", r["skipped"][0])

    def test_changed_image_tag_is_unauthorized(self):
        wl = workloads()
        wl[0]["spec"]["template"]["spec"]["containers"][0]["image"] = "repo/web:9.9"
        r = run(wl=wl)
        self.assertEqual(classes(r, "image"), ["unauthorized"])

    def test_changed_init_container_image_is_unauthorized(self):
        wl = workloads()
        wl[1]["spec"]["template"]["spec"]["initContainers"][0]["image"] = "repo/init:2"
        self.assertEqual(classes(run(wl=wl), "image"), ["unauthorized"])

    def test_out_of_sync_resource_not_ignored_is_unauthorized(self):
        a = app()
        a["status"]["resources"][0]["status"] = "OutOfSync"
        self.assertEqual(classes(run(apps=[a]), "resource"), ["unauthorized"])

    def test_out_of_sync_resource_in_ignore_differences_is_expected(self):
        a = app(ignore=IGNORE)
        a["status"]["resources"][1]["status"] = "OutOfSync"
        r = run(apps=[a])
        self.assertEqual(classes(r, "resource"), ["expected"])
        self.assertEqual(r["summary"]["unauthorized"], 0)

    def test_ignore_differences_scoped_to_kind(self):
        a = app(ignore=IGNORE)
        a["status"]["resources"][0]["status"] = "OutOfSync"  # Deployment, rule is StatefulSet only
        self.assertEqual(classes(run(apps=[a]), "resource"), ["unauthorized"])

    def test_wrong_revision_is_unauthorized(self):
        self.assertEqual(classes(run(apps=[app(rev="b" * 40)]), "sync"), ["unauthorized"])

    def test_app_not_synced_is_unauthorized(self):
        self.assertIn("unauthorized", classes(run(apps=[app(sync="OutOfSync")]), "sync"))

    def test_progressing_only_is_not_drift(self):
        r = run(apps=[app(health="Progressing")])
        self.assertEqual(classes(r, "health"), ["tolerated"])
        self.assertEqual(r["summary"]["unauthorized"], 0)

    def test_missing_status_key_is_tolerated(self):
        a = app()
        a["status"]["resources"].append({"kind": "Job", "name": "hook", "namespace": "ns"})
        del a["status"]["resources"][0]["status"]
        r = run(apps=[a])
        self.assertEqual(classes(r, "resource"), ["tolerated", "tolerated"])
        self.assertEqual(r["summary"]["unauthorized"], 0)

    def test_missing_app_and_workload_are_unauthorized(self):
        r = run(apps=[], wl=workloads()[1:])
        self.assertEqual(classes(r, "missing"), ["unauthorized", "unauthorized"])

    def test_emptying_containers_is_unauthorized(self):
        wl = workloads()
        wl[0]["spec"]["template"]["spec"]["containers"] = []
        r = run(wl=wl)
        self.assertEqual(classes(r, "container"), ["unauthorized"])
        self.assertEqual(r["summary"]["unauthorized"], 1)

    def test_extra_container_is_unauthorized(self):
        wl = workloads()
        wl[0]["spec"]["template"]["spec"]["containers"].append({"name": "sidecar", "image": "evil:1"})
        self.assertEqual(classes(run(wl=wl), "container"), ["unauthorized"])

    def test_duplicate_image_across_container_and_init_is_not_collapsed(self):
        decl = {"Deployment/ns/web": {"containers": {"web": "repo/x:1"}, "initContainers": {"init": "repo/x:1"}}}
        wl = [workload("Deployment", "web", {"web": "repo/x:1"})]  # init container removed
        r = run(wl=wl, declared=decl)
        self.assertEqual(classes(r, "container"), ["unauthorized"])

    def test_swapped_images_between_containers_is_unauthorized(self):
        decl = {"Deployment/ns/web": {"containers": {"a": "r/a:1", "b": "r/b:1"}, "initContainers": {}}}
        wl = [workload("Deployment", "web", {"a": "r/b:1", "b": "r/a:1"})]
        self.assertEqual(classes(run(wl=wl, declared=decl), "image"), ["unauthorized", "unauthorized"])

    def test_tracked_live_workload_absent_from_render_fails(self):
        a = app()
        a["status"]["resources"].append({"kind": "Deployment", "name": "operator-managed", "namespace": "ns", "status": "Synced", "group": "apps"})
        r = run(apps=[a])
        self.assertEqual(classes(r, "undeclared"), ["unauthorized"])
        self.assertEqual(r["skipped"], [])

    def test_empty_resources_on_synced_app_is_noted(self):
        r = run(apps=[app(resources=[])], declared={}, wl=[])
        self.assertEqual(classes(r, "resource"), ["tolerated"])
        self.assertIn("no tracked resources", r["findings"][0]["detail"])

    def test_report_names_expected_revision_source(self):
        r = cld.evaluate([app()], workloads(), DECLARED, ["app1"], REV, "origin/main (test)")
        self.assertEqual(r["expected_revision_source"], "origin/main (test)")
        self.assertIn("source: origin/main (test)", cld.human_summary(r))
        self.assertIn("NOT CHECKED", cld.human_summary(r))

    def test_report_is_deterministic(self):
        a = app()
        a["status"]["resources"][0]["status"] = "OutOfSync"
        self.assertEqual(json.dumps(run(apps=[a]), sort_keys=True), json.dumps(run(apps=[copy.deepcopy(a)]), sort_keys=True))


class RealChartsTests(unittest.TestCase):
    def test_declared_charts_render_and_clean_synthetic_cluster_passes(self):
        declared = cld.declared_from_charts()
        self.assertTrue(declared)
        names = cld.declared_app_names()
        self.assertIn("beluga-platform", names)
        wl = []
        for key, images in declared.items():
            kind, ns, name = key.split("/")
            w = workload(kind, name, {n: i for n, i in images["containers"].items()}, init=images["initContainers"])
            w["metadata"]["namespace"] = ns
            if kind == "CronJob":
                w["spec"] = {"jobTemplate": {"spec": w["spec"]}}
            wl.append(w)
        apps = [app(name=n, resources=[]) for n in names]
        self.assertEqual(cld.evaluate(apps, wl, declared, names, REV)["summary"]["unauthorized"], 0)


class MalformedShapeTests(unittest.TestCase):
    """Malformed input must raise InputError (exit 2), never a drift verdict or a bare traceback."""

    def bad(self, mutate_app=None, mutate_wl=None, declared=None):
        a, wl = app(), workloads()
        if mutate_app:
            mutate_app(a)
        if mutate_wl:
            mutate_wl(wl)
        with self.assertRaises(cld.InputError):
            run(apps=[a], wl=wl, declared=declared)

    def test_null_metadata(self):
        self.bad(lambda a: a.update(metadata=None))

    def test_string_metadata(self):
        self.bad(lambda a: a.update(metadata="x"))

    def test_sync_is_string(self):
        self.bad(lambda a: a["status"].update(sync="Synced"))

    def test_resource_entry_is_string(self):
        self.bad(lambda a: a["status"].update(resources=["Deployment/web"]))

    def test_resources_is_string(self):
        self.bad(lambda a: a["status"].update(resources="none"))

    def test_resource_health_is_string(self):
        self.bad(lambda a: a["status"]["resources"][0].update(health="Healthy"))

    def test_ignore_differences_is_string(self):
        self.bad(lambda a: a["spec"].update(ignoreDifferences="all"))

    def test_ignore_differences_entry_is_string(self):
        self.bad(lambda a: a["spec"].update(ignoreDifferences=["all"]))

    def test_status_is_list(self):
        self.bad(lambda a: a.update(status=[]))

    def test_workload_null_metadata(self):
        self.bad(mutate_wl=lambda wl: wl[0].update(metadata=None))

    def test_workload_containers_not_list(self):
        self.bad(mutate_wl=lambda wl: wl[0]["spec"]["template"]["spec"].update(containers="web"))

    def test_workload_container_entry_not_object(self):
        self.bad(mutate_wl=lambda wl: wl[0]["spec"]["template"]["spec"].update(containers=["web"]))

    def test_workload_spec_is_string(self):
        self.bad(mutate_wl=lambda wl: wl[0].update(spec="x"))

    def test_declared_file_shape(self):
        for doc in ([], {"Deployment/ns/web": ["img:1"]}, {"Deployment/ns/web": {"containers": ["x"]}}):
            with self.assertRaises(cld.InputError):
                cld.check_declared(doc)


class ExpectedRevisionTests(unittest.TestCase):
    def patched(self, outputs):
        def fake(*cmd, timeout=30):
            return outputs.get(cmd[0])
        return mock.patch.object(cld, "git_out", fake)

    def test_explicit_revision_needs_no_git(self):
        with self.patched({}):
            self.assertEqual(cld.expected_revision(REV), (REV, "--expect-revision"))

    def test_unresolvable_origin_main_is_exit_2_class_error_not_head(self):
        with self.patched({"rev-parse": None}):
            with self.assertRaises(cld.InputError) as cm:
                cld.expected_revision(None)
        self.assertIn("--expect-revision", str(cm.exception))

    def test_remote_unreachable_fails_closed(self):
        with self.patched({"rev-parse": REV, "ls-remote": None}):
            with self.assertRaises(cld.InputError):
                cld.expected_revision(None)

    def test_stale_local_origin_main_fails(self):
        with self.patched({"rev-parse": REV, "ls-remote": ("b" * 40) + "\trefs/heads/main"}):
            with self.assertRaises(cld.InputError) as cm:
                cld.expected_revision(None)
        self.assertIn("stale", str(cm.exception))

    def test_fresh_origin_main_reports_source(self):
        with self.patched({"rev-parse": REV, "ls-remote": REV + "\trefs/heads/main"}):
            sha, src = cld.expected_revision(None)
        self.assertEqual(sha, REV)
        self.assertIn("ls-remote", src)


class CliTests(unittest.TestCase):
    def cli(self, *args, env=None):
        e = {**os.environ, **(env or {})}
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=e)

    def files(self, d, apps, wl):
        paths = []
        for name, data in (("apps.json", {"items": apps}), ("wl.json", {"items": wl}), ("decl.json", DECLARED)):
            p = Path(d) / name
            p.write_text(json.dumps(data))
            paths.append(str(p))
        return paths

    def test_exit_codes_from_files(self):
        with tempfile.TemporaryDirectory() as d:
            a, w, decl = self.files(d, [app()], workloads())
            base = ["--apps-file", a, "--workloads-file", w, "--declared-file", decl, "--expect-revision", REV]
            # apps declared in gitops/apps are not in this tiny fixture, so they are reported missing
            r = self.cli(*base)
            self.assertEqual(r.returncode, 1)
            self.assertIn("RESULT: FAIL", r.stderr)

    def test_clean_files_exit_0_and_report_is_json(self):
        with tempfile.TemporaryDirectory() as d:
            a, w, decl = self.files(d, [app(name=n, resources=[]) for n in cld.declared_app_names()], workloads())
            r = self.cli("--apps-file", a, "--workloads-file", w, "--declared-file", decl, "--expect-revision", REV)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["summary"]["unauthorized"], 0)
            self.assertIn("RESULT: PASS", r.stderr)

    def test_malformed_shapes_exit_2_not_1_and_no_traceback(self):
        names = cld.declared_app_names()
        for mutate in (lambda a: a.update(metadata=None), lambda a: a["status"].update(sync="Synced"),
                       lambda a: a["status"].update(resources=["x"])):
            apps = [app(name=n, resources=[]) for n in names]
            mutate(apps[0])
            with tempfile.TemporaryDirectory() as d:
                ap, w, decl = self.files(d, apps, workloads())
                r = self.cli("--apps-file", ap, "--workloads-file", w, "--declared-file", decl, "--expect-revision", REV)
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertNotIn("Traceback", r.stderr)

    def test_no_expect_revision_and_unresolvable_origin_is_exit_2(self):
        with tempfile.TemporaryDirectory() as d:
            ap, w, decl = self.files(d, [app()], workloads())
            # a throwaway git dir with no origin: REPO_ROOT-based git cannot be redirected, so use a fake `git` on PATH
            fake = Path(d) / "git"
            fake.write_text("#!/bin/sh\nexit 1\n")
            fake.chmod(0o755)
            r = self.cli("--apps-file", ap, "--workloads-file", w, "--declared-file", decl,
                         env={"PATH": f"{d}:{os.environ['PATH']}"})
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn("--expect-revision", r.stderr)

    def test_unreadable_input_is_exit_2(self):
        r = self.cli("--apps-file", "/nonexistent/a.json", "--workloads-file", "/nonexistent/w.json", "--expect-revision", REV)
        self.assertEqual(r.returncode, 2)

    def test_unreachable_cluster_fails_closed(self):
        r = self.cli("--expect-revision", REV, env={"KUBECTL": "/nonexistent/kubectl"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("unreachable", r.stderr)

    def test_skip_if_unreachable_exits_0_with_message(self):
        r = self.cli("--expect-revision", REV, "--skip-if-unreachable", env={"KUBECTL": "/nonexistent/kubectl"})
        self.assertEqual(r.returncode, 0)
        self.assertIn("SKIPPED", r.stderr)

    def test_skip_flag_does_not_hide_unreadable_file(self):
        r = self.cli("--from-file", "/nonexistent/x.json", "--skip-if-unreachable", "--expect-revision", REV)
        self.assertEqual(r.returncode, 2)

    def test_kubectl_only_ever_gets_the_get_verb(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "argv.log"
            fake = Path(d) / "kubectl"
            fake.write_text(f"#!/bin/sh\necho \"$1\" >> {log}\necho '{{\"items\": []}}'\n")
            fake.chmod(0o755)
            decl = Path(d) / "decl.json"
            decl.write_text("{}")
            self.cli("--declared-file", str(decl), "--expect-revision", REV, env={"KUBECTL": str(fake)})
            self.assertEqual(set(log.read_text().split()), {"get"})


if __name__ == "__main__":
    unittest.main(verbosity=1)
