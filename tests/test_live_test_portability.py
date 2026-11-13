#!/usr/bin/env python3
"""Offline fail-closed checks for live tests 01 and 03; a stub kubectl on PATH, no cluster access."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The stub answers only the read calls the two scripts make. STUB_* env vars shape its output;
# anything unexpected exits 99 so a new kubectl call cannot silently reach a real cluster.
KUBECTL = r'''#!/usr/bin/env bash
args="$*"
case "${args}" in
  "get nodes --no-headers") printf 'n1 Ready control-plane 1d v1\n' ;;
  *"get pods -n lakehouse"*) echo "lakekeeper-0 1/1 Running 0 1d" ;;
  *"get pods -n storage"*) echo "seaweedfs-0 1/1 Running 0 1d" ;;
  *"get flinkdeployment flink-cluster"*)
    if [[ "${STUB_FLINK_CR}" == "present" ]]; then echo flinkdeployment/flink-cluster
    else echo 'Error from server (NotFound): flinkdeployments.flink.apache.org "flink-cluster" not found' >&2; exit 1; fi ;;
  *"get pods -n streaming -l app=flink-cluster,component=jobmanager --no-headers"*) ;;
  *"get pods -n streaming -l app=flink-cluster,component=jobmanager -o jsonpath"*)
    echo "flink-cluster-abc restarts=43 phase=Running" ;;
  *) echo "unexpected kubectl: ${args}" >&2; exit 99 ;;
esac
'''


def run(script, env_extra):
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / 'kubectl'
        stub.write_text(KUBECTL)
        stub.chmod(0o755)
        env = {k: v for k, v in os.environ.items() if k not in ('EXPECTED_NODES', 'KUBECONFIG')}
        env['PATH'] = f'{tmp}:{env["PATH"]}'
        env.update(env_extra)
        return subprocess.run(['bash', str(ROOT / 'tests' / script)], env=env, cwd=ROOT,
                              capture_output=True, text=True, timeout=60)


class ExpectedNodes(unittest.TestCase):
    def test_default_expects_four_and_fails_on_one_node(self):
        r = run('01-cluster-health.sh', {})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('default', r.stdout + r.stderr)
        self.assertIn('Expected 4 Ready node(s), found 1', r.stdout + r.stderr)

    def test_one_is_accepted_and_reported_as_override(self):
        r = run('01-cluster-health.sh', {'EXPECTED_NODES': '1'})
        out = r.stdout + r.stderr
        self.assertIn('Expecting 1 Ready node(s) (EXPECTED_NODES override)', out)
        self.assertNotIn('1 master + 3 workers', out)
        self.assertIn('All 1 expected cluster node(s) are Ready', out)

    def test_invalid_values_are_rejected(self):
        for bad in ('abc', '0', '-1', '1.5', ''):
            with self.subTest(value=bad):
                r = run('01-cluster-health.sh', {'EXPECTED_NODES': bad})
                self.assertEqual(r.returncode, 1)
                self.assertIn('EXPECTED_NODES must be a positive integer', r.stdout + r.stderr)
                self.assertNotIn('Found', r.stdout + r.stderr)


class FlinkFailsClosed(unittest.TestCase):
    def test_declared_flink_without_running_jobmanager_fails(self):
        r = run('03-stream-iceberg.sh', {'STUB_FLINK_CR': 'present'})
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, out)
        self.assertIn('restarts=43', out)
        self.assertIn('kubectl -n streaming logs flink-cluster-abc --previous', out)
        self.assertNotIn('status verified', out)

    def test_undeclared_flink_still_skips(self):
        r = run('03-stream-iceberg.sh', {'STUB_FLINK_CR': 'absent'})
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertIn('FlinkDeployment 미선언', out)


if __name__ == '__main__':
    unittest.main()
