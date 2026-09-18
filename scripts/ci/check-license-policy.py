#!/usr/bin/env python3
"""Validate that every VERSIONS.md component declares an approved license.

VERSIONS.md is documented as the license single source of truth (see its own header
comment, and NOTICE which points here). Nothing previously checked that every row
actually carries a non-empty, policy-approved license value, so a new row could add an
undeclared or disallowed license with no CI signal. This closes that gap: it parses every
markdown table row across all `##` sections in VERSIONS.md, extracts the "라이선스"
(license) column, and fails if a row's license is empty or not on the approved allowlist.

License cells in this repo are free text, not pure SPDX: some combine two licenses with
" / " (e.g. an operator/engine split, or an image's own license alongside its upstream
license), and some carry an explanatory suffix in parentheses (e.g. "(엔진)",
"(ldapium image project)"). To normalize: split each cell on " / ", then strip any
trailing parenthetical annotation from each part, then match the remaining text against
the allowlist. A cell starting with "해당 없음" (Korean for "not applicable") is accepted
as-is — it is the established marker for Dasomel's own sub-projects (e.g. kube-ready-box)
that carry their own upstream license/NOTICE rather than one declared here.

The allowlist below is derived from every distinct license value already present in
VERSIONS.md as of this script's authoring; it is a gate on future additions, not a
retroactive judgment on existing rows.
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"

APPROVED_LICENSES = {
    "Apache-2.0",
    "PostgreSQL License",
    "OpenLDAP Public License 2.8",
    "curl License",
    "PSF License 2.0",
}

PARENTHETICAL_SUFFIX_RE = re.compile(r"\s*\([^)]*\)\s*$")
NA_MARKER = "해당 없음"


def normalize_license_part(part: str) -> str:
    part = part.strip()
    stripped = PARENTHETICAL_SUFFIX_RE.sub("", part).strip()
    return stripped or part


def parse_versions_md() -> list[tuple[str, str]]:
    """Return (component_name, raw_license_cell) for every data row in every table."""
    rows: list[tuple[str, str]] = []
    for line in VERSIONS_MD.read_text(encoding="utf-8").splitlines():
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
        license_cell = cells[3]
        rows.append((component, license_cell))
    return rows


def main() -> int:
    rows = parse_versions_md()

    fail = False
    print("=== VERSIONS.md license policy check ===\n")
    for component, license_cell in rows:
        if not license_cell:
            print(f"[{component}] FAIL: empty license cell")
            fail = True
            continue

        if license_cell.startswith(NA_MARKER):
            print(f"[{component}] OK (N/A marker: {license_cell})")
            continue

        parts = [normalize_license_part(p) for p in license_cell.split(" / ")]
        unapproved = [p for p in parts if p not in APPROVED_LICENSES]
        if unapproved:
            print(f"[{component}] FAIL: unapproved license(s) {unapproved!r} in cell {license_cell!r}")
            fail = True
        else:
            print(f"[{component}] OK ({license_cell})")

    print()
    if fail:
        print("One or more components have a missing or unapproved license.")
        print(f"Approved licenses: {sorted(APPROVED_LICENSES)}")
        print(f'N/A marker accepted as-is when prefixed with "{NA_MARKER}".')
        return 1
    print(f"{len(rows)} components checked, all licenses declared and approved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
