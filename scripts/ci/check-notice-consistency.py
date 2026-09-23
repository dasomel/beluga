#!/usr/bin/env python3
"""Cross-check consistency between VERSIONS.md and NOTICE.

VERSIONS.md is the documented single source of truth for all component versions and
licenses (see its header comment and AGENTS.md). NOTICE points to VERSIONS.md as the
Single Source of Truth, documenting the platform's third-party boundaries, and explicitly
attributes all non-Apache exceptions, sibling projects, and major representative Apache-2.0
components.

This script enforces static, offline, fail-closed consistency between the two:
1. Every third-party component declared with a non-Apache license in VERSIONS.md must be
   present in NOTICE under 'Exceptions worth naming directly' with a matching license.
2. Every exception in NOTICE must correspond to a component in VERSIONS.md declaring that
   non-Apache license (no phantom or pure Apache-2.0 exceptions in NOTICE).
3. Every component cited in NOTICE's Apache License 2.0 list must exist in VERSIONS.md
   and declare Apache-2.0.
4. Every project in VERSIONS.md marked as a self-project ('해당 없음') must appear in
   NOTICE under 'Sibling projects', and every sibling project in NOTICE must exist in
   VERSIONS.md.
5. NOTICE must not attribute components absent from VERSIONS.md.

Negative self-test fixtures run on every execution, proving drift detection.
"""
import re
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
NOTICE_PATH = REPO_ROOT / "NOTICE"

PARENTHETICAL_SUFFIX_RE = re.compile(r"\s*\([^)]*\)\s*$")
ANY_PARENTHETICAL_RE = re.compile(r"\s*\([^)]*\)")
NA_MARKER = "해당 없음"


def strip_parenthetical(text: str) -> str:
    """Strip all parenthetical annotations, e.g. 'curl (유틸)' -> 'curl'."""
    return ANY_PARENTHETICAL_RE.sub("", text).strip()


def strip_trailing_parenthetical(text: str) -> str:
    """Strip only trailing parenthetical suffix, e.g. 'PSF (엔진)' -> 'PSF'."""
    return PARENTHETICAL_SUFFIX_RE.sub("", text).strip()


