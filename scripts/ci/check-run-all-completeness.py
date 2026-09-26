#!/usr/bin/env python3
"""Ensure the E2E runner covers every numbered shell test exactly once."""
from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_NAME = re.compile(r"[0-9]{2}-.+\.sh")
INVOCATION = re.compile(r'^\s*bash\s+"\$\{SCRIPT_DIR\}/([^"$]+)"\s*(?:#.*)?$')
# Exclusions require an explicit reason; this map is currently intentionally empty.
EXCLUSIONS: dict[str, str] = {}


def check_coverage(tests_dir: Path, runner_path: Path,
                   exclusions: dict[str, str] | None = None) -> None:
    exclusions = EXCLUSIONS if exclusions is None else exclusions
    discovered = {path.name for path in tests_dir.glob("[0-9][0-9]-*.sh") if path.is_file()}
    invoked: list[str] = []
    for number, line in enumerate(runner_path.read_text(encoding="utf-8").splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        if "bash" not in line or "SCRIPT_DIR" not in line:
            continue
        match = INVOCATION.fullmatch(line)
        if not match:
            raise ValueError(f"{runner_path}:{number}: unsupported test invocation")
        name = match.group(1)
        if not TEST_NAME.fullmatch(name):
            raise ValueError(f"{runner_path}:{number}: invalid numbered test name: {name}")
        if name not in discovered:
            raise ValueError(f"{runner_path}:{number}: referenced test does not exist: {name}")
        invoked.append(name)

    if len(invoked) != len(set(invoked)):
        duplicates = sorted(name for name in set(invoked) if invoked.count(name) > 1)
        raise ValueError(f"duplicate test invocations: {', '.join(duplicates)}")
    if invoked != sorted(invoked):
        raise ValueError("test invocations are not in ascending numeric filename order")
    for name, reason in exclusions.items():
        if not TEST_NAME.fullmatch(name) or not reason.strip():
            raise ValueError(f"exclusion must name a numbered test and include a reason: {name}")
        if name not in discovered:
            raise ValueError(f"stale exclusion for missing test: {name}")
        if name in invoked:
            raise ValueError(f"excluded test is also invoked: {name}")
    missing = sorted(discovered - set(invoked) - set(exclusions))
    if missing:
        raise ValueError(f"tests missing from runner and exclusions: {', '.join(missing)}")


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="beluga-run-all-gate-") as temporary:
        root = Path(temporary)
        tests = root / "tests"
        tests.mkdir()
        names = ["01-one.sh", "02-two.sh", "06-six.sh"]
        for name in names:
            (tests / name).touch()
        runner = root / "run-all.sh"

        def write(items: list[str]) -> None:
            runner.write_text("\n".join(
                f'bash "${{SCRIPT_DIR}}/{name}"' for name in items) + "\n", encoding="utf-8")

        write(names)
        check_coverage(tests, runner)
        cases = [
            (["01-one.sh", "06-six.sh"], {}, "missing from runner"),
            (["01-one.sh", "02-two.sh", "02-two.sh", "06-six.sh"], {}, "duplicate"),
            (["02-two.sh", "01-one.sh", "06-six.sh"], {}, "ascending numeric"),
            (["01-one.sh", "02-two.sh", "03-absent.sh", "06-six.sh"], {}, "does not exist"),
            (["01-one.sh", "02-two.sh", "06-six.sh"], {"04-old.sh": "obsolete"}, "stale exclusion"),
            (["01-one.sh", "02-two.sh", "06-six.sh"], {"03-skip.sh": " "}, "include a reason"),
            (["01-one.sh", "02-two.sh", "06-six.sh"], {"02-two.sh": "reserved for separate live check"}, "also invoked"),
        ]
        for items, exclusions, diagnostic in cases:
            write(items)
            try:
                check_coverage(tests, runner, exclusions)
            except ValueError as error:
                if diagnostic not in str(error):
                    raise ValueError(f"self-test expected {diagnostic!r}, got: {error}") from error
            else:
                raise ValueError(f"self-test accepted invalid runner: {items}")
        write(["01-one.sh", "06-six.sh"])
        check_coverage(tests, runner, {"02-two.sh": "reserved for separate live check"})
        runner.write_text('# bash "${SCRIPT_DIR}/02-two.sh"\n', encoding="utf-8")
        try:
            check_coverage(tests, runner)
        except ValueError as error:
            if "missing from runner" not in str(error):
                raise ValueError(f"self-test expected commented test to be missing, got: {error}") from error
        else:
            raise ValueError("self-test counted a commented-out invocation")
    print("Run-all completeness self-tests OK: valid runner accepted; 7 regressions rejected; comment ignored")


def main() -> int:
    try:
        self_test()
        check_coverage(REPO_ROOT / "tests", REPO_ROOT / "tests" / "run-all.sh")
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Run-all completeness FAIL: {error}", file=sys.stderr)
        return 1
    print("Run-all completeness OK: every numbered shell test is invoked exactly once in order")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
