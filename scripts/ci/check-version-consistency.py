#!/usr/bin/env python3
"""Cross-check VERSIONS.md image tags against what the GitOps manifests actually deploy.

VERSIONS.md is documented as the single source of truth (see its own header), but nothing
previously verified that a version bump there was mirrored into the Helm charts / plain
manifests. This reproduces the exact drift class already logged in docs/mistakes-log.md
(2026-08-10): the VERSIONS.md column changes, the manifest's image tag does not.

For every VERSIONS.md row with a backtick-quoted `repo:tag` image reference, this renders
the two Helm charts (helm template) plus any plain gitops/apps and gitops/resources YAML,
and checks that every occurrence of that image repo in the rendered output uses the same
tag VERSIONS.md declares. Images not found anywhere in rendered output are reported as
not-yet-deployed (several VERSIONS.md rows document components that are intentionally not
wired up yet) rather than silently skipped or treated as a failure.
"""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
IMAGE_ROW_RE = re.compile(r"`([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)`")
IMAGE_LINE_RE = re.compile(r"\bimage:\s*\"?([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)\"?")


def parse_versions_md() -> dict[str, str]:
    expected: dict[str, str] = {}
    for line in VERSIONS_MD.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        m = IMAGE_ROW_RE.search(line)
        if not m:
            continue
        repo, tag = m.group(1), m.group(2)
        expected[repo] = tag
    return expected


def rendered_manifest_text() -> str:
    parts = []
    for chart in ("beluga-platform", "beluga-data"):
        result = subprocess.run(
            ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart)],
            capture_output=True, text=True, check=True,
        )
        parts.append(result.stdout)
    for directory in ("gitops/apps", "gitops/resources"):
        d = REPO_ROOT / directory
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.yaml")):
            parts.append(f.read_text(encoding="utf-8"))
    return "\n".join(parts)


def main() -> int:
    expected = parse_versions_md()
    manifest_text = rendered_manifest_text()

    actual_tags: dict[str, set[str]] = {}
    for repo, tag in IMAGE_LINE_RE.findall(manifest_text):
        actual_tags.setdefault(repo, set()).add(tag)

    fail = False
    print("=== VERSIONS.md vs rendered-manifest image tag check ===\n")
    for repo, expected_tag in sorted(expected.items()):
        found = actual_tags.get(repo)
        if not found:
            print(f"[{repo}] VERSIONS.md={expected_tag}  not deployed in any rendered manifest (skipped)")
            continue
        if found == {expected_tag}:
            print(f"[{repo}] OK ({expected_tag})")
        else:
            print(f"[{repo}] MISMATCH: VERSIONS.md={expected_tag}  manifest={sorted(found)}")
            fail = True

    print()
    if fail:
        print("One or more images are deployed at a version that disagrees with VERSIONS.md.")
        print("Update either VERSIONS.md or the manifest so both sides agree.")
        return 1
    print("All deployed images match VERSIONS.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
