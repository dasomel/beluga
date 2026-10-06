#!/usr/bin/env python3
"""Regression tests for scripts/generate_sizing_report.py (Issue #40, declared-state slice)."""
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/generate_sizing_report.py"
SPEC = importlib.util.spec_from_file_location("sizing_report", SCRIPT)
assert SPEC and SPEC.loader
sizing = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sizing
SPEC.loader.exec_module(sizing)


def deployment(name, replicas, containers, init=None):
    return {"kind": "Deployment", "metadata": {"name": name, "namespace": "ns"},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": containers, "initContainers": init or []}}}}


def container(name, cpu=None, mem=None, lcpu=None, lmem=None):
    res = {}
    if cpu or mem:
        res["requests"] = {k: v for k, v in (("cpu", cpu), ("memory", mem)) if v}
    if lcpu or lmem:
        res["limits"] = {k: v for k, v in (("cpu", lcpu), ("memory", lmem)) if v}
    return {"name": name, **({"resources": res} if res else {})}


class QuantityTests(unittest.TestCase):
    def test_units(self):
        self.assertEqual(sizing.cpu_millicores("250m"), 250)
        self.assertEqual(sizing.cpu_millicores(1.0), 1000)
        self.assertEqual(sizing.memory_mib("1Gi"), 1024)
        self.assertEqual(sizing.memory_mib("512Mi"), 512)
        self.assertEqual(sizing.memory_mib("1024m", flink=True), 1024)


class ProfileParsingTests(unittest.TestCase):
    def test_real_env_sh_profiles(self):
        profiles = sizing.parse_profiles(sizing.ENV_SH.read_text(), sizing.VAGRANTFILE.read_text())
        self.assertEqual(sorted(profiles), ["32", "48", "64"])
        # 32GB: master 2 vCPU/4096 + 3 x (4 vCPU/8192) = 14 vCPU / 28672 MiB (README)
        self.assertEqual(profiles["32"]["capacity"]["cpuMillicores"], 14000)
        self.assertEqual(profiles["32"]["capacity"]["memoryMiB"], 28672)
        self.assertEqual([profiles[p]["optionalServices"] for p in ("32", "48", "64")], [False, True, True])


class WorkloadTests(unittest.TestCase):
    def test_sum_replicas_and_missing_flags(self):
        docs = [deployment("a", 2, [container("c", "100m", "128Mi", "200m", "256Mi")]),
                deployment("b", 1, [container("c")], init=[container("i", "50m", "64Mi", "50m", "64Mi")])]
        workloads = {w["name"]: w for w in sizing.collect_render(docs)}
        self.assertEqual(workloads["a"]["requests"], {"cpu": 200, "memory": 256})
        self.assertEqual(workloads["a"]["limits"], {"cpu": 400, "memory": 512})
        self.assertEqual(workloads["a"]["gaps"], [])
        self.assertEqual(workloads["b"]["gaps"], ["c (main): requests.cpu requests.memory limits.cpu limits.memory"])
        self.assertEqual(workloads["b"]["requests"]["memory"], 64)  # init floor

    def test_limits_only_defaults_requests(self):
        w = sizing.collect_render([deployment("a", 1, [container("c", lcpu="300m", lmem="1Gi")])])[0]
        self.assertEqual(w["requests"], {"cpu": 300, "memory": 1024})
        self.assertIn("requests.cpu", w["gaps"][0])

    def test_jobs_are_transient_and_not_summed(self):
        job = {"kind": "Job", "metadata": {"name": "j", "namespace": "ns"},
               "spec": {"template": {"spec": {"containers": [container("c", "1", "1Gi", "1", "1Gi")]}}}}
        workloads = sizing.collect_render([job])
        self.assertTrue(workloads[0]["transient"])
        self.assertEqual(sizing.summarize(workloads)["total"]["requests"], {"cpu": 0, "memory": 0})

    def test_kafka_cr_without_resources_is_flagged(self):
        w = sizing.collect_render([{"kind": "Kafka", "metadata": {"name": "k", "namespace": "ns"}, "spec": {"kafka": {}}}])[0]
        self.assertTrue(w["gaps"])


class ReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rendered, cls.profiles = sizing.render_all()
        cls.report = sizing.build_report(cls.rendered, cls.profiles)

    def test_deterministic_and_no_timestamps(self):
        again = sizing.build_report(*sizing.render_all())
        self.assertEqual(json.dumps(self.report, sort_keys=True), json.dumps(again, sort_keys=True))
        self.assertEqual(sizing.render_markdown(self.report), sizing.render_markdown(again))
        self.assertFalse(re.search(r"\d{4}-\d{2}-\d{2}", sizing.render_markdown(self.report)))

    def test_real_profiles_not_oversubscribed(self):
        self.assertEqual({n: p["oversubscribed"] for n, p in self.report["profiles"].items()},
                         {"32": False, "48": False, "64": False})

    def test_optional_services_only_in_48_plus_render(self):
        ids = {k: {w["id"] for w in r["workloads"]} for k, r in self.report["renders"].items()}
        self.assertIn("Deployment/analytics/trino-worker", ids["optional-services"] - ids["base"])


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_check_passes_on_repo(self):
        result = self.run_cli("--check")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_fails_on_oversubscribed_profile_fixture(self):
        env = sizing.ENV_SH.read_text()
        tiny = re.sub(r'(WORKER_MEMORY:-)\d+', r'\g<1>2048', env, count=1)  # profile 64 workers: 2GiB each
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "env.sh"
            fixture.write_text(tiny)
            result = self.run_cli("--check", "--env-file", str(fixture))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("FAIL profile 64", result.stderr)
        self.assertIn("OVERSUBSCRIBED", result.stdout)
        self.assertNotIn("FAIL profile 32", result.stderr)

    def test_out_writes_md_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_cli("--out", tmp).returncode, 0)
            self.assertTrue(json.loads((Path(tmp) / "sizing-report.json").read_text())["profiles"])
            self.assertIn("Declared Resource Sizing Report", (Path(tmp) / "sizing-report.md").read_text())


if __name__ == "__main__":
    unittest.main()
