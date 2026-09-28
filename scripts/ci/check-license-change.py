#!/usr/bin/env python3
"""Require reviewed policy entries for license changes against an optional base."""

import argparse
import importlib.util
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_CHECK_PATH = Path(__file__).resolve().parent / "check-license-policy.py"
SPEC = importlib.util.spec_from_file_location("check_license_policy", POLICY_CHECK_PATH)
assert SPEC and SPEC.loader
license_policy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = license_policy
SPEC.loader.exec_module(license_policy)

VERSIONS = REPO_ROOT / "VERSIONS.md"
POLICY = REPO_ROOT / "policies/license-policy.yaml"


def rows_from_text(text: str) -> dict[str, str]:
    """Parse the shared VERSIONS table format and reject ambiguous/malformed data."""
    # D1: share the repository parser to keep table semantics aligned; the small temp file
    # costs one local write and preserves the helper API, with direct parsing as a future escape hatch.
    with tempfile.TemporaryDirectory(prefix="license-change-versions-") as tmp:
        source = Path(tmp) / "VERSIONS.md"
        source.write_text(text, encoding="utf-8")
        rows = license_policy.parse_versions_md(source)
    result: dict[str, str] = {}
    for component, _version, _image, license_cell in rows:
        if component in result:
            raise ValueError(f"duplicate component row: {component}")
        result[component] = license_cell
    if not result:
        raise ValueError("VERSIONS.md contains no component rows")
    # Detect pipe rows that the shared permissive parser cannot interpret as data.
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.startswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if cells and cells[0] not in ("컴포넌트", "") and not set(cells[0]) <= {"-", ":"}:
                if len(cells) < 4 or not cells[1] or not cells[3]:
                    raise ValueError(f"malformed VERSIONS table row at line {line_no}")
    return result


def load_reviews(path: Path) -> set[tuple[str, str]]:
    import yaml

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ValueError(f"cannot load license policy {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("policy must be a mapping")
    reviews = data.get("license_change_reviews")
    if not isinstance(reviews, list):
        raise ValueError("license_change_reviews must be a list")
    accepted = set()
    for index, review in enumerate(reviews):
        if not isinstance(review, dict):
            raise ValueError(f"license_change_reviews[{index}] must be a mapping")
        for key in ("component", "new_license", "approved_by", "rationale"):
            if not isinstance(review.get(key), str) or not review[key].strip():
                raise ValueError(f"license_change_reviews[{index}].{key} must be non-empty")
        pair = (review["component"], review["new_license"])
        if pair in accepted:
            raise ValueError(f"duplicate license change review: {pair!r}")
        accepted.add(pair)
    return accepted


def compare(base: dict[str, str], current: dict[str, str], reviews: set[tuple[str, str]]) -> list[str]:
    errors = []
    for component, license_cell in current.items():
        changed = component not in base or normalized_cell(base[component]) != normalized_cell(license_cell)
        if changed and (component, license_cell) not in reviews:
            kind = "added with license" if component not in base else f"license changed from {base[component]!r}"
            errors.append(f"[{component}] {kind} to {license_cell!r} without reviewed exception")
    return errors


def normalized_cell(cell: str) -> tuple[str, ...]:
    """Match the policy checker's parenthetical suffix normalization per license part."""
    return tuple(license_policy.normalize_license_part(part) for part in cell.split(" / "))


def self_test() -> None:
    # D2: run deterministic in-memory drift fixtures every invocation; no git/network state is needed.
    original = {"A": "Apache-2.0", "B": "MIT"}
    assert not compare(original, dict(original), set())
    assert compare(original, {"A": "MIT", "B": "MIT"}, set())
    assert not compare(original, {"A": "MIT", "B": "MIT"}, {("A", "MIT")})
    assert not compare({"A": "curl License"}, {"A": "curl License (MIT-like)"}, set())
    assert compare(original, {**original, "C": "BSD"}, set())
    assert not compare(original, {"A": "Apache-2.0"}, set())
    try:
        rows_from_text("| 컴포넌트 | 버전 | 이미지 | 라이선스 |\n|---|---|---|---|\n| A | 1 | img |")
    except ValueError:
        pass
    else:
        raise ValueError("self-test accepted malformed table")
    with tempfile.TemporaryDirectory(prefix="license-change-policy-") as tmp:
        malformed_reviews = Path(tmp) / "policy.yaml"
        malformed_reviews.write_text("license_change_reviews: [not-a-review]\n", encoding="utf-8")
        try:
            load_reviews(malformed_reviews)
        except ValueError:
            pass
        else:
            raise ValueError("self-test accepted malformed license_change_reviews entry")


def main() -> int:
    parser = argparse.ArgumentParser()
    base_group = parser.add_mutually_exclusive_group()
    base_group.add_argument("--base-ref")
    base_group.add_argument("--base-file", type=Path)
    args = parser.parse_args()
    try:
        self_test()
        reviews = load_reviews(POLICY)
        current_rows = rows_from_text(VERSIONS.read_text(encoding="utf-8"))
        if not args.base_ref and not args.base_file:
            print("license change check: PASS (no base supplied; comparison skipped)")
            return 0
        if args.base_file:
            base_text = args.base_file.read_text(encoding="utf-8")
        else:
            import subprocess
            result = subprocess.run(["git", "show", f"{args.base_ref}:VERSIONS.md"], cwd=REPO_ROOT,
                                    capture_output=True, text=True, check=False)
            if result.returncode:
                raise ValueError(f"git show {args.base_ref}:VERSIONS.md failed: {result.stderr.strip()}")
            base_text = result.stdout
        base_rows = rows_from_text(base_text)
        errors = compare(base_rows, current_rows, reviews)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"license change check FAIL: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("license change check FAIL:")
        print("\n".join(errors))
        return 1
    print(f"license change check PASS ({len(current_rows)} current components checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
