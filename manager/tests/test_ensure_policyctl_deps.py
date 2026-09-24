from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

# Regression test for dasomel/openforge#54: a fresh clone of this repository,
# used as a sibling checkout by another repo's tooling (dasomel/beluga's
# tests/14-policy-compiler-seam.sh), invokes `npm run policyctl` without ever
# running `npm install`/`npm ci` here first. tsx then fails deep inside
# Node's ESM loader with a cryptic `ERR_MODULE_NOT_FOUND`. This bootstraps
# dependencies from the lockfile first (scripts/ensure-policyctl-deps.sh) so
# `npm run policyctl` self-heals instead of failing that way.
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ensure-policyctl-deps.sh"


class EnsurePolicyctlDepsTests(unittest.TestCase):
    def _run_against_fake_repo(self, *, tsx_already_installed: bool):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            fake_repo = tmp_path / "repo"
            fake_scripts = fake_repo / "scripts"
            fake_scripts.mkdir(parents=True)
            # Copy (not symlink) so the script's own `${SCRIPT_DIR}/..`
            # resolution points at the isolated fake repo, never the real one.
            shutil.copy(SCRIPT, fake_scripts / SCRIPT.name)

            node_modules = fake_repo / "node_modules"
            if tsx_already_installed:
                (node_modules / "tsx").mkdir(parents=True)

            marker = tmp_path / "npm-ci-invoked"
            fake_bin = tmp_path / "bin"
            fake_bin.mkdir()
            fake_npm = fake_bin / "npm"
            fake_npm.write_text(
                "#!/usr/bin/env bash\n"
                f'echo "$@" >> "{marker}"\n'
                f'mkdir -p "{node_modules}/tsx"\n'
            )
            fake_npm.chmod(fake_npm.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

            env = dict(os.environ)
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                ["bash", str(fake_scripts / SCRIPT.name)],
                cwd=fake_repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            return result, marker.exists(), (node_modules / "tsx").is_dir()

    def test_bootstraps_dependencies_when_tsx_is_missing(self):
        result, npm_ci_invoked, tsx_present_after = self._run_against_fake_repo(
            tsx_already_installed=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(npm_ci_invoked, "expected `npm ci` to run when tsx is missing")
        self.assertTrue(tsx_present_after)

    def test_skips_install_when_tsx_already_present(self):
        result, npm_ci_invoked, tsx_present_after = self._run_against_fake_repo(
            tsx_already_installed=True
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertFalse(npm_ci_invoked, "expected `npm ci` to be skipped when tsx is installed")
        self.assertTrue(tsx_present_after)


if __name__ == "__main__":
    unittest.main()
