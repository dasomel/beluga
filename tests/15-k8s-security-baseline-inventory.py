#!/usr/bin/env python3
"""Static/offline unit tests for scripts/ci/check-k8s-security-baseline.py (Issue #125).

Exercises the pure parsing/classification functions directly against synthetic
resource dicts, so it needs no live cluster and no `helm template` render.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "ci" / "check-k8s-security-baseline.py"
SPEC = importlib.util.spec_from_file_location("beluga_k8s_security_baseline", MODULE_PATH)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)


def container(name, *, run_as_non_root=None, allow_priv_esc=None, read_only_fs=None,
              seccomp=None, drop=None, add=None, privileged=None):
    sc = {}
    if run_as_non_root is not None:
        sc["runAsNonRoot"] = run_as_non_root
    if allow_priv_esc is not None:
        sc["allowPrivilegeEscalation"] = allow_priv_esc
    if read_only_fs is not None:
        sc["readOnlyRootFilesystem"] = read_only_fs
    if seccomp is not None:
        sc["seccompProfile"] = {"type": seccomp}
    if drop is not None or add is not None:
        sc["capabilities"] = {}
        if drop is not None:
            sc["capabilities"]["drop"] = drop
        if add is not None:
            sc["capabilities"]["add"] = add
    if privileged is not None:
        sc["privileged"] = privileged
    return {"name": name, "securityContext": sc} if sc else {"name": name}


RESTRICTED = dict(run_as_non_root=True, allow_priv_esc=False, read_only_fs=True,
                   seccomp="RuntimeDefault", drop=["ALL"])


class NetworkPolicyCoverageTests(unittest.TestCase):
    def test_empty_ingress_and_egress_is_default_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "deny-all", "namespace": "app"},
              "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}}
        cov = mod.network_policy_coverage([np])
        self.assertTrue(cov["app"]["defaultDenyIngress"])
        self.assertTrue(cov["app"]["defaultDenyEgress"])

    def test_scoped_pod_selector_does_not_count_as_default_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "scoped", "namespace": "app"},
              "spec": {"podSelector": {"matchLabels": {"app": "x"}}, "policyTypes": ["Ingress"]}}
        cov = mod.network_policy_coverage([np])
        self.assertFalse(cov["app"]["defaultDenyIngress"])

    def test_allow_rule_present_is_not_default_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "allow-dns", "namespace": "app"},
              "spec": {"podSelector": {}, "policyTypes": ["Egress"],
                       "egress": [{"ports": [{"port": 53}]}]}}
        cov = mod.network_policy_coverage([np])
        self.assertFalse(cov["app"]["defaultDenyEgress"])

    def test_omitted_policy_types_with_empty_selector_denies_ingress_only(self) -> None:
        # K8s defaults policyTypes to [Ingress] (+ Egress only if egress rules exist).
        np = {"kind": "NetworkPolicy", "metadata": {"name": "implicit", "namespace": "app"},
              "spec": {"podSelector": {}}}
        cov = mod.network_policy_coverage([np])
        self.assertTrue(cov["app"]["defaultDenyIngress"])
        self.assertFalse(cov["app"]["defaultDenyEgress"])

    def test_omitted_policy_types_with_ingress_rules_is_not_default_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "implicit-allow", "namespace": "app"},
              "spec": {"podSelector": {}, "ingress": [{"from": [{"podSelector": {}}]}]}}
        cov = mod.network_policy_coverage([np])
        self.assertFalse(cov["app"]["defaultDenyIngress"])

    def test_omitted_policy_types_with_egress_rules_is_not_default_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "implicit-egress", "namespace": "app"},
              "spec": {"podSelector": {}, "egress": [{"ports": [{"port": 53}]}]}}
        cov = mod.network_policy_coverage([np])
        self.assertFalse(cov["app"]["defaultDenyEgress"])

    def test_explicit_egress_only_type_does_not_deny_ingress(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"name": "egress-only", "namespace": "app"},
              "spec": {"podSelector": {}, "policyTypes": ["Egress"]}}
        cov = mod.network_policy_coverage([np])
        self.assertFalse(cov["app"]["defaultDenyIngress"])
        self.assertTrue(cov["app"]["defaultDenyEgress"])

    def test_namespace_with_no_networkpolicy_is_absent(self) -> None:
        cov = mod.network_policy_coverage([])
        self.assertEqual(cov, {})

    def test_omitted_policy_types_default_to_ingress_only(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"namespace": "app"},
              "spec": {"podSelector": {}}}
        cov = mod.network_policy_coverage([np])["app"]
        self.assertTrue(cov["defaultDenyIngress"])
        self.assertFalse(cov["defaultDenyEgress"])

    def test_omitted_policy_types_with_egress_rule_is_not_egress_deny(self) -> None:
        np = {"kind": "NetworkPolicy", "metadata": {"namespace": "app"},
              "spec": {"podSelector": {}, "egress": [{"to": [{"ipBlock": {"cidr": "10.0.0.0/8"}}]}]}}
        cov = mod.network_policy_coverage([np])["app"]
        self.assertTrue(cov["defaultDenyIngress"])
        self.assertFalse(cov["defaultDenyEgress"])

    def test_new_namespace_gap_fails_ratchet(self) -> None:
        report = {"namespaces": [{"namespace": "new", "podSecurityLabels": {}}],
                  "summary": {"namespacesWithoutDefaultDenyBothList": ["new"]},
                  "workloadsWithGaps": [], "exposures": []}
        errors = mod.gate_errors(report, set(mod.PSA_BASELINE), [])
        self.assertTrue(any("namespace new: missing full default-deny" in error
                            for error in errors))

    def test_workload_in_undeclared_namespace_fails_ratchet(self) -> None:
        resources = [{"kind": "Deployment", "_chart": "t",
                      "metadata": {"name": "app", "namespace": "undeclared"},
                      "spec": {"template": {"spec": {
                          "containers": [container("app", **RESTRICTED)]}}}}]
        report = mod.build_report(resources, {})
        self.assertIn("undeclared", report["summary"]["namespacesWithoutDefaultDenyBothList"])
        errors = mod.gate_errors(report, set(mod.PSA_BASELINE), resources)
        self.assertTrue(any("namespace undeclared: missing full default-deny" in error
                            for error in errors))
        self.assertIn("namespace undeclared: missing restricted PSA labels", errors)

    def test_maven_download_needs_fqdn_allow_after_egress_deny(self) -> None:
        resources = [
            {"kind": "NetworkPolicy", "metadata": {"namespace": "app"},
             "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}},
            {"kind": "Job", "metadata": {"namespace": "app"}, "spec": {"template": {"spec": {
                "containers": [{"command": ["curl https://repo1.maven.org/example.jar"]}]}}}},
        ]
        coverage = mod.network_policy_coverage(resources)
        self.assertIn("repo1.maven.org", mod.egress_preflight_errors(resources, coverage)[0])
        resources.append({"kind": "CiliumNetworkPolicy", "metadata": {"namespace": "app"},
                          "spec": {"egress": [{"toFQDNs": [{"matchName": "repo1.maven.org"}]}]}})
        self.assertEqual(mod.egress_preflight_errors(resources, coverage), [])


class WorkloadFindingsTests(unittest.TestCase):
    def _deployment(self, containers, pod_extra=None):
        spec = {"containers": containers, **(pod_extra or {})}
        return {"kind": "Deployment", "_chart": "t", "metadata": {"name": "d", "namespace": "app"},
                "spec": {"template": {"spec": spec}}}

    def test_fully_restricted_container_has_no_gaps(self) -> None:
        resource = self._deployment([container("c", **RESTRICTED)])
        workloads, review = mod.workload_findings([resource])
        self.assertEqual(review, [])
        self.assertEqual(workloads[0]["gaps"], [])

    def test_net_bind_service_add_is_allowed(self) -> None:
        resource = self._deployment([container("c", **RESTRICTED, add=["NET_BIND_SERVICE"])])
        workloads, _ = mod.workload_findings([resource])
        self.assertEqual(workloads[0]["gaps"], [])

    def test_disallowed_capability_add_fails_ratchet(self) -> None:
        resource = self._deployment([container("c", **RESTRICTED, add=["SYS_ADMIN"])])
        report = mod.build_report([resource], {})
        gap = "container c: capabilities.add includes SYS_ADMIN (only NET_BIND_SERVICE allowed)"
        self.assertIn(gap, report["workloadsWithGaps"][0]["gaps"])
        errors = mod.gate_errors(report, set(mod.PSA_BASELINE), [resource])
        self.assertTrue(any(gap in error and "new runtime gaps" in error for error in errors))

    def test_same_name_different_kind_runtime_gap_fails_ratchet(self) -> None:
        baseline_gap = "container apisix: readOnlyRootFilesystem not true"
        report = {"namespaces": [],
                  "summary": {"namespacesWithoutDefaultDenyBothList": []},
                  "workloadsWithGaps": [
                      {"kind": "Job", "namespace": "platform-system", "name": "apisix",
                       "gaps": ["container apisix: privileged:true"]},
                      {"kind": "Deployment", "namespace": "platform-system", "name": "apisix",
                       "gaps": [baseline_gap]},
                  ], "exposures": []}
        errors = mod.gate_errors(report, set(mod.PSA_BASELINE), [])
        self.assertTrue(any("('Job', 'platform-system', 'apisix')" in error
                            and "privileged:true" in error for error in errors))

    def test_missing_run_as_non_root_is_a_gap(self) -> None:
        params = {**RESTRICTED, "run_as_non_root": None}
        resource = self._deployment([container("c", **params)])
        workloads, _ = mod.workload_findings([resource])
        self.assertTrue(any("runAsNonRoot" in g for g in workloads[0]["gaps"]))

    def test_pod_level_seccomp_satisfies_container(self) -> None:
        params = {k: v for k, v in RESTRICTED.items() if k != "seccomp"}
        resource = self._deployment([container("c", **params)],
                                     pod_extra={"securityContext": {"seccompProfile": {"type": "RuntimeDefault"}}})
        workloads, _ = mod.workload_findings([resource])
        self.assertEqual(workloads[0]["gaps"], [])

    def test_host_network_is_flagged(self) -> None:
        resource = self._deployment([container("c", **RESTRICTED)], pod_extra={"hostNetwork": True})
        workloads, _ = mod.workload_findings([resource])
        self.assertIn("hostNetwork:true", workloads[0]["gaps"])

    def test_host_path_volume_is_flagged(self) -> None:
        resource = self._deployment([container("c", **RESTRICTED)],
                                     pod_extra={"volumes": [{"name": "v", "hostPath": {"path": "/etc"}}]})
        workloads, _ = mod.workload_findings([resource])
        self.assertTrue(any("hostPath" in g for g in workloads[0]["gaps"]))

    def test_operator_managed_kind_goes_to_manual_review_not_gaps(self) -> None:
        resource = {"kind": "Kafka", "_chart": "t", "metadata": {"name": "k", "namespace": "streaming"}}
        workloads, review = mod.workload_findings([resource])
        self.assertEqual(workloads, [])
        self.assertEqual(review[0]["kind"], "Kafka")

    def test_cronjob_pod_spec_is_reached(self) -> None:
        resource = {"kind": "CronJob", "_chart": "t", "metadata": {"name": "cj", "namespace": "app"},
                    "spec": {"jobTemplate": {"spec": {"template": {"spec": {
                        "containers": [container("c", **RESTRICTED)]}}}}}}
        workloads, _ = mod.workload_findings([resource])
        self.assertEqual(workloads[0]["gaps"], [])


class ExposureInventoryTests(unittest.TestCase):
    def test_cluster_ip_service_is_not_reported(self) -> None:
        svc = {"kind": "Service", "_chart": "t", "metadata": {"name": "s", "namespace": "app"},
               "spec": {"type": "ClusterIP"}}
        self.assertEqual(mod.exposure_inventory([svc]), [])

    def test_nodeport_and_loadbalancer_are_reported(self) -> None:
        for svc_type in ("NodePort", "LoadBalancer"):
            svc = {"kind": "Service", "_chart": "t", "metadata": {"name": "s", "namespace": "app"},
                   "spec": {"type": svc_type}}
            result = mod.exposure_inventory([svc])
            self.assertEqual(result[0]["serviceType"], svc_type)

    def test_apisix_route_hosts_are_collected(self) -> None:
        route = {"kind": "ApisixRoute", "_chart": "t", "metadata": {"name": "r", "namespace": "app"},
                 "spec": {"http": [{"match": {"hosts": ["a.example.test"]}}]}}
        result = mod.exposure_inventory([route])
        self.assertEqual(result[0]["hosts"], ["a.example.test"])


class EgressCandidateTests(unittest.TestCase):
    def test_internal_and_short_hosts_are_excluded(self) -> None:
        manifest = ("discovery.uri=http://trino:8080\n"
                    "endpoint: http://openfga.iam.svc.cluster.local:8080\n"
                    "host: https://sso.local.beluga.internal\n")
        self.assertEqual(mod.egress_candidates(manifest), [])

    def test_real_external_host_is_reported(self) -> None:
        manifest = "jar: https://repo1.maven.org/maven2/some.jar\n"
        self.assertEqual(mod.egress_candidates(manifest), ["repo1.maven.org"])

    def test_trailing_ellipsis_truncation_does_not_leak_a_fake_host(self) -> None:
        manifest = "comment: https://sso...를 참고\n"
        self.assertEqual(mod.egress_candidates(manifest), [])

    def test_ipv4_literal_is_excluded(self) -> None:
        manifest = "addr: http://192.168.77.200:9080\n"
        self.assertEqual(mod.egress_candidates(manifest), [])


class StrictGateTests(unittest.TestCase):
    NAMESPACE_ONLY = """
