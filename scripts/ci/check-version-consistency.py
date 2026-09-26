#!/usr/bin/env python3
"""Fail closed when VERSIONS.md and GitOps renders contain image drift."""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
IMAGE_ROW_RE = re.compile(r"`([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)`")
IMAGE_LINE_RE = re.compile(r"\bimage:\s*\"?([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)\"?")

# Optional LDAP UI is documented but not deployed. Operators are verified against
# their bootstrap pins below instead of being exempted from version checking.
ALLOWLIST = {
    "ghcr.io/dasomel/ldapium-ui": "Optional LDAP UI is documented but its deployment is not enabled in Beluga manifests.",
}
BOOTSTRAP_PINS = {
    "Strimzi Kafka Operator": ("quay.io/strimzi/operator", re.compile(r"releases/download/(?P<version>[0-9][A-Za-z0-9.+_-]*)/strimzi-cluster-operator-")),
    "CNPG PostgreSQL": ("ghcr.io/cloudnative-pg/cloudnative-pg", re.compile(r"releases/cnpg-(?P<version>[0-9][A-Za-z0-9.+_-]*)\.yaml")),
    "Flink K8s Operator": ("apache/flink-kubernetes-operator", re.compile(r"flink-kubernetes-operator-(?P<version>[0-9][A-Za-z0-9.+_-]*)/")),
}


def parse_versions_text(text: str) -> dict[str, tuple[str, str]]:
    expected = {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        matches = list(IMAGE_ROW_RE.finditer(line))
        if matches:
            component = line.split("|", 2)[1].strip()
            for index, match in enumerate(matches):
                row_component = "Flink Runtime" if component == "Flink K8s Operator" and index else component
                expected[match.group(1)] = (match.group(2), row_component)
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
        source = re.match(r"^# Source: (.+)$", line)
        if source:
            current_location = source.group(1)
        for repo, tag in IMAGE_LINE_RE.findall(line):
            found.setdefault(repo, {}).setdefault(tag, set()).add(current_location)

    errors = []
    for repo in sorted(allowlist):
        if repo not in expected:
            errors.append(f"allowlisted image {repo} is absent from VERSIONS.md")
        if repo in found:
            errors.append(f"allowlisted image {repo} appears in rendered output (stale allowlist)")

    rows = []
    for repo, tags in sorted(found.items()):
        if repo not in expected:
            errors.append(f"rendered image {repo} is absent from VERSIONS.md")
            continue
        version, component = expected[repo]
        if tags.keys() != {version}:
            errors.append(f"rendered image {repo} ({component}) expected {version}, found {', '.join(sorted(tags))}")
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
    _, errors = inspect(expected, "image: unknown/image:1.2\n", {})
    if not any("absent from VERSIONS.md" in error for error in errors):
        raise AssertionError(f"rendered unknown image should fail: {errors}")
    _, errors = inspect(expected, "image: example/image:2.0\n", {})
    if not any("rendered image example/image" in error for error in errors):
        raise AssertionError(f"rendered tag mismatch should fail: {errors}")
    pin_expected = {
        "strimzi/operator": ("1.2", "Strimzi Kafka Operator"),
        "cnpg/operator": ("1.3", "CNPG PostgreSQL"),
        "flink/operator": ("1.4", "Flink K8s Operator"),
    }
    pins = ("releases/download/1.2/strimzi-cluster-operator- "
            "releases/cnpg-1.3.yaml "
            "flink-kubernetes-operator-1.4/")
    for text, should_fail in ((pins, False), (pins.replace("1.2", "9.9"), True), ("no version here", True)):
        try:
            check_bootstrap_pins(pin_expected, text, "")
            failed = False
        except ValueError:
            failed = True
        if failed != should_fail:
            raise AssertionError(f"bootstrap pin parse/mismatch expected fail={should_fail}")
    rows, _ = inspect(expected, "# arbitrary comment\nimage: example/image:1.2\n", {})
    if "arbitrary comment" in rows[0][2]:
        raise AssertionError("arbitrary comment was treated as a source location")
    print("Self-tests passed (forward/reverse images, tag drift, bootstrap pin mismatch/unparseable, source markers).")


def check_bootstrap_pins(expected: dict[str, tuple[str, str]], bootstrap: str, env: str) -> dict[str, str]:
    sources = bootstrap + "\n" + env
    verified = {}
    for component, (repo, pattern) in BOOTSTRAP_PINS.items():
        versions = set(pattern.findall(sources))
        if len(versions) != 1:
            raise ValueError(f"{component}: expected one parseable bootstrap pin, found {sorted(versions)}")
        version = next(iter(versions))
        recorded = {v for v, c in expected.values() if c == component}
        if recorded != {version}:
            raise ValueError(f"{component}: VERSIONS.md has {sorted(recorded)}, bootstrap pins {version}")
        verified[repo] = f"{component} bootstrap pin verified ({version})."
    return verified


def main() -> int:
    try:
        self_test()
    except AssertionError as error:
        print(f"Self-test FAIL: {error}", file=sys.stderr)
        return 1
    if "--self-test" in sys.argv:
        return 0
    expected = parse_versions_text(VERSIONS_MD.read_text(encoding="utf-8"))
    try:
        bootstrap_verified = check_bootstrap_pins(expected,
                             (REPO_ROOT / "scripts/gitops/01-argocd-bootstrap.sh").read_text(encoding="utf-8"),
                             (REPO_ROOT / "scripts/common/env.sh").read_text(encoding="utf-8"))
    except ValueError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    manifest_text = rendered_manifest_text()
    rows, errors = inspect(expected, manifest_text, {**ALLOWLIST, **bootstrap_verified})
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
