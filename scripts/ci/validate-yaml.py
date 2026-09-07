#!/usr/bin/env python3
"""Validate YAML syntax for directories of plain (non-Helm-templated) manifests.

Used by `make validate` / CI (.github/workflows/ci.yml). Helm chart templates are
validated separately via `helm template`/`helm lint` — this script covers the
declarative YAML that ships as-is (policies/*.yaml, gitops/apps/*.yaml), where a
typo would otherwise only surface when ArgoCD tries to apply it against a live
cluster. Requires PyYAML (`pip install pyyaml`).
"""

import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: validate-yaml.py <dir> [dir ...]", file=sys.stderr)
        return 2

    failures = 0
    checked = 0
    for root in argv:
        for path in sorted(Path(root).rglob("*.yaml")) + sorted(Path(root).rglob("*.yml")):
            checked += 1
            try:
                list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
            except yaml.YAMLError as exc:
                print(f"invalid YAML: {path}\n  {exc}", file=sys.stderr)
                failures += 1

    if checked == 0:
        print("error: no .yaml/.yml files found under given paths", file=sys.stderr)
        return 2

    if failures:
        print(f"\n{failures}/{checked} file(s) failed YAML syntax validation", file=sys.stderr)
        return 1

    print(f"YAML syntax OK: {checked} file(s) validated")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