def canonicalize_license(lic: str) -> str:
    """Normalize license strings across free-text variants to a canonical identifier.

    D1: VERSIONS.md uses compact Korean/English annotations (e.g. 'curl License (MIT류)',
    'PSF License 2.0') while NOTICE uses descriptive English attribution (e.g. 'the curl
    license', 'Python Software Foundation License 2.0'). Canonicalizing known identifiers
    enables reliable offline equality matching while failing closed on unknown drift.
    """
    s = lic.lower().replace("-", " ").replace(",", " ")
    s = re.sub(r"\bthe\b", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if "apache" in s:
        return "apache-2.0"
    if "postgresql" in s:
        return "postgresql"
    if "openldap" in s:
        return "openldap-2.8"
    if "curl" in s:
        return "curl"
    if "psf" in s or "python software foundation" in s:
        return "psf-2.0"
    s = re.sub(r"\s+license\s*$", "", s).strip()
    return re.sub(r"[^a-z0-9.]+", "-", s)


def parse_versions_md(path: Path) -> list[tuple[str, str, str]]:
    """Return (component, image, license_cell) for every data row in every table."""
    rows: list[tuple[str, str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue
        component = cells[0]
        if component in ("컴포넌트", "") or set(component) <= {"-", ":"}:
            continue
        if set(cells[1]) <= {"-", ":"}:
            continue
        image = cells[2]
        license_cell = cells[3]
        rows.append((component, image, license_cell))
    return rows


def parse_notice(path: Path) -> tuple[list[str], list[tuple[str, str, str]], list[tuple[str, str]]]:
    """Parse NOTICE into (apache_components, exceptions, sibling_projects).

    exceptions entries: (base_component_name, license_desc, full_bullet_text)
    sibling_projects entries: (base_name, full_bullet_text)
    """
    text = path.read_text(encoding="utf-8")

    # 1. Apache-2.0 representative components
    apache_match = re.search(r"The large majority are Apache License 2\.0 \(([^)]+)\)", text)
    if not apache_match:
        raise ValueError("Could not find Apache License 2.0 list in NOTICE")
    apache_components = [
        x.strip() for x in apache_match.group(1).split(",")
        if x.strip() and not x.strip().startswith("and ")
    ]

    # 2. Exceptions worth naming directly
    exc_match = re.search(r"Exceptions worth\s+naming directly:\s*\n(.*?)(?=\n\n[^\s-])", text, re.DOTALL)
    if not exc_match:
        raise ValueError("Could not find 'Exceptions worth naming directly' section in NOTICE")
    exceptions: list[tuple[str, str, str]] = []
    for bullet in re.split(r"\n(?=- )", exc_match.group(1).strip()):
        bullet = bullet.lstrip("- ").strip()
        parts = re.split(r"\s+—\s+", bullet, maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"Malformed exception bullet in NOTICE: {bullet!r}")
        comp_desc = parts[0].strip().replace("\n", " ")
        lic_desc = parts[1].strip().replace("\n", " ")
        base_name = re.sub(r"\s+server binary.*", "", comp_desc)
        base_name = strip_parenthetical(base_name)
        exceptions.append((base_name, lic_desc, bullet))

    # 3. Sibling projects
    sib_match = re.search(r"Sibling projects\s*\n=+\s*\n.*?\n\n(.*?)(?=\n\n=|\Z)", text, re.DOTALL)
    if not sib_match:
        raise ValueError("Could not find 'Sibling projects' section in NOTICE")
    siblings: list[tuple[str, str]] = []
    for bullet in re.split(r"\n(?=- )", sib_match.group(1).strip()):
        bullet = bullet.lstrip("- ").strip()
        parts = re.split(r"\s+—\s+", bullet, maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"Malformed sibling project bullet in NOTICE: {bullet!r}")
        proj_desc = parts[0].strip().replace("\n", " ")
        base_name = strip_parenthetical(proj_desc)
        siblings.append((base_name, bullet))

    return apache_components, exceptions, siblings


def find_matching_versions_row(name: str, rows: list[tuple[str, str, str]]) -> tuple[str, str, str] | None:
    """Match a component name from NOTICE against VERSIONS.md rows."""
    # 1. Exact match on raw component name
    for r in rows:
        if r[0] == name:
            return r
    # 2. Match on stripped parenthetical component name
    for r in rows:
        if strip_parenthetical(r[0]) == name:
            return r
    # 3. Word token match (e.g. 'PostgreSQL' in 'CNPG PostgreSQL')
    for r in rows:
        words = strip_parenthetical(r[0]).split()
        if name in words:
            return r
    # 4. Image/repo match (for sibling projects e.g. 'ldapium')
    for r in rows:
        if name in r[1]:
            return r
    return None


def check_consistency(versions_path: Path, notice_path: Path) -> list[str]:
    """Run all consistency checks between VERSIONS.md and NOTICE. Return list of error diagnostics."""
    errors: list[str] = []
    versions_rows = parse_versions_md(versions_path)
    apache_components, exceptions, siblings = parse_notice(notice_path)

    # Track which non-Apache VERSIONS components are attributed
    attributed_exceptions: set[str] = set()
    attributed_siblings: set[str] = set()

    # 1. Check NOTICE Apache components
    for comp in apache_components:
        row = find_matching_versions_row(comp, versions_rows)
        if not row:
            errors.append(f"Component '{comp}' in NOTICE Apache-2.0 list is absent from VERSIONS.md")
            continue
        v_comp, _, v_lic = row
        parts = [strip_trailing_parenthetical(p) for p in re.split(r"\s*/\s*", v_lic)]
        canon_parts = [canonicalize_license(p) for p in parts]
        if "apache-2.0" not in canon_parts:
            errors.append(
                f"Component '{comp}' ({v_comp}) is listed under Apache-2.0 in NOTICE, "
                f"but VERSIONS.md declares non-Apache license '{v_lic}'"
            )

    # 2. Check NOTICE Exceptions
    for base_name, lic_desc, _ in exceptions:
        row = find_matching_versions_row(base_name, versions_rows)
        if not row:
            errors.append(f"Exception in NOTICE attributes '{base_name}', but '{base_name}' is absent from VERSIONS.md")
            continue
        v_comp, _, v_lic = row
        attributed_exceptions.add(v_comp)

        # Check that this component actually has a non-Apache license
        parts = [strip_trailing_parenthetical(p) for p in re.split(r"\s*/\s*", v_lic)]
        non_apache_v = [p for p in parts if canonicalize_license(p) != "apache-2.0" and not p.startswith(NA_MARKER)]
        if not non_apache_v:
            errors.append(
                f"NOTICE lists '{base_name}' ({v_comp}) as an exception, "
                f"but VERSIONS.md declares pure Apache-2.0: '{v_lic}'"
            )
            continue

        # Check that the license in the exception bullet matches VERSIONS.md
        canon_notice_lic = canonicalize_license(lic_desc.split("(")[0].split(",")[0])
        matched = False
        for na_lic in non_apache_v:
            canon_na = canonicalize_license(na_lic)
            if canon_na == canon_notice_lic or canon_na in canonicalize_license(lic_desc):
                matched = True
                break
        if not matched:
            errors.append(
                f"License mismatch for '{base_name}' ({v_comp}): "
                f"VERSIONS.md declares '{v_lic}', but NOTICE exception states '{lic_desc[:60]}...'"
            )

    # 3. Check NOTICE Sibling projects
    for base_name, _ in siblings:
        row = find_matching_versions_row(base_name, versions_rows)
        if not row:
            errors.append(f"Sibling project '{base_name}' in NOTICE is absent from VERSIONS.md")
            continue
        v_comp, _, _ = row
        attributed_siblings.add(v_comp)

    # 4. Forward check: every non-Apache third-party component in VERSIONS.md must be in NOTICE exceptions
    for v_comp, _, v_lic in versions_rows:
        if v_lic.startswith(NA_MARKER):
            # Must be in sibling projects
            if v_comp not in attributed_siblings and not any(base_name in v_comp for base_name, _ in siblings):
                errors.append(
                    f"Component '{v_comp}' is marked as self-project ('{v_lic}') in VERSIONS.md, "
                    f"but is missing from NOTICE Sibling projects"
                )
            continue

        parts = [strip_trailing_parenthetical(p) for p in re.split(r"\s*/\s*", v_lic)]
        non_apache_parts = [p for p in parts if canonicalize_license(p) != "apache-2.0"]
        if non_apache_parts and v_comp not in attributed_exceptions:
            errors.append(
                f"Component '{v_comp}' declared with non-Apache license(s) {non_apache_parts!r} in VERSIONS.md, "
                f"but is missing from NOTICE exceptions"
            )

    return errors


def self_test() -> None:
    """Verify that synthetic drift across all consistency rules is caught fail-closed."""
    versions_text = VERSIONS_MD.read_text(encoding="utf-8")
    notice_text = NOTICE_PATH.read_text(encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="beluga-notice-gate-") as tmpdir:
        tmp = Path(tmpdir)
        v_file = tmp / "VERSIONS.md"
        n_file = tmp / "NOTICE"

        # Baseline check: real repository content must pass
        v_file.write_text(versions_text, encoding="utf-8")
        n_file.write_text(notice_text, encoding="utf-8")
        baseline_errs = check_consistency(v_file, n_file)
        if baseline_errs:
            raise ValueError(f"Baseline self-test failed: {baseline_errs}")

        test_cases = [
            (
                "unpadded_slash_hides_non_apache_license",
                versions_text + "\n| GhostLib | 1.0.0 | `ghost/lib:1.0.0` | Apache-2.0/GPL-3.0 | Unpadded split |\n",
                notice_text,
                "missing from NOTICE exceptions",
            ),
            (
                "missing_exception_in_notice",
                versions_text + "\n| DuckDB | 1.0.0 | `duckdb:1.0.0` | MIT | In-process SQL |\n",
                notice_text,
                "missing from NOTICE exceptions",
            ),
            (
                "extra_exception_in_notice",
                versions_text,
                notice_text.replace(
                    "- Python — Python Software Foundation License 2.0.",
                    "- Python — Python Software Foundation License 2.0.\n- GhostDB — BSD-3-Clause.",
                ),
                "Exception in NOTICE attributes 'GhostDB', but 'GhostDB' is absent from VERSIONS.md",
            ),
            (
                "mismatched_exception_license",
                versions_text,
                notice_text.replace(
                    "- Python — Python Software Foundation License 2.0.",
                    "- Python — MIT License.",
                ),
                "License mismatch for 'Python'",
            ),
            (
                "exception_is_actually_pure_apache",
                versions_text,
                notice_text.replace(
                    "- Python — Python Software Foundation License 2.0.",
                    "- Python — Python Software Foundation License 2.0.\n- Trino — Apache License 2.0.",
                ),
                "NOTICE lists 'Trino' (Trino) as an exception, but VERSIONS.md declares pure Apache-2.0",
            ),
            (
                "missing_apache_component_in_versions",
                versions_text,
                notice_text.replace("etcd, and others)", "etcd, GhostService, and others)"),
                "Component 'GhostService' in NOTICE Apache-2.0 list is absent from VERSIONS.md",
            ),
            (
                "apache_component_drifted_license",
                versions_text.replace(
                    "| Trino | 483 | `trinodb/trino:483` | Apache-2.0 |",
                    "| Trino | 483 | `trinodb/trino:483` | BSL-1.1 |",
                ),
                notice_text,
                "Component 'Trino' (Trino) is listed under Apache-2.0 in NOTICE, but VERSIONS.md declares non-Apache license 'BSL-1.1'",
            ),
            (
                "missing_sibling_in_notice",
                versions_text + "\n| Narwhal Box | 26.04 | `dasomel/narwhal-box` | 해당 없음 — 자체 프로젝트 | VM 박스 |\n",
                notice_text,
                "Component 'Narwhal Box' is marked as self-project ('해당 없음 — 자체 프로젝트') in VERSIONS.md, but is missing from NOTICE Sibling projects",
            ),
            (
                "extra_sibling_in_notice",
                versions_text,
                notice_text.replace(
                    "- Ubuntu Box (`dasomel/ubuntu-26.04-xfs`)",
                    "- GhostProject (`dasomel/ghost`) — https://github.com/dasomel/ghost\n- Ubuntu Box (`dasomel/ubuntu-26.04-xfs`)",
                ),
                "Sibling project 'GhostProject' in NOTICE is absent from VERSIONS.md",
            ),
        ]

        for name, v_content, n_content, expected_diagnostic in test_cases:
            v_file.write_text(v_content, encoding="utf-8")
            n_file.write_text(n_content, encoding="utf-8")
            errs = check_consistency(v_file, n_file)
            if not errs:
                raise ValueError(f"Self-test {name} unexpectedly PASSED (drift not detected)")
            if not any(expected_diagnostic in e for e in errs):
                raise ValueError(f"Self-test {name} failed without expected diagnostic '{expected_diagnostic}': {errs}")

    print(f"Self-tests OK: {len(test_cases)} drift fixtures rejected.")


def main() -> int:
    try:
        self_test()
    except (OSError, UnicodeError, ValueError) as error:
        print(f"NOTICE consistency self-test FAIL: {error}", file=sys.stderr)
        return 1

    errors = check_consistency(VERSIONS_MD, NOTICE_PATH)
    print("=== VERSIONS.md vs NOTICE consistency check ===\n")
    if errors:
        for err in errors:
            print(f"FAIL: {err}")
        print("\nVERSIONS.md and NOTICE are inconsistent. Reconcile both files.")
        return 1

    print("OK: All third-party non-Apache exceptions, sibling projects, and representative Apache components match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
