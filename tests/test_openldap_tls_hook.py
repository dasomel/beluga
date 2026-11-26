#!/usr/bin/env python3
"""Offline contract for the openldap postStart TLS-convergence hook.

Renders the beluga-platform chart, extracts the hook script and runs it with
stubbed ldapsearch/ldapmodify/sleep. No cluster, no slapd: this proves the
hook's control flow only, not that ldapium accepts the modify.

ldapium 0.2.0 facts this encodes (image/entrypoint.sh at tag v0.2.0):
first-boot bootstrap writes olcTLS* itself and only ever opens run/ldapi-setup;
run/ldapi exists only after `exec slapd`; completion = slapd.d/.bootstrapped.
A failing postStart during bootstrap kills the container and wedges the PVC.
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MARKER = "/etc/openldap/slapd.d/.bootstrapped"


def openldap_container():
    out = subprocess.run(["helm", "template", str(ROOT / "gitops/charts/beluga-platform")],
                         check=True, capture_output=True, text=True).stdout
    for doc in yaml.safe_load_all(out):
        if doc and doc.get("kind") == "Deployment" and doc["metadata"]["name"] == "openldap":
            return doc["spec"]["template"]["spec"]["containers"][0]
    raise AssertionError("openldap Deployment not rendered")


class OpenldapTlsHook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = openldap_container()
        cmd = cls.container["lifecycle"]["postStart"]["exec"]["command"]
        assert cmd[:2] == ["/bin/sh", "-c"], cmd
        cls.script = cmd[2]

    def run_hook(self, marker, ldapsearch_rc, ldapmodify_rc=0):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            calls = tmp / "calls"
            for name, rc in [("ldapsearch", ldapsearch_rc), ("ldapmodify", ldapmodify_rc), ("sleep", 0)]:
                stub = tmp / name
                stub.write_text(f'#!/bin/sh\necho {name} >> "{calls}"\nexit {rc}\n')
                stub.chmod(0o755)
            marker_path = tmp / ".bootstrapped"
            if marker:
                marker_path.write_text("2026-11-27T00:00:00Z\n")
            script = self.script.replace(MARKER, str(marker_path))
            env = {"PATH": f"{tmp}:/usr/bin:/bin", "TMPDIR": str(tmp), "LDAP_TLS_ENABLED": "true",
                   "LDAP_ADMIN_PASSWORD": "fixture", "LDAP_TLS_CERT_FILE": "/c", "LDAP_TLS_KEY_FILE": "/k",
                   "LDAP_TLS_CA_FILE": "/ca"}
            res = subprocess.run(["/bin/sh", "-c", script], env=env, capture_output=True,
                                 text=True, timeout=30)
            log = calls.read_text().split() if calls.exists() else []
            return res, log

    def test_syntax_and_marker_path(self):
        subprocess.run(["/bin/sh", "-n", "-c", self.script], check=True)
        self.assertIn(MARKER, self.script)

    def test_first_boot_never_fails_or_touches_ldapi(self):
        # Bootstrap in progress: ldapi is absent, so the old hook timed out and killed it.
        res, log = self.run_hook(marker=False, ldapsearch_rc=255)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(log, [])

    def test_bootstrapped_pvc_converges(self):
        res, log = self.run_hook(marker=True, ldapsearch_rc=0)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(log, ["ldapsearch", "ldapmodify"])

    def test_bootstrapped_pvc_fails_closed_after_probe_budget(self):
        res, log = self.run_hook(marker=True, ldapsearch_rc=255)
        self.assertEqual(res.returncode, 1)
        self.assertIn("failing closed", res.stderr)
        live = self.container["livenessProbe"]
        budget = live["initialDelaySeconds"] + live["periodSeconds"] * live["failureThreshold"]
        self.assertIn(f"TLS_CONVERGE_WAIT_S={budget}\n", self.script)
        self.assertEqual(log.count("ldapsearch"), budget // 2)
        self.assertNotIn("ldapmodify", log)

    def test_bootstrapped_pvc_fails_closed_on_modify_error(self):
        res, _ = self.run_hook(marker=True, ldapsearch_rc=0, ldapmodify_rc=1)
        self.assertEqual(res.returncode, 1)


if __name__ == "__main__":
    unittest.main()
