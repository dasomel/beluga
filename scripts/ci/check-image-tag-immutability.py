#!/usr/bin/env python3
"""Issue #10 slice: reject mutable image references in rendered manifests.

check-version-consistency.py already cross-checks VERSIONS.md against a *default*
`helm template` render; it does not evaluate whether the tag itself is safe to deploy,
and it never renders the 48/64GB RAM profile (`openmetadata.enabled=true`,
`trino.workerEnabled=true` — see scripts/common/env.sh, scripts/gitops/01-argocd-bootstrap.sh)
where extra containers (OpenSearch, OpenMetadata server, the Trino worker Deployment) only
exist in the rendered output. This script is deliberately separate rather than folded into
that one: it renders every values combination that scripts/gitops/01-argocd-bootstrap.sh can
actually produce and evaluates a different property (tag/digest immutability, not drift
against VERSIONS.md).

Gate rules for every `image:` reference found in the rendered output:
  - a bare digest reference (`repo@sha256:...`, with or without a tag alongside it) always
    passes — the digest, not the tag, is what pins the pulled bytes.
  - missing tag and no digest -> FAIL (defaults to registry `latest` at pull time).
  - tag `latest` -> FAIL.
  - branch/channel-like tags (`main`, `master`, `dev`, `edge`, `nightly`, `stable`, or any
    tag ending in `-SNAPSHOT`, case-insensitive) -> FAIL. These are floating: the registry
    can repoint them to different bytes without the manifest changing.
  - anything else (a concrete version, optionally with a build/arch suffix) -> PASS.

Known exceptions are tracked in KNOWN_MUTABLE_BASELINE below with a concrete reason and
issue reference — never as a blanket allowlist. Only `ghcr.io/dasomel/ldapium` is there
today: VERSIONS.md's own row (line ~38) records `nightly-4e85165` as ldapium's current
version because no tagged/digest release exists yet ("정식 릴리스 전" — before official
release), so there is nothing to "fix" by re-pinning to VERSIONS.md; the baseline entry
*is* the VERSIONS.md-recorded value.

Out of scope (per issue #10 slice + explicit task note): images pulled by the Strimzi
Kafka Operator install manifest and the Flink Kubernetes Operator Helm chart in
scripts/gitops/01-argocd-bootstrap.sh are fetched from upstream release URLs/Helm repos by
operator version, not declared as `image:` lines in this repo's own charts — they are not
rendered or gated here.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# (label, chart directory name, --set overrides) — every values combination that
# scripts/gitops/01-argocd-bootstrap.sh can actually deploy (default RAM profile, and the
# 48/64GB profile that turns on OpenMetadata + the Trino worker; scripts/common/env.sh).
RENDER_COMBOS = (
    ("beluga-platform (default)", "beluga-platform", {}),
    ("beluga-data (default RAM profile)", "beluga-data", {}),
    (
        "beluga-data (48/64GB RAM profile)",
        "beluga-data",
        {"openmetadata.enabled": "true", "trino.workerEnabled": "true"},
    ),
)

IMAGE_LINE_RE = re.compile(r'^\s*(?:-\s*)?image:\s*"?([^"\s#]+)"?', re.MULTILINE)

BRANCH_LIKE_WORDS = ("main", "master", "dev", "edge", "nightly", "stable")

# Concrete, individually-justified exceptions only — never a file-wide bypass. Keyed by the
# exact `repo:tag` (or `repo` when tag-less) string as it appears in the rendered manifest.
KNOWN_MUTABLE_BASELINE: dict[str, str] = {
    "ghcr.io/dasomel/ldapium:nightly-4e85165": (
        "Issue #10: matches VERSIONS.md's own recorded version for ldapium "
        "(no tagged/digest release exists yet — 'ldapium 정식 릴리스 전'); "
        "re-pin when ldapium cuts a versioned/digest release."
    ),
}


def parse_ref(ref: str) -> tuple[str, str | None, str | None]:
    """Split an image reference into (repository, tag, digest), tag/digest optional."""
    digest = None
    if "@" in ref:
        ref, digest = ref.split("@", 1)
    last_slash = ref.rfind("/")
    tail = ref[last_slash + 1:]
    if ":" in tail:
        repo, tag = ref.rsplit(":", 1)
    else:
        repo, tag = ref, None
    return repo, tag, digest


def is_branch_like(tag: str) -> bool:
    lowered = tag.lower()
    if lowered.endswith("-snapshot"):
        return True
    return any(lowered == word or lowered.startswith(f"{word}-") for word in BRANCH_LIKE_WORDS)


def classify(ref: str) -> tuple[str, str]:
    """Return (status, reason) for one image reference, ignoring the baseline overlay."""
    repo, tag, digest = parse_ref(ref)
    if digest:
        return "OK", f"pinned by digest ({digest[:16]}...)"
    if tag is None:
        return "FAIL", "missing tag and no digest (defaults to latest at pull time)"
    if tag.lower() == "latest":
        return "FAIL", "tag is 'latest'"
    if is_branch_like(tag):
        return "FAIL", f"branch/channel-like tag '{tag}' (mutable)"
    return "OK", f"pinned tag '{tag}'"


def extract_images(rendered_text: str) -> list[str]:
    seen: dict[str, None] = {}
    for match in IMAGE_LINE_RE.finditer(rendered_text):
        seen.setdefault(match.group(1), None)
    return list(seen)


def evaluate(image_refs: list[str]) -> tuple[list[tuple[str, str, str]], bool]:
    """Classify every ref, apply the baseline overlay, return (rows, any_unbaselined_fail)."""
    rows: list[tuple[str, str, str]] = []
    fail = False
    for ref in sorted(image_refs):
        status, reason = classify(ref)
        if status == "FAIL" and ref in KNOWN_MUTABLE_BASELINE:
            rows.append(("BASELINE", ref, KNOWN_MUTABLE_BASELINE[ref]))
            continue
        if status == "FAIL":
            fail = True
        rows.append((status, ref, reason))
    return rows, fail


def render(chart: str, overrides: dict[str, str]) -> str:
    cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart)]
    for key, value in overrides.items():
        cmd += ["--set", f"{key}={value}"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    return result.stdout


def print_table(rows: list[tuple[str, str, str]]) -> None:
    width = max((len(ref) for _, ref, _ in rows), default=0)
    print(f"{'STATUS':<8} {'IMAGE':<{width}}  REASON")
    for status, ref, reason in rows:
        print(f"{status:<8} {ref:<{width}}  {reason}")


# --- self-test: fixture manifests (positive + negative), no cluster/registry access ---

_POSITIVE_FIXTURES = {
    "nginx:1.27.3": "OK",
    "registry.example.com:5000/team/app:2.3.1": "OK",
    "repo/app@sha256:" + "de" * 32: "OK",
    "repo/app:2.3.1@sha256:" + "de" * 32: "OK",
}

_NEGATIVE_FIXTURES = {
    "repo/app": "missing tag",
    "repo/app:latest": "'latest'",
    "repo/app:main": "branch/channel-like",
    "repo/app:master": "branch/channel-like",
    "repo/app:dev": "branch/channel-like",
    "repo/app:dev-1234": "branch/channel-like",
    "repo/app:edge": "branch/channel-like",
    "repo/app:nightly": "branch/channel-like",
    "repo/app:nightly-abc1234": "branch/channel-like",
    "repo/app:stable": "branch/channel-like",
    "repo/app:1.0.0-SNAPSHOT": "branch/channel-like",
}


def self_test() -> int:
    checked = 0
    for ref, _ in _POSITIVE_FIXTURES.items():
        status, reason = classify(ref)
        if status != "OK":
            raise ValueError(f"self-test regression: expected OK for {ref!r}, got {status} ({reason})")
        checked += 1
    for ref, expected_fragment in _NEGATIVE_FIXTURES.items():
        status, reason = classify(ref)
        if status != "FAIL":
            raise ValueError(f"self-test regression: expected FAIL for {ref!r}, got {status} ({reason})")
        if expected_fragment not in reason:
            raise ValueError(
                f"self-test regression: {ref!r} failed for the wrong reason: {reason!r} "
                f"(expected fragment {expected_fragment!r})"
            )
        checked += 1

    # extract_images must ignore imagePullPolicy/images/etc. and dedupe repeats.
    fixture_manifest = (
        "spec:\n"
        "  containers:\n"
        "    - name: app\n"
        "      image: repo/app:1.2.3\n"
        "      imagePullPolicy: IfNotPresent\n"
        "  initContainers:\n"
        "    - name: init\n"
        "      image: repo/app:1.2.3\n"
        "images:\n"
        "  - repo/other:9.9.9\n"
    )
    images = extract_images(fixture_manifest)
    if images != ["repo/app:1.2.3"]:
        raise ValueError(f"self-test regression: extract_images misparsed fixture manifest: {images}")
    checked += 1

    # baseline overlay: a FAIL ref present in KNOWN_MUTABLE_BASELINE must downgrade to
    # BASELINE (and not fail the build); an identical-shaped FAIL ref absent from the
    # baseline must still fail closed.
    baselined_ref = next(iter(KNOWN_MUTABLE_BASELINE))
    rows, fail = evaluate([baselined_ref])
    if fail or rows[0][0] != "BASELINE":
        raise ValueError(f"self-test regression: baselined ref {baselined_ref!r} did not downgrade to BASELINE")
    checked += 1

    rows, fail = evaluate(["repo/unbaselined:nightly"])
    if not fail or rows[0][0] != "FAIL":
        raise ValueError("self-test regression: an un-baselined mutable tag did not fail closed")
    checked += 1

    return checked


def main() -> int:
    try:
        checked = self_test()
    except ValueError as exc:
        print(f"Image tag immutability self-test FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"Image tag immutability self-test OK: {checked} fixtures verified.", file=sys.stderr)

    print("=== Image tag immutability check (rendered manifests) ===\n")
    all_refs: set[str] = set()
    try:
        for label, chart, overrides in RENDER_COMBOS:
            print(f"Rendering {label}...")
            all_refs.update(extract_images(render(chart, overrides)))
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1

    rows, fail = evaluate(list(all_refs))
    print()
    print_table(rows)
    print()

    baseline_count = sum(1 for status, _, _ in rows if status == "BASELINE")
    if baseline_count:
        print(f"{baseline_count} image(s) accepted via documented baseline exception (see KNOWN_MUTABLE_BASELINE).")
    if fail:
        print("\nOne or more images use a mutable/missing tag. Pin to a concrete version or digest, "
              "or add a justified, issue-referenced entry to KNOWN_MUTABLE_BASELINE.")
        return 1
    print(f"OK: {len(rows)} image(s) checked, all pinned by tag or digest (or documented baseline exception).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
