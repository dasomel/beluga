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

    def test_memory_suffixes_decimals_and_bytes(self):
        self.assertEqual(sizing.memory_mib("1Ti"), 1024**2)
        self.assertEqual(sizing.memory_mib("1Ei"), 1024**4)
        self.assertEqual(sizing.memory_mib("1k"), 1000 / 1024**2)
        self.assertEqual(sizing.memory_mib("2M"), 2 * 1000**2 / 1024**2)
        self.assertEqual(sizing.memory_mib("1P"), 1000**5 / 1024**2)
        self.assertEqual(sizing.memory_mib("1.5Gi"), 1536)
        self.assertEqual(sizing.memory_mib(".5Gi"), 512)
        self.assertEqual(sizing.memory_mib("1048576"), 1)

    def test_invalid_memory_quantity_names_value_and_workload(self):
        for bad in ("1e3", "12Xi", "Gi", "", "1K", "-1Mi", "1Gi\n", "\u0663Gi"):
            with self.assertRaises(ValueError, msg=bad) as ctx:
                sizing.memory_mib(bad)
            self.assertIn(repr(bad), str(ctx.exception))
        doc = deployment("web", 1, [container("c", "100m", "1e3", "100m", "1Gi")])
        with self.assertRaises(ValueError) as ctx:
            sizing.workload_record(doc)
        self.assertIn("Deployment/ns/web", str(ctx.exception))
        self.assertIn("'1e3'", str(ctx.exception))


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

    def test_absent_limits_make_limits_partial_and_pct_na(self):
        docs = [deployment("a", 1, [container("c", "100m", "128Mi", "200m", "256Mi")]),
                deployment("b", 1, [container("c", "100m", "128Mi")])]
        workloads = sizing.collect_render(docs)
        self.assertEqual({w["name"]: w["limitsPartial"] for w in workloads}, {"a": False, "b": True})
        summary = sizing.summarize(workloads)
        self.assertTrue(summary["total"]["limitsPartial"])
        profile = {"capacity": {"cpuMillicores": 1000, "memoryMiB": 1024, "workerMemoryMiB": 1024, "workerCpuMillicores": 1000}}
        self.assertIsNone(sizing.evaluate(profile, summary, workloads)["limitsPctOfCapacity"])
        full = sizing.collect_render(docs[:1])
        self.assertEqual(sizing.evaluate(profile, sizing.summarize(full), full)["limitsPctOfCapacity"], {"cpu": 20.0, "memory": 25.0})

    def test_init_container_limits_do_not_make_partial(self):
        w = sizing.collect_render([deployment("a", 1, [container("c", "1", "1Gi", "1", "1Gi")], init=[container("i")])])[0]
        self.assertFalse(w["limitsPartial"])
        self.assertTrue(w["gaps"])

    def test_flink_missing_field_goes_through_gaps(self):
        flink = {"kind": "FlinkDeployment", "metadata": {"name": "f", "namespace": "ns"},
                 "spec": {"jobManager": {"resource": {"cpu": 1}}, "taskManager": {"resource": {"cpu": 2, "memory": "2Gi"}}}}
        w = sizing.collect_render([flink])[0]
        self.assertEqual(w["gaps"], ["jobManager: resource.memory"])
        self.assertEqual(w["limits"], {"cpu": 3000, "memory": 2048})
        self.assertTrue(w["limitsPartial"])

    def test_kafka_and_cluster_default_requests_to_limits(self):
        limits = {"limits": {"cpu": "2", "memory": "4Gi"}}
        kafka = {"kind": "Kafka", "metadata": {"name": "k", "namespace": "ns"}, "spec": {"kafka": {"resources": limits}}}
        cluster = {"kind": "Cluster", "metadata": {"name": "c", "namespace": "ns"}, "spec": {"instances": 2, "resources": limits}}
        for w in sizing.collect_render([kafka, cluster]):
            count = w["replicas"]
            self.assertEqual(w["requests"], {"cpu": 2000 * count, "memory": 4096 * count}, w["id"])
            self.assertEqual(w["requests"], w["limits"])

    def test_cluster_and_kafka_limits_partial_flag(self):
        def cluster(res):
            return {"kind": "Cluster", "metadata": {"name": "c", "namespace": "ns"}, "spec": {"instances": 1, "resources": res}}

        def kafka(res):
            return {"kind": "Kafka", "metadata": {"name": "k", "namespace": "ns"}, "spec": {"kafka": {"resources": res}}}
        full = {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "1", "memory": "1Gi"}}
        absent = {"requests": {"cpu": "1", "memory": "1Gi"}}
        for make in (cluster, kafka):
            self.assertFalse(sizing.collect_render([make(full)])[0]["limitsPartial"], make.__name__)
            self.assertTrue(sizing.collect_render([make(absent)])[0]["limitsPartial"], make.__name__)
        pool = {"kind": "KafkaNodePool", "metadata": {"name": "p", "namespace": "ns"}, "spec": {"replicas": 1, "resources": absent}}
        self.assertTrue(sizing.collect_render([pool])[0]["limitsPartial"])

    def test_markdown_and_json_render_partial_as_na(self):
        docs = [deployment("a", 1, [container("c", "100m", "128Mi")])]
        profiles = {"32": {"optionalServices": False, "workerNodes": 1, "capacity": {
            "cpuMillicores": 1000, "memoryMiB": 1024, "workerMemoryMiB": 1024, "workerCpuMillicores": 1000}}}
        report = sizing.build_report({"base": docs, "optional-services": docs}, profiles)
        self.assertIsNone(json.loads(json.dumps(report))["profiles"]["32"]["limitsPctOfCapacity"])
        md = sizing.render_markdown(report)
        self.assertIn("n/a*", md)
        self.assertIn("0 / 0 (partial) |", md)
        ok = [deployment("a", 1, [container("c", "100m", "128Mi", "100m", "128Mi")])]
        md_ok = sizing.render_markdown(sizing.build_report({"base": ok, "optional-services": ok}, profiles))
        self.assertNotIn("n/a*", md_ok)
        self.assertNotIn(" (partial) |", md_ok)

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
