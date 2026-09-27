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

Sources scanned (issue #10 review round 2 — a regex over `image:` lines missed YAML flow
maps and mishandled quoted values, and only covered two Helm charts):
  1. Every `helm template` combo in RENDER_COMBOS, parsed with PyYAML (`safe_load_all`,
     already a pinned CI dependency — see requirements-ci.txt) and walked recursively for
     any dict key literally named `image` (D1: generic-by-key rather than an enumerated list
     of pod-spec locations per kind — Pod/Deployment/StatefulSet/DaemonSet/ReplicaSet/Job/
     CronJob templates, `containers`/`initContainers`/`ephemeralContainers` — because a real
     YAML parser already normalizes flow-map syntax and quoting, so walking by key catches
     every one of those locations plus anything the enumerated list would miss, e.g. a future
     kind or a nested subchart shape, at negligible extra cost).
  2. Plain (non-Helm-templated) YAML under gitops/ that isn't inside a chart directory
     (chart `templates/` contain Go templating and are only valid YAML after step 1 renders
     them) — currently gitops/apps/*.yaml.
  3. Airflow DAG `KubernetesPodOperator(image=...)` keyword arguments, found via the `ast`
     module under every gitops/**/dags/ directory. A literal string, or a reference to a
     simple module-level `NAME = "..."` constant, is treated as the pinned ref and gated the
     same as any other image. Anything else (a variable, f-string, function call, etc.) is
     reported "unverifiable" and fails the build unless explicitly baselined in
     KNOWN_UNVERIFIABLE_BASELINE with a concrete reason — mirroring KNOWN_MUTABLE_BASELINE
     below, never a blanket allowlist.

