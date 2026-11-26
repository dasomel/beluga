#!/usr/bin/env python3
"""D-WAIT-1: bootstrap readiness waits must fail closed (offline, no cluster).

1. Static: no `kubectl wait` / `kubectl rollout status` under scripts/ or csp/ may swallow
   its exit code (`|| true`, `|| :`, `|| echo ...`, `|| log_warn ...`) unless the line
   above carries a `# wait-best-effort: <reason>` comment.
2. Static: the Jobs whose timeouts `make up` once ignored are waited on with
   wait_job_complete and recorded as failures.
3. Behaviour: scripts/common/wait.sh against a stub kubectl — Complete passes, Failed
   and timeouts (including a missing Job) return non-zero and name the Job, its
   namespace and the logs command.
"""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WAIT_SH = ROOT / "scripts" / "common" / "wait.sh"
LOGGING_SH = ROOT / "scripts" / "common" / "logging.sh"
BOOTSTRAP = ROOT / "scripts" / "gitops" / "01-argocd-bootstrap.sh"

WAIT_CMD = re.compile(r"\bkubectl\b.*\b(wait|rollout\s+status)\b|\b(wait_job_complete|wait_rollout)\b")
SWALLOW = re.compile(r"\|\|\s*(true|:|echo\b|log_warn\b|log_info\b)")
MARKER = "# wait-best-effort:"

KUBECTL_STUB = r'''#!/usr/bin/env bash
case "${STUB_JOB:-missing}" in
  complete) printf 'SuccessCriteriaMet Complete ' ;;
  failed) printf 'FailureTarget Failed ' ;;
  running) printf '' ;;
  missing) echo 'Error from server (NotFound): jobs.batch "x" not found' >&2; exit 1 ;;
esac
'''


def swallowed_waits(text):
    # Join backslash continuations so `cmd \\\n  || true` is seen as one logical line;
    # report the first physical line of each logical line.
    lines, starts, buf, start = [], [], "", None
    for i, raw in enumerate(text.splitlines()):
        if start is None:
            start = i
        if raw.rstrip().endswith("\\"):
            buf += raw.rstrip()[:-1] + " "
            continue
        lines.append(buf + raw); starts.append(start); buf, start = "", None
    if buf:
        lines.append(buf); starts.append(start)
    found = []
    for i, line in enumerate(lines):
        code = line.split("#", 1)[0] if not line.lstrip().startswith("#") else ""
        if WAIT_CMD.search(code) and SWALLOW.search(code):
            prev = lines[i - 1].strip() if i else ""
            if not prev.startswith(MARKER):
                found.append((starts[i] + 1, line.strip()))
    return found


class StaticWaitTest(unittest.TestCase):
    def test_no_swallowed_waits(self):
        offenders = []
        for base in ("scripts", "csp"):
            for path in sorted((ROOT / base).rglob("*.sh")):
                for lineno, line in swallowed_waits(path.read_text()):
                    offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {line}")
        self.assertEqual(offenders, [], "swallowed readiness wait(s) — fail closed or "
                         f"document with '{MARKER} <reason>' on the line above")

    def test_detector_negative_fixtures(self):
        for bad in (
            "kubectl -n iam wait --for=condition=complete job/x --timeout=180s || true",
            "kubectl rollout status deployment/y -n z --timeout=180s || :",
            "kubectl -n a wait pod/b || echo WARN",
            "kubectl -n a rollout status ds/b || log_warn 'not ready'",
            "wait_job_complete iam x 180 || true",
            "wait_rollout argocd deployment/argocd-server 180 || :",
            "kubectl -n a wait pod/b \\\n  --timeout=60s || true",
        ):
            self.assertEqual(len(swallowed_waits(bad)), 1, bad)
        self.assertEqual(swallowed_waits(f"{MARKER} checked below\nkubectl wait pod/x || true"), [])
        self.assertEqual(swallowed_waits("kubectl wait pod/x || exit 1"), [])

    def test_bootstrap_jobs_recorded(self):
        text = BOOTSTRAP.read_text()
        for ns, job in (("iam", "keycloak-ldap-federation"), ("iam", "keycloak-group-mapper"),
                        ("database", "shop-seed")):
            self.assertRegex(text, rf"wait_job_complete {ns} {job} \d+ \\\n\s*\|\| BOOTSTRAP_FAILURES\+=")
        self.assertIn('if (( ${#BOOTSTRAP_FAILURES[@]} > 0 )); then', text)
        # The failure gate must come before the success line.
        self.assertLess(text.index("BOOTSTRAP_FAILURES[@]} > 0"),
                        text.index('log_success "GitOps applications and data platform stack applied'))


def run_wait(stub_job, timeout="0"):
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "kubectl"
        stub.write_text(KUBECTL_STUB)
        stub.chmod(0o755)
        env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}", "STUB_JOB": stub_job,
               "BELUGA_WAIT_POLL_INTERVAL": "0"}
        script = (f'set -euo pipefail; source "{LOGGING_SH}"; source "{WAIT_SH}"; '
                  f'wait_job_complete iam keycloak-ldap-federation {timeout}')
        return subprocess.run(["bash", "-c", script], env=env, capture_output=True,
                              text=True, timeout=30)


class WaitJobBehaviourTest(unittest.TestCase):
    def test_complete_passes(self):
        r = run_wait("complete")
        self.assertEqual(r.returncode, 0, r.stderr)

    def assert_fails_with_hint(self, r, reason):
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(reason, r.stderr)
        self.assertIn("iam/keycloak-ldap-federation", r.stderr)
        self.assertIn("kubectl -n iam logs job/keycloak-ldap-federation", r.stderr)

    def test_failed_job_fails_fast(self):
        # A Failed Job must not wait out the timeout: 600s here would hang the test.
        self.assert_fails_with_hint(run_wait("failed", timeout="600"), "failed")

    def test_timeout_fails(self):
        self.assert_fails_with_hint(run_wait("running"), "did not complete within 0s")

    def test_missing_job_fails_with_last_error(self):
        r = run_wait("missing")
        self.assert_fails_with_hint(r, "did not complete within 0s")
        self.assertIn("NotFound", r.stderr)


if __name__ == "__main__":
    unittest.main()
