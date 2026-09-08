#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "agent" / "operations_agent.py"
SPEC = importlib.util.spec_from_file_location("beluga_operations_agent", MODULE_PATH)
assert SPEC and SPEC.loader
ops = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ops
SPEC.loader.exec_module(ops)


class OperationsAgentSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = ops.load_policy(ROOT / "configs" / "operations-agent-policy.json")

    def resolved(self, tool: str = "cluster.pods"):
        return ops.resolve_invocation(self.policy, tool, "test-correlation")

    def test_canonical_digest_is_deterministic(self) -> None:
        first = self.resolved()
        second = self.resolved()
        self.assertEqual(first.invocation_digest, second.invocation_digest)
        self.assertTrue(first.invocation_digest.startswith("sha256:"))

    def test_read_only_tools_are_allowlisted(self) -> None:
        for tool in ("cluster.nodes", "cluster.pods", "cluster.events", "gitops.applications"):
            decision = ops.authorize(self.policy, self.resolved(tool))
            self.assertEqual(decision.decision, "allow", tool)
            self.assertEqual(decision.risk_class, "read-only-diagnostic")
            self.assertFalse(decision.approval_required)

    def test_mutation_egress_and_privileged_tools_fail_closed(self) -> None:
        for tool in ("data.mutate", "external.http", "platform.privileged"):
            decision = ops.authorize(self.policy, self.resolved(tool))
            self.assertEqual(decision.decision, "deny", tool)
            self.assertEqual(decision.reason, "non-read-only-tool-disabled-in-poc")
            self.assertTrue(decision.approval_required)

    def test_unknown_tool_is_not_resolved(self) -> None:
        with self.assertRaisesRegex(ops.AgentPolicyError, "unknown-tool"):
            self.resolved("shell.exec")

    def test_denied_tool_never_reaches_runner(self) -> None:
        invocation = self.resolved("data.mutate")
        decision = ops.authorize(self.policy, invocation)
        runner = Mock()
        evidence = ops.execute_read_only(invocation, decision, Path("/does/not/matter"), runner=runner)
        runner.assert_not_called()
        self.assertEqual(evidence.execution_status, "denied-before-executor")
        self.assertEqual(evidence.authorization_decision, "deny")

    def test_shared_default_kubeconfig_is_refused(self) -> None:
        shared = (Path.home() / ".kube" / "config").resolve()
        if not shared.is_file():
            self.skipTest("runner has no ~/.kube/config")
        with self.assertRaisesRegex(ops.AgentPolicyError, "shared-kubeconfig-refused"):
            ops.validate_kubeconfig(shared)

    def test_read_only_execution_uses_explicit_kubeconfig_without_shell(self) -> None:
        invocation = self.resolved("cluster.pods")
        decision = ops.authorize(self.policy, invocation)
        pod_payload = json.dumps({"items": []})

        with tempfile.TemporaryDirectory() as tmp:
            kubeconfig = Path(tmp) / "beluga.yaml"
            kubeconfig.write_text("apiVersion: v1\nkind: Config\n", encoding="utf-8")
            expected_kubeconfig = str(kubeconfig.resolve())
            runner = Mock(
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout=pod_payload, stderr=""
                )
            )
            evidence = ops.execute_read_only(invocation, decision, kubeconfig, runner=runner)

        runner.assert_called_once()
        args, kwargs = runner.call_args
        command = args[0]
        self.assertIsInstance(command, list)
        self.assertEqual(command[0], "kubectl")
        self.assertIn("--context", command)
        self.assertIn("beluga", command)
        self.assertEqual(kwargs["env"]["KUBECONFIG"], expected_kubeconfig)
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(evidence.execution_status, "succeeded")
        self.assertEqual(evidence.findings, {"pods": 0, "unhealthy": 0, "reasons": {}})
        self.assertIsNotNone(evidence.stdout_sha256)
        self.assertFalse(hasattr(evidence, "stdout"))

    def test_pod_health_finds_crashloop_and_unschedulable(self) -> None:
        payload = {
            "items": [
                {
                    "status": {
                        "phase": "Running",
                        "containerStatuses": [
                            {"state": {"waiting": {"reason": "CrashLoopBackOff"}}}
                        ],
                    }
                },
                {
                    "status": {
                        "phase": "Pending",
                        "conditions": [
                            {
                                "type": "PodScheduled",
                                "status": "False",
                                "reason": "Unschedulable",
                            }
                        ],
                    }
                },
                {"status": {"phase": "Running", "containerStatuses": []}},
            ]
        }
        findings = ops.pod_findings(payload)
        self.assertEqual(findings["pods"], 3)
        self.assertEqual(findings["unhealthy"], 2)
        self.assertEqual(findings["reasons"]["CrashLoopBackOff"], 1)
        self.assertEqual(findings["reasons"]["Unschedulable"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
