#!/usr/bin/env python3
"""Offline fail-closed checks for live tests 01, 03, 10 and 31."""
import datetime
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]

# The stub answers only the calls the two scripts make, including the disposable REST probe.
# STUB_* env vars shape its output;
# anything unexpected exits 99 so a new kubectl call cannot silently reach a real cluster.
KUBECTL = r'''#!/usr/bin/env bash
args="$*"
case "${args}" in
  "get nodes --no-headers") printf 'n1 Ready control-plane 1d v1\n' ;;
  *"get pods -n lakehouse"*) echo "lakekeeper-0 1/1 Running 0 1d" ;;
  *"get pods -n storage"*) echo "seaweedfs-0 1/1 Running 0 1d" ;;
  "get crd flinkdeployments.flink.apache.org --ignore-not-found -o name")
    case "${STUB_FLINK_CRD:-present}" in
      present) echo customresourcedefinition.apiextensions.k8s.io/flinkdeployments.flink.apache.org ;;
      absent) ;;
      *) echo "${STUB_FLINK_CRD}" >&2; exit 1 ;;
    esac ;;
  *"get flinkdeployment flink-cluster"*)
    if [[ "${STUB_FLINK_CR}" == "present" ]]; then echo flinkdeployment/flink-cluster
    else echo "${STUB_FLINK_ERROR:-Error from server (NotFound): flinkdeployment not found}" >&2; exit 1; fi ;;
  *"get pods -n streaming -l app=flink-cluster,component=jobmanager --no-headers"*)
    if [[ "${STUB_FLINK_JM:-}" == "running" ]]; then echo "flink-cluster-abc 1/1 Running 0 1d"; fi ;;
  *"get pods -n streaming -l app=flink-cluster,component=jobmanager -o jsonpath"*)
    echo "flink-cluster-abc restarts=43 phase=Running" ;;
  "-n streaming run flink-jobs-overview-probe-"*) ;;
  "-n streaming get pod flink-jobs-overview-probe-"*) echo "${STUB_PROBE_PHASE:-Succeeded}" ;;
  "-n streaming logs flink-jobs-overview-probe-"*)
    if [[ "${STUB_PROBE_LOG_FAILURE:-}" == "1" ]]; then exit 1; fi
    printf '%s' "${STUB_PROBE_OUT}" ;;
  "-n streaming delete pod flink-jobs-overview-probe-"*) ;;
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
        return subprocess.run(['/bin/bash', str(ROOT / 'tests' / script)], env=env, cwd=ROOT,
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

    def probe(self, output, **extra):
        return run('03-stream-iceberg.sh', {
            'STUB_FLINK_CR': 'present', 'STUB_FLINK_JM': 'running',
            'STUB_PROBE_OUT': output, **extra,
        })

    def test_declared_flink_with_zero_running_jobs_fails(self):
        r = self.probe('{"jobs":[]}\n200')
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, out)
        self.assertIn('RUNNING 잡 0개', out)
        self.assertIn('kubectl -n streaming logs flink-jobs-overview-probe-', out)
        self.assertNotIn('status verified', out)

    def test_declared_flink_probe_failure_fails(self):
        r = self.probe('', STUB_PROBE_PHASE='Failed', STUB_PROBE_LOG_FAILURE='1')
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, out)
        self.assertIn('phase=Failed', out)
        self.assertIn('kubectl -n streaming logs flink-jobs-overview-probe-', out)
        self.assertNotIn('status verified', out)

    def test_declared_flink_empty_or_non_200_probe_fails(self):
        for output in ('', '{"error":"unavailable"}\n503'):
            with self.subTest(output=output):
                r = self.probe(output)
                out = r.stdout + r.stderr
                self.assertEqual(r.returncode, 1, out)
                self.assertIn('Flink REST(jobs/overview) 확인 실패', out)
                self.assertNotIn('status verified', out)

    def test_declared_flink_running_job_passes(self):
        r = self.probe('{"jobs":[{"name":"stream","state":"RUNNING"}]}\n200')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('status verified', r.stdout + r.stderr)

    def test_declared_flink_missing_namespace_or_cr_fails(self):
        for error in ('Error from server (NotFound): namespaces "streaming" not found',
                      'Error from server (NotFound): flinkdeployment "flink-cluster" not found'):
            with self.subTest(error=error):
                r = run('03-stream-iceberg.sh', {'STUB_FLINK_CR': 'absent',
                                              'STUB_FLINK_ERROR': error})
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn(error, r.stdout + r.stderr)
                self.assertNotIn('status verified', r.stdout + r.stderr)

    def test_crd_lookup_errors_fail(self):
        for error in ('Error from server (Forbidden): customresourcedefinitions forbidden',
                      'Unable to connect to the server: timeout'):
            with self.subTest(error=error):
                r = run('03-stream-iceberg.sh', {'STUB_FLINK_CRD': error,
                                              'STUB_FLINK_CR': 'absent'})
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn(error, r.stdout + r.stderr)
                self.assertNotIn('status verified', r.stdout + r.stderr)

    def test_undeclared_flink_still_skips(self):
        r = run('03-stream-iceberg.sh', {'STUB_FLINK_CRD': 'absent'})
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 0, out)
        self.assertIn('FlinkDeployment 미선언', out)


class TlsVerifyVerdict(unittest.TestCase):
    def verdict(self, output):
        # Source only the marked pure function; top-level live probes never execute.
        source = (ROOT / 'tests/10-tls-identity-boundary.sh').read_text()
        function = source.split('# BEGIN TLS_VERIFY_VERDICT\n', 1)[1].split(
            '# END TLS_VERIFY_VERDICT', 1)[0]
        r = subprocess.run(['/bin/bash', '-eu', '-o', 'pipefail', '-c',
                            function + '\ntls_verify_verdict "$1"', 'tls-verdict', output],
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_openssl_success(self):
        self.assertEqual(self.verdict('CONNECTED(00000003)\ndepth=1 CN=Beluga CA\n'
                                      'verify return:1\nVerify return code: 0 (ok)\n'), 'ok')

    def test_openssl_unknown_issuer(self):
        self.assertEqual(self.verdict('verify error:num=20:unable to get local issuer certificate\n'
                                      'Verify return code: 20 (unable to get local issuer certificate)\n'),
                         'untrusted')

    def test_libressl_success(self):
        self.assertEqual(self.verdict('CONNECTED(00000003)\nverify return:1\n'
                                      'Verify return code: 0 (ok)\nread:errno=0\n'), 'ok')

    def test_libressl_unknown_issuer_despite_return_code_zero(self):
        self.assertEqual(self.verdict('verify error:num=20:unable to get local issuer certificate\n'
                                      'Verify return code: 0 (ok)\n'), 'untrusted')

    def test_empty_output_is_indeterminate(self):
        self.assertEqual(self.verdict(''), 'indeterminate')

    def test_connect_error_is_indeterminate(self):
        self.assertEqual(self.verdict('connect: Connection refused\nconnect:errno=61\n'),
                         'indeterminate')

    def test_no_certificate_despite_return_code_zero_is_indeterminate(self):
        self.assertEqual(self.verdict('no peer certificate available\n'
                                      'Verify return code: 0 (ok)\n'), 'indeterminate')

    def test_chain_error_with_no_retained_peer_is_untrusted(self):
        self.assertEqual(self.verdict('verify error:num=20:unable to get local issuer certificate\n'
                                      'no peer certificate available\n'), 'untrusted')

    def test_other_chain_errors_are_indeterminate(self):
        self.assertEqual(self.verdict('verify error:num=10:certificate has expired\n'
                                      'Verify return code: 0 (ok)\n'), 'indeterminate')

    def test_self_signed_and_unverifiable_chains_are_untrusted(self):
        for code in (18, 19, 21):
            with self.subTest(code=code):
                self.assertEqual(self.verdict(f'verify error:num={code}:chain error\n'), 'untrusted')


class AlertTimestamp(unittest.TestCase):
    def test_go_fraction_lengths_on_python310(self):
        # Enforce 3.10's accepted lengths even when this test runs on newer Python.
        class Python310Datetime(datetime.datetime):
            @classmethod
            def fromisoformat(cls, value):
                self.assertNotIn('Z', value)
                fraction = re.search(r"\.(\d+)", value)
                if fraction:
                    self.assertEqual(len(fraction[1]), 6)
                return super().fromisoformat(value)

        source = (ROOT / 'tests/31-alerting-pipeline.sh').read_text()
        block = textwrap.dedent(source.split('# BEGIN ALERT_TIMESTAMP\n', 1)[1].split(
            '# END ALERT_TIMESTAMP', 1)[0])
        for digits in ('', '1', '12', '123', '12345', '123456', '123456789'):
            for zone in ('Z', '+00:00'):
                with self.subTest(digits=digits, zone=zone):
                    timestamp = '2026-11-15T12:34:56' + ('.' + digits if digits else '') + zone
                    scope = {'datetime': SimpleNamespace(datetime=Python310Datetime),
                             're': re, 'rule': {'lastEvaluation': timestamp}}
                    exec(block, scope)
                    self.assertEqual(scope['evaluated'], datetime.datetime(
                        2026, 11, 15, 12, 34, 56, int((digits + '000000')[:6]),
                        tzinfo=datetime.timezone.utc))


class TlsStepThree(unittest.TestCase):
    def step(self, positive='ok', negative='untrusted', bundle='pem', x509='0'):
        source = (ROOT / 'tests/10-tls-identity-boundary.sh').read_text()
        block = source.split('# BEGIN TLS_PUBLIC_CA_CHECK\n', 1)[1].split(
            '# END TLS_PUBLIC_CA_CHECK', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            public = directory / 'public.pem'
            public.write_text('-----BEGIN CERTIFICATE-----\nfixture\n'
                              if bundle == 'pem' else 'not a PEM file\n')
            internal = directory / 'internal.pem'
            internal.write_text('internal fixture\n')
            trace = directory / 'calls'
            stub = directory / 'openssl'
            stub.write_text(r'''#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_TRACE}"