Each source in (1) and the DAG scan in (3) must yield at least one image; a source silently
producing zero images (e.g. a render regression, a moved directory) fails closed instead of
passing quietly. Source (2) has no non-empty requirement — gitops/apps/*.yaml legitimately
declares no image today.

Gate rules for every image reference found:
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
*is* the VERSIONS.md-recorded value. That link is enforced, not just documented: the check
fails if VERSIONS.md changes the recorded tag without the baseline being updated to match
(re-review forced), and fails if the baselined ref stops appearing anywhere in the scanned
output (a stale entry that should be deleted instead of silently doing nothing).

Out of scope (per issue #10 slice + explicit task note): images pulled by the Strimzi
Kafka Operator install manifest and the Flink Kubernetes Operator Helm chart in
scripts/gitops/01-argocd-bootstrap.sh are fetched from upstream release URLs/Helm repos by
operator version, not declared as `image:` lines in this repo's own charts — they are not
rendered or gated here.
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS_MD = REPO_ROOT / "VERSIONS.md"
GITOPS_ROOT = REPO_ROOT / "gitops"

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

BRANCH_LIKE_WORDS = ("main", "master", "dev", "edge", "nightly", "stable")

VERSIONS_MD_IMAGE_ROW_RE = re.compile(r"`([a-zA-Z0-9./_-]+(?:\.[a-zA-Z0-9./_-]+)*):([A-Za-z0-9._-]+)`")

# Concrete, individually-justified exceptions only — never a file-wide bypass. Keyed by the
# exact `repo:tag` (or `repo` when tag-less) string as it appears in the scanned output.
# validate_baseline() ties every entry here to VERSIONS.md and to actual usage (see module
# docstring) — an entry that no longer matches either fails the build.
KNOWN_MUTABLE_BASELINE: dict[str, str] = {
    "ghcr.io/dasomel/ldapium:nightly-4e85165": (
        "Issue #10: matches VERSIONS.md's own recorded version for ldapium "
        "(no tagged/digest release exists yet — 'ldapium 정식 릴리스 전'); "
        "re-pin when ldapium cuts a versioned/digest release."
    ),
}

# Non-literal `image=` keyword arguments the DAG ast scan cannot verify, keyed by
# "path/relative/to/repo.py:lineno" — same spirit as KNOWN_MUTABLE_BASELINE, a concrete
# reviewed reason per entry, never a blanket allowlist. Empty today: every DAG image= is a
# literal or a simple module constant.
KNOWN_UNVERIFIABLE_BASELINE: dict[str, str] = {}


@dataclass(frozen=True)
class Finding:
    source: str
    kind: str  # "ref" (an image reference string) or "unverifiable" (a DAG image= we can't read statically)
    value: str  # the image ref (kind == "ref"), or "path:lineno" (kind == "unverifiable")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


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


def walk_image_keys(node: object, out: list[str]) -> None:
    """Recursively collect every string value under a dict key literally named `image`."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "image" and isinstance(value, str):
                out.append(value)
            else:
                walk_image_keys(value, out)
    elif isinstance(node, list):
        for item in node:
            walk_image_keys(item, out)


def extract_images_from_yaml(text: str) -> list[str]:
    seen: dict[str, None] = {}
    for doc in yaml.safe_load_all(text):
        found: list[str] = []
        walk_image_keys(doc, found)
        for ref in found:
            seen.setdefault(ref, None)
    return list(seen)


def render(chart: str, overrides: dict[str, str]) -> str:
    cmd = ["helm", "template", str(GITOPS_ROOT / "charts" / chart)]
    for key, value in overrides.items():
        cmd += ["--set", f"{key}={value}"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    return result.stdout


def plain_manifest_paths() -> list[Path]:
    """Plain YAML under gitops/ that isn't inside a chart directory (see module docstring)."""
    paths: list[Path] = []
    for path in sorted(GITOPS_ROOT.rglob("*.yaml")) + sorted(GITOPS_ROOT.rglob("*.yml")):
        if "charts" in path.relative_to(GITOPS_ROOT).parts:
            continue
        paths.append(path)
    return paths


def dag_paths() -> list[Path]:
    paths: list[Path] = []
    for dags_dir in sorted(GITOPS_ROOT.rglob("dags")):
        if dags_dir.is_dir():
            paths.extend(sorted(dags_dir.glob("*.py")))
    return paths


def scan_dag_images(py_path: Path) -> list[Finding]:
    """Find every `image=` keyword argument in py_path via ast (no code execution)."""
    source = f"dag:{rel(py_path)}"
    tree = ast.parse(py_path.read_text(encoding="utf-8"), filename=str(py_path))

    module_consts: dict[str, str] = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            module_consts[node.targets[0].id] = node.value.value

    findings: list[Finding] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for kw in node.keywords:
            if kw.arg != "image":
                continue
            literal: str | None = None
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                literal = kw.value.value
            elif isinstance(kw.value, ast.Name) and kw.value.id in module_consts:
                literal = module_consts[kw.value.id]
            if literal is not None:
                findings.append(Finding(source, "ref", literal))
            else:
                loc = f"{rel(py_path)}:{node.lineno}"
                findings.append(Finding(source, "unverifiable", loc))
    return findings


def require_nonempty(label: str, values: list[str]) -> None:
    if not values:
        raise RuntimeError(f"{label} produced zero images — coverage silently vanished (issue #10 gate)")


def parse_versions_md_refs() -> dict[str, str]:
    """repo -> tag for every backtick-quoted `repo:tag` reference in VERSIONS.md."""
    expected: dict[str, str] = {}
    for line in VERSIONS_MD.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        match = VERSIONS_MD_IMAGE_ROW_RE.search(line)
        if match:
            expected[match.group(1)] = match.group(2)
    return expected


def validate_baseline(versions_md_refs: dict[str, str], scanned_refs: set[str]) -> list[str]:
    """Tie every KNOWN_MUTABLE_BASELINE entry to VERSIONS.md and to actual usage."""
    errors: list[str] = []
    for baselined_ref in KNOWN_MUTABLE_BASELINE:
        repo, tag, _digest = parse_ref(baselined_ref)
        md_tag = versions_md_refs.get(repo)
        if md_tag is None:
            errors.append(
                f"KNOWN_MUTABLE_BASELINE entry {baselined_ref!r} has no matching VERSIONS.md row "
                f"for repo {repo!r} — the baseline is supposed to *be* the VERSIONS.md value"
            )
        elif md_tag != tag:
            errors.append(
                f"KNOWN_MUTABLE_BASELINE entry {baselined_ref!r} is stale: VERSIONS.md now records "
                f"'{repo}:{md_tag}' — update the baseline entry (and re-review it) to match"
            )
        if baselined_ref not in scanned_refs:
            errors.append(
                f"KNOWN_MUTABLE_BASELINE entry {baselined_ref!r} was not found in any scanned "
                "manifest/DAG — remove the stale entry"
            )
    return errors


def evaluate(findings: list[Finding]) -> tuple[list[tuple[str, str, str, str]], bool]:
    """Classify every finding, apply the baseline overlays, return (rows, any_unbaselined_fail)."""
    rows: list[tuple[str, str, str, str]] = []
    fail = False
    for finding in sorted(findings, key=lambda f: (f.source, f.kind, f.value)):
        if finding.kind == "unverifiable":
            if finding.value in KNOWN_UNVERIFIABLE_BASELINE:
                rows.append(("BASELINE", finding.source, finding.value, KNOWN_UNVERIFIABLE_BASELINE[finding.value]))
                continue
            fail = True
            rows.append((
                "FAIL", finding.source, finding.value,
                "image= is not a string literal or a simple module-level constant",
            ))
            continue

        status, reason = classify(finding.value)
        if status == "FAIL" and finding.value in KNOWN_MUTABLE_BASELINE:
            rows.append(("BASELINE", finding.source, finding.value, KNOWN_MUTABLE_BASELINE[finding.value]))
            continue
        if status == "FAIL":
            fail = True
        rows.append((status, finding.source, finding.value, reason))
    return rows, fail


def print_table(rows: list[tuple[str, str, str, str]]) -> None:
    status_w = max((len(status) for status, _, _, _ in rows), default=6)
    source_w = max((len(source) for _, source, _, _ in rows), default=6)
    value_w = max((len(value) for _, _, value, _ in rows), default=len("IMAGE / LOCATION"))
    print(f"{'STATUS':<{status_w}} {'SOURCE':<{source_w}} {'IMAGE / LOCATION':<{value_w}}  REASON")
    for status, source, value, reason in rows:
        print(f"{status:<{status_w}} {source:<{source_w}} {value:<{value_w}}  {reason}")


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
    import tempfile

    checked = 0
    for ref in _POSITIVE_FIXTURES:
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

    # extract_images_from_yaml must ignore imagePullPolicy/images/etc. and dedupe repeats,
    # using block-style mappings (the common case).
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
    images = extract_images_from_yaml(fixture_manifest)
    if images != ["repo/app:1.2.3"]:
        raise ValueError(f"self-test regression: extract_images_from_yaml misparsed block fixture: {images}")
    checked += 1

    # regression (issue #10 review): a flow-map container list (`containers: [{...}]`) must
    # be found too — the old line-oriented regex only matched block-style `image:` lines.
    flow_map_manifest = (
        "apiVersion: v1\n"
        "kind: Pod\n"
        "spec:\n"
        "  containers: [{name: app, image: repo/flow:1.0.0}]\n"
    )
    images = extract_images_from_yaml(flow_map_manifest)
    if images != ["repo/flow:1.0.0"]:
        raise ValueError(f"self-test regression: extract_images_from_yaml missed a flow-map image: {images}")
    checked += 1

    # regression (issue #10 review): single- and double-quoted values must come back clean,
    # not with the quote characters still attached (the old regex only stripped `"`).
    quoted_manifest = (
        "spec:\n"
        "  containers:\n"
        "    - name: app\n"
        '      image: "repo/quoted:2.0.0"\n'
        "    - name: app2\n"
        "      image: 'repo/quoted2:3.0.0'\n"
    )
    images = extract_images_from_yaml(quoted_manifest)
    if sorted(images) != ["repo/quoted2:3.0.0", "repo/quoted:2.0.0"]:
        raise ValueError(f"self-test regression: extract_images_from_yaml mishandled quoted values: {images}")
    checked += 1

    # baseline overlay: a FAIL ref present in KNOWN_MUTABLE_BASELINE must downgrade to
    # BASELINE (and not fail the build); an identical-shaped FAIL ref absent from the
    # baseline must still fail closed.
    baselined_ref = next(iter(KNOWN_MUTABLE_BASELINE))
    rows, fail = evaluate([Finding("test", "ref", baselined_ref)])
    if fail or rows[0][0] != "BASELINE":
        raise ValueError(f"self-test regression: baselined ref {baselined_ref!r} did not downgrade to BASELINE")
    checked += 1

    rows, fail = evaluate([Finding("test", "ref", "repo/unbaselined:nightly")])
    if not fail or rows[0][0] != "FAIL":
        raise ValueError("self-test regression: an un-baselined mutable tag did not fail closed")
    checked += 1

    # regression (issue #10 review): a source producing zero images must fail closed instead
    # of silently passing (previously nothing asserted per-source coverage).
    try:
        require_nonempty("fixture source", [])
    except RuntimeError:
        pass
    else:
        raise ValueError("self-test regression: require_nonempty did not reject an empty image list")
    require_nonempty("fixture source", ["repo/app:1.0.0"])  # must not raise
    checked += 1

    # regression (issue #10 review): DAG `image=` keyword arguments — a literal, a
    # module-level constant reference, and an unverifiable (non-literal) value.
    with tempfile.TemporaryDirectory(prefix="beluga-image-immutability-dag-") as tmpdir:
        dag_fixture = Path(tmpdir) / "fixture_dag.py"
        dag_fixture.write_text(
            "TRINO_IMAGE = 'repo/trino:1.2.3'\n"
            "\n"
            "def build():\n"
            "    literal = Operator(image='repo/app:9.9.9', name='c')\n"
            "    via_constant = Operator(image=TRINO_IMAGE, name='a')\n"
            "    unverifiable = Operator(image=some_variable, name='b')\n",
            encoding="utf-8",
        )
        dag_findings = scan_dag_images(dag_fixture)
        by_value = {f.value: f.kind for f in dag_findings}
        if by_value.get("repo/app:9.9.9") != "ref":
            raise ValueError(f"self-test regression: DAG literal image= not detected as ref: {dag_findings}")
        if by_value.get("repo/trino:1.2.3") != "ref":
            raise ValueError(f"self-test regression: DAG module-constant image= not resolved: {dag_findings}")
        unverifiable_kinds = [f.kind for f in dag_findings if f.value.endswith(":6")]
        if unverifiable_kinds != ["unverifiable"]:
            raise ValueError(f"self-test regression: DAG non-literal image= not flagged unverifiable: {dag_findings}")
    checked += 1

    # regression (issue #10 review): the ldapium baseline must be tied to VERSIONS.md and to
    # actual usage — healthy, stale (unused), and mismatched (VERSIONS.md changed) cases.
    healthy_errors = validate_baseline({"ghcr.io/dasomel/ldapium": "nightly-4e85165"}, {baselined_ref})
    if healthy_errors:
        raise ValueError(f"self-test regression: validate_baseline flagged a healthy baseline: {healthy_errors}")
    checked += 1

    stale_errors = validate_baseline({"ghcr.io/dasomel/ldapium": "nightly-4e85165"}, set())
    if not any("not found in any scanned" in e for e in stale_errors):
        raise ValueError(f"self-test regression: validate_baseline did not flag a stale (unused) baseline: {stale_errors}")
    checked += 1

    mismatch_errors = validate_baseline({"ghcr.io/dasomel/ldapium": "v1.0.0"}, {baselined_ref})
    if not any("VERSIONS.md now records" in e for e in mismatch_errors):
        raise ValueError(f"self-test regression: validate_baseline did not flag a VERSIONS.md/baseline mismatch: {mismatch_errors}")
    checked += 1

    return checked


def main() -> int:
    try:
        checked = self_test()
    except ValueError as exc:
        print(f"Image tag immutability self-test FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"Image tag immutability self-test OK: {checked} fixtures verified.", file=sys.stderr)

    print("=== Image tag immutability check (rendered manifests, DAGs, plain manifests) ===\n")

    all_findings: list[Finding] = []

    try:
        for label, chart, overrides in RENDER_COMBOS:
            print(f"Rendering {label}...")
            refs = extract_images_from_yaml(render(chart, overrides))
            require_nonempty(label, refs)
            print(f"  -> {len(refs)} image(s)")
            all_findings.extend(Finding(label, "ref", ref) for ref in refs)
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    dag_files = dag_paths()
    try:
        if not dag_files:
            raise RuntimeError("no Airflow DAG files found under gitops/**/dags/ — coverage silently vanished")
        for py_path in dag_files:
            label = f"dag:{rel(py_path)}"
            findings = scan_dag_images(py_path)
            require_nonempty(label, [f.value for f in findings])
            print(f"Scanning {label}... -> {len(findings)} image reference(s)")
            all_findings.extend(findings)
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    plain_files = plain_manifest_paths()
    for path in plain_files:
        refs = extract_images_from_yaml(path.read_text(encoding="utf-8"))
        if refs:
            print(f"Scanning plain:{rel(path)}... -> {len(refs)} image(s)")
        all_findings.extend(Finding(f"plain:{rel(path)}", "ref", ref) for ref in refs)

    rows, fail = evaluate(all_findings)
    print()
    print_table(rows)
    print()

    ref_values = {f.value for f in all_findings if f.kind == "ref"}
    baseline_errors = validate_baseline(parse_versions_md_refs(), ref_values)
    for err in baseline_errors:
        print(f"FAIL: {err}")
    if baseline_errors:
        fail = True

    baseline_count = sum(1 for status, _, _, _ in rows if status == "BASELINE")
    if baseline_count:
        print(f"{baseline_count} finding(s) accepted via documented baseline exception.")
    if fail:
        print(
            "\nOne or more images use a mutable/missing tag, are unverifiable, or a baseline entry "
            "is stale/mismatched. Pin to a concrete version or digest, resolve the unverifiable "
            "reference, or fix/refresh the documented baseline entry."
        )
        return 1
    print(
        f"OK: {len(rows)} finding(s) checked across {len(RENDER_COMBOS)} chart render(s), "
        f"{len(dag_files)} DAG file(s), and {len(plain_files)} plain manifest file(s) "
        "(all pinned by tag or digest, or documented baseline exception)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
