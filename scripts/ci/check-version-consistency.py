#!/usr/bin/env python3
"""Fail closed when a VERSIONS.md image is absent or drifts in GitOps renders."""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
IMAGE_ROW_RE = re.compile(r"`([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)`")
IMAGE_LINE_RE = re.compile(r"\bimage:\s*\"?([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)\"?")

# These tools/components are installed outside the two local Helm renders. Keep each
# exception specific: if one enters a render or disappears from VERSIONS.md, fail.
ALLOWLIST = {
    "ghcr.io/dasomel/ldapium-ui": "Optional LDAP UI is documented but its deployment is not enabled in Beluga manifests.",
    "quay.io/strimzi/operator": "Strimzi operator is installed from upstream release YAML, outside these charts.",
    "ghcr.io/cloudnative-pg/cloudnative-pg": "CNPG operator is installed from upstream release YAML, outside these charts.",
    "apache/flink-kubernetes-operator": "Flink operator is installed from its upstream Helm chart, outside these charts.",
}


def parse_versions_text(text: str) -> dict[str, tuple[str, str]]:
    expected = {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        match = IMAGE_ROW_RE.search(line)
        if match:
            component = line.split("|", 2)[1].strip()
            expected[match.group(1)] = (match.group(2), component)
    return expected


def rendered_manifest_text() -> str:
    parts = []
    combos = (
        ("default", []),
        ("workers+openmetadata", ["--set", "trino.workerEnabled=true", "--set", "openmetadata.enabled=true"]),
    )
    for combo, values in combos:
        for chart in ("beluga-platform", "beluga-data"):
            result = subprocess.run(
                ["helm", "template", chart, str(REPO_ROOT / "gitops" / "charts" / chart),
                 "--namespace", "storage" if chart == "beluga-data" else "platform-system", *values],
                capture_output=True, text=True, check=True,
            )
            parts.append(f"# {chart}/{combo}\n{result.stdout}")
    for directory in ("gitops/apps", "gitops/resources"):
        path = REPO_ROOT / directory
        if path.is_dir():
            for manifest in sorted(path.glob("*.yaml")):
                parts.append(f"# {manifest.relative_to(REPO_ROOT)}\n{manifest.read_text(encoding='utf-8')}")
    return "\n".join(parts)


def inspect(expected: dict[str, tuple[str, str]], manifest_text: str,
            allowlist: dict[str, str]) -> tuple[list[tuple[str, str, str, str]], list[str]]:
    found: dict[str, dict[str, set[str]]] = {}
    current_location = "rendered manifests"
    for line in manifest_text.splitlines():
        if line.startswith("# "):
            current_location = line[2:]
        for repo, tag in IMAGE_LINE_RE.findall(line):
            found.setdefault(repo, {}).setdefault(tag, set()).add(current_location)

    errors = []
    for repo in sorted(allowlist):
        if repo not in expected:
            errors.append(f"allowlisted image {repo} is absent from VERSIONS.md")
        if repo in found:
            errors.append(f"allowlisted image {repo} appears in rendered output (stale allowlist)")

    rows = []
    for repo, (version, component) in sorted(expected.items()):
        if repo in allowlist:
            rows.append((component, version, allowlist[repo], "ALLOWLISTED"))
        elif repo not in found:
            rows.append((component, version, "MISSING", "FAIL"))
            errors.append(f"{repo} ({component}) is missing from rendered output")
        else:
            versions = found[repo]
            where = "; ".join(sorted({loc for locations in versions.values() for loc in locations}))
            if set(versions) != {version}:
                rows.append((component, version, f"{where}: {', '.join(sorted(versions))}", "MISMATCH"))
                errors.append(f"{repo} expected {version}, found {', '.join(sorted(versions))}")
            else:
                rows.append((component, version, where, "OK"))
    return rows, errors


def self_test() -> None:
    expected = {"example/image": ("1.2", "Example")}
    cases = [
        ("matched", "# chart/default\nimage: example/image:1.2\n", {}, False),
        ("missing", "", {}, True),
        ("allowlisted", "", {"example/image": "host tool outside renders"}, False),
        ("stale allowlist", "# chart/default\nimage: example/image:1.2\n",
         {"example/image": "host tool outside renders"}, True),
        ("version mismatch", "# chart/default\nimage: example/image:2.0\n", {}, True),
        ("allowlist absent from VERSIONS", "", {"other/image": "removed component"}, True),
    ]
    for name, manifests, allowlist, should_fail in cases:
        _, errors = inspect(expected, manifests, allowlist)
        if bool(errors) != should_fail:
            raise AssertionError(f"{name}: expected fail={should_fail}, errors={errors}")
    print("Self-tests passed (matched, missing, allowlisted, stale allowlist, mismatch, removed allowlist).")


def main() -> int:
    try:
        self_test()
    except AssertionError as error:
        print(f"Self-test FAIL: {error}", file=sys.stderr)
        return 1
    if "--self-test" in sys.argv:
        return 0
    expected = parse_versions_text(VERSIONS_MD.read_text(encoding="utf-8"))
    manifest_text = rendered_manifest_text()
    rows, errors = inspect(expected, manifest_text, ALLOWLIST)
    print("=== VERSIONS.md vs rendered-manifest image tag check ===")
    print("Component | Expected | Where found / allowlisted reason | Status")
    print("-" * 120)
    for component, version, where, status in rows:
        print(f"{component} | {version} | {where} | {status}")
    if errors:
        print("\nFAIL:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"\nAll {len(rows)} VERSIONS.md image entries are rendered or explicitly allowlisted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
