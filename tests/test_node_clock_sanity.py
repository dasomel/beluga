#!/usr/bin/env python3
"""Offline stubs: no request may escape to a real kubectl or curl."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUB = r'''#!/usr/bin/env python3
import datetime, email.utils, json, os, sys, time
args = sys.argv[1:]
if 'config' in args:
    assert '--kubeconfig' in args and '--minify' in args and '--flatten' in args and '--raw' in args
    print('private fixture config')
elif '/healthz' in args:
    assert open(os.environ['KUBECONFIG']).read().strip() == 'private fixture config'
    if os.environ.get('STUB_HEADER', 'present') != 'missing':
        stamp = email.utils.formatdate(time.time() + int(os.environ.get('STUB_SKEW', '0')), usegmt=True)
        if os.environ.get('STUB_HEADER') == 'malformed': stamp = 'not a timestamp'
        print('I1116 round_trippers.go:580]     Date: ' + stamp, file=sys.stderr)
        if os.environ.get('STUB_HEADER') == 'duplicate':
            print('I1116 round_trippers.go:580]     Date: ' + stamp, file=sys.stderr)
    print('sensitive diagnostic fixture', file=sys.stderr)
    sys.exit(int(os.environ.get('STUB_RC', '0')))
elif args[-4:] == ['get', 'nodes', '-o', 'json']:
    stamp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=int(os.environ.get('STUB_HEARTBEAT', '0')))
    print(json.dumps({'items':[{'metadata':{'name':'n1'},'status':{'conditions':[
        {'type':'Ready','lastHeartbeatTime':stamp.isoformat()}]}}]}))
else:
    sys.exit(99)
'''


class NodeClock(unittest.TestCase):
    def probe(self, **extra):
        with tempfile.TemporaryDirectory() as tmp:
            for name, source in [('kubectl', STUB), ('curl', '#!/bin/bash\nexit 99\n')]:
                path = Path(tmp) / name
                path.write_text(source)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': f'{tmp}:{os.environ["PATH"]}',
                   'KUBECONFIG': '/offline/isolated-source', 'NODE_CLOCK_MAX_SKEW_SECONDS': '120', **extra}
            result = subprocess.run(['/bin/bash', str(ROOT / 'tests/32-node-clock-sanity.sh')],
                                    capture_output=True, text=True, env=env, timeout=10)
            self.assertNotIn('sensitive diagnostic fixture', result.stdout + result.stderr)
            self.assertNotIn('private fixture config', result.stdout + result.stderr)
            return result

    def test_small_skew_passes_and_prints_measurement(self):
        result = self.probe(STUB_SKEW='30')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('API clock skew=', result.stdout)
        self.assertIn('PASS node clock sanity', result.stdout)

    def test_large_skew_both_directions_fails(self):
        for skew in ('300', '-300', '3002433095'):
            with self.subTest(skew=skew):
                result = self.probe(STUB_SKEW=skew)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('API clock skew=', result.stdout)

    def test_missing_header_fails_closed(self):
        self.assertEqual(self.probe(STUB_HEADER='missing').returncode, 1)

    def test_invalid_or_ambiguous_header_fails_closed(self):
        for header in ('malformed', 'duplicate'):
            with self.subTest(header=header):
                self.assertEqual(self.probe(STUB_HEADER=header).returncode, 1)

    def test_failed_request_rejects_even_valid_date(self):
        self.assertEqual(self.probe(STUB_RC='1').returncode, 1)

    def test_future_heartbeat_fails(self):
        result = self.probe(STUB_HEARTBEAT='300')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('Ready heartbeat future skew=', result.stdout)

    def test_old_heartbeat_is_not_a_future_clock_failure(self):
        self.assertEqual(self.probe(STUB_HEARTBEAT='-300').returncode, 0)

    def test_threshold_override(self):
        self.assertEqual(self.probe(STUB_SKEW='300', NODE_CLOCK_MAX_SKEW_SECONDS='600').returncode, 0)

    def test_invalid_threshold_fails_before_kubectl(self):
        for value in ('0', '-1', '1.5', 'abc', '', '1e3'):
            with self.subTest(value=value):
                result = self.probe(NODE_CLOCK_MAX_SKEW_SECONDS=value)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn('API clock skew=', result.stdout)
                self.assertIn('must be a positive integer', result.stderr)


if __name__ == '__main__':
    unittest.main()
