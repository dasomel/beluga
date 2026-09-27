#!/usr/bin/env python3
"""Validate VERSIONS.md licenses against policies/license-policy.yaml."""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
POLICY_YAML = REPO_ROOT / "policies/license-policy.yaml"
PARENTHETICAL_SUFFIX_RE = re.compile(r"\s*\([^)]*\)\s*$")


def load_policy(path: Path) -> tuple[set[str], str]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ValueError(f"cannot load license policy {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("policy must be a mapping")
    approved = data.get("approved_licenses")
    marker = data.get("own_project_marker")
    if (not isinstance(approved, list) or not approved or
            any(not isinstance(item, str) or not item.strip() for item in approved) or
            len(set(approved)) != len(approved)):
        raise ValueError("approved_licenses must be a non-empty list of unique strings")
    if (not isinstance(marker, dict) or not isinstance(marker.get("value"), str) or
            not marker["value"].strip() or not isinstance(marker.get("rationale"), str) or
            not marker["rationale"].strip()):
        raise ValueError("own_project_marker requires non-empty value and rationale strings")
    return set(approved), marker["value"]


def normalize_license_part(part: str) -> str:
    part = part.strip()
    stripped = PARENTHETICAL_SUFFIX_RE.sub("", part).strip()
    return stripped or part


def parse_versions_md(path: Path) -> list[tuple[str, str, str, str]]:
    """Return component, version, image, license cell for each VERSIONS table row."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 4 or cells[0] in ("컴포넌트", "") or set(cells[0]) <= {"-", ":"}:
            continue
        if set(cells[1]) <= {"-", ":"}:
            continue
        rows.append((cells[0], cells[1], cells[2], cells[3]))
    return rows


def check_rows(rows: list[tuple[str, str, str, str]], approved: set[str], marker: str) -> tuple[list[str], list[dict]]:
    diagnostics = []
    inventory = []
    for component, version, image, license_cell in rows:
        if not license_cell:
            diagnostics.append(f"[{component}] FAIL: empty license cell")
            continue
        if license_cell.startswith(marker):
            diagnostics.append(f"[{component}] OK (N/A marker: {license_cell})")
            continue
        licenses = [normalize_license_part(part) for part in license_cell.split(" / ")]
        unapproved = [license for license in licenses if license not in approved]
        if unapproved:
            diagnostics.append(f"[{component}] FAIL: unapproved license(s) {unapproved!r} in cell {license_cell!r}")
            status = "unapproved"
        else:
            diagnostics.append(f"[{component}] OK ({license_cell})")
            status = "approved"
        inventory.append({"component": component, "version": version, "image": image,
                          "licenses": licenses, "policy_status": status})
    return diagnostics, inventory


def self_test(approved: set[str], marker: str) -> None:
    with tempfile.TemporaryDirectory(prefix="beluga-license-policy-") as tmp:
        root = Path(tmp)
        unapproved = root / "unapproved.yaml"
        unapproved.write_text("approved_licenses: [Apache-2.0]\nown_project_marker: {value: 해당 없음, rationale: own}\n", encoding="utf-8")
        loaded, test_marker = load_policy(unapproved)
        diagnostics, _ = check_rows([("Test", "1", "image:test", "Mystery License")], loaded, test_marker)
        if not any("unapproved" in diagnostic for diagnostic in diagnostics):
            raise ValueError("self-test accepted an unapproved license")
        malformed = root / "malformed.yaml"
        malformed.write_text("approved_licenses: [Apache-2.0\n", encoding="utf-8")
        for bad_path in (root / "missing.yaml", malformed):
            try:
                load_policy(bad_path)
            except ValueError:
                continue
            raise ValueError(f"self-test accepted invalid policy: {bad_path.name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print deterministic third-party inventory as JSON")
    args = parser.parse_args()
    try:
        approved, marker = load_policy(POLICY_YAML)
        self_test(approved, marker)
        rows = parse_versions_md(VERSIONS_MD)
    except (ValueError, OSError) as exc:
        print(f"license policy check FAIL: {exc}", file=sys.stderr)
        return 1

    diagnostics, inventory = check_rows(rows, approved, marker)
    if args.json:
        inventory.sort(key=lambda item: item["component"])
        print(json.dumps(inventory, ensure_ascii=False, sort_keys=True, indent=2))
        return 1 if any(" FAIL:" in diagnostic for diagnostic in diagnostics) else 0

    print("=== VERSIONS.md license policy check ===\n")
    print("\n".join(diagnostics))
    print()
    if any(" FAIL:" in diagnostic for diagnostic in diagnostics):
        print("One or more components have a missing or unapproved license.")
        print(f"Approved licenses: {sorted(approved)}")
        print(f'N/A marker accepted as-is when prefixed with "{marker}".')
        return 1
    print(f"{len(rows)} components checked, all licenses declared and approved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