apiVersion: v1
kind: Namespace
metadata: {name: bare}
"""
    COMPLIANT = NAMESPACE_ONLY + """
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: deny-all, namespace: bare}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
"""

    def _run(self, manifest, argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(mod, "render", return_value=manifest), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            return mod.main(argv)

    def test_unbaselined_gap_exits_nonzero_by_default(self) -> None:
        self.assertNotEqual(self._run(self.NAMESPACE_ONLY, []), 0)

    def test_gap_exits_nonzero_with_strict(self) -> None:
        self.assertNotEqual(self._run(self.NAMESPACE_ONLY, ["--strict"]), 0)

    def test_no_gap_exits_zero_with_strict(self) -> None:
        # The synthetic fixture is not the repository render, so repo baselines would read as stale.
        with mock.patch.object(mod, "gate_errors", return_value=[]):
            self.assertEqual(self._run(self.COMPLIANT, ["--strict"]), 0)

    def test_workload_gap_counts_under_strict(self) -> None:
        deployment = self.COMPLIANT + """
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: d, namespace: bare}
spec:
  template:
    spec:
      containers:
        - name: c
"""
        self.assertNotEqual(self._run(deployment, []), 0)
        self.assertNotEqual(self._run(deployment, ["--strict"]), 0)


class DocumentsTests(unittest.TestCase):
    def test_list_kind_is_expanded(self) -> None:
        manifest = """
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Namespace
    metadata: {name: a}
  - apiVersion: v1
    kind: Namespace
    metadata: {name: b}
"""
        docs = mod.documents(manifest, "t")
        self.assertEqual([d["metadata"]["name"] for d in docs], ["a", "b"])

    def test_non_mapping_document_raises(self) -> None:
        with self.assertRaises(ValueError):
            mod.documents("- just\n- a\n- list\n", "t")


if __name__ == "__main__":
    unittest.main(verbosity=2)