case "$*" in
  "x509 -in ${PUBLIC_CA_BUNDLE} -noout") exit "${STUB_X509}" ;;
  "s_client -connect sso.offline.invalid:443 -servername sso.offline.invalid -CAfile ${CA_CRT_FILE} -verify_return_error") verdict="${STUB_POSITIVE}" ;;
  "s_client -connect sso.offline.invalid:443 -servername sso.offline.invalid -CAfile ${PUBLIC_CA_BUNDLE} -verify_return_error") verdict="${STUB_NEGATIVE}" ;;
  *) exit 99 ;;
esac
case "${verdict}" in
  ok) echo 'Verify return code: 0 (ok)' ;;
  untrusted) echo 'verify error:num=20:unable to get local issuer certificate' ;;
  expired) echo 'verify error:num=10:certificate has expired' ;;
  disconnected) echo 'connect: Connection refused' ;;
  empty) ;;
  *) exit 99 ;;
esac
# LibreSSL may exit 1 even for a successfully verified chain.
exit 1
''')
            stub.chmod(0o755)
            env = {**os.environ, 'PATH': f'{tmp}:{os.environ["PATH"]}',
                   'BASE_DOMAIN': 'offline.invalid', 'CA_CRT_FILE': str(internal),
                   'PUBLIC_CA_BUNDLE': str(public), 'STUB_TRACE': str(trace),
                   'STUB_POSITIVE': positive, 'STUB_NEGATIVE': negative, 'STUB_X509': x509}
            logging = 'source "${1}/scripts/common/logging.sh"\n'
            result = subprocess.run(['/bin/bash', '-euo', 'pipefail', '-c', logging + block,
                                     'tls-step-three', str(ROOT)], env=env, cwd=ROOT,
                                    capture_output=True, text=True, timeout=10)
            return result, trace.read_text() if trace.exists() else ''

    def test_positive_and_negative_controls_pass(self):
        r, calls = self.step()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(calls.count('x509 '), 1)
        self.assertEqual(calls.count('s_client '), 2)
        self.assertIn('internal.pem -verify_return_error', calls)
        self.assertIn('public.pem -verify_return_error', calls)

    def test_invalid_public_bundle_fails_before_chain_checks(self):
        for bundle, x509 in (('non-pem', '0'), ('pem', '1')):
            with self.subTest(bundle=bundle, x509=x509):
                r, calls = self.step(bundle=bundle, x509=x509)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertIn('PEM', r.stdout + r.stderr)
                self.assertNotIn('s_client ', calls)

    def test_positive_control_failure_rejects_negative_result(self):
        r, calls = self.step(positive='untrusted')
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('양성 대조 실패', r.stdout + r.stderr)
        self.assertEqual(calls.count('s_client '), 1)

    def test_only_untrusted_negative_verdict_passes(self):
        for verdict in ('ok', 'expired', 'disconnected', 'empty'):
            with self.subTest(verdict=verdict):
                r, calls = self.step(negative=verdict)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertEqual(calls.count('s_client '), 2)
                self.assertIn('공개 루트 번들', r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main()
