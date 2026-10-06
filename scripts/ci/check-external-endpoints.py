#!/usr/bin/env python3
"""Issue #36 static slice: inventory + ratchet of external network dependencies (stdlib + PyYAML).

Derives, ONLY from this repository, the external hosts that install/deploy/run-time code reaches
and diffs the (host, phase) set against scripts/ci/external-endpoints-baseline.yaml.
Inclusion in the baseline is an inventory FACT, never an approval, and this gate defines no
restricted-profile allowlist or per-data-class residency (those are open policy decisions).

Sources (a phase is derived from the file path):
  host-install     Vagrantfile, Makefile, scripts/**/*.sh except scripts/gitops/
  deploy-bootstrap scripts/gitops/**/*.sh
  gitops-sync      gitops/apps/** (ArgoCD Application repoURL / chart repos)
  pod-runtime      gitops/charts/** non-image URLs and pip installs run inside pods
  image-registry   registry host of every `image` in `helm template` of both charts (the
                   check-image-tag-immutability.py render combos) and Airflow DAG image=
  demo-build       demo/**/Dockerfile* (FROM registry, pip)
Excluded: .github/workflows (CI-only, not a platform dependency), scripts/*.py / scripts/ci /
scripts/release / research (developer and CI tooling), docs and tests.

D1 (extraction is deliberately conservative and line based): a line is skipped when it is a
comment, an echo/printf/log_*/print message, or the URL host is internal (no dot, localhost, an
IP, *.svc, *.cluster.local, *.beluga.internal) or templated ($, {, <, trailing dot). Implicit
endpoints without a literal URL are mapped by fixed rules: a Python package install -> pypi.org +
files.pythonhosted.org, an apt package install/update -> apt-os-mirrors (reserved non-hostname placeholder, D2),
config.vm.box -> app.vagrantup.com, a bare image name -> docker.io.
Known limits (cost of D1): a URL inside a heredoc or string that merely documents a host can still
match; a host assembled from variables is invisible; hosts that upstream manifests, charts or the
installer scripts themselves contact (get-helm-3, k3s, Strimzi/cert-manager/Argo CD images, ...)
are NOT derivable from this repo. Escape hatch for a false positive: fix the line so it is a
comment/echo, or add the baseline entry with a reason (the diff is reviewed).

Ratchet: a (host, phase) found but not in the baseline FAILS; a baseline entry no longer found
FAILS too (stale; delete it so the list only shrinks, like image-digest-baseline.yaml); a baseline
host missing from either docs/external-dependencies*.md FAILS. `--report` prints the evidence.
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "external-endpoints-baseline.yaml"
DOCS = ("docs/external-dependencies.md", "docs/external-dependencies-ko.md")
PHASES = ("host-install", "deploy-bootstrap", "gitops-sync", "pod-runtime", "image-registry", "demo-build")

# optional userinfo is skipped so `https://user@evil.example.net/` yields the real host, not `user`;
# greedy up to the LAST `@` of the authority (RFC 3986 / curl), and an empty userinfo (`https://@host`) still matches
URL = re.compile(r"(?:https?|ftp|ssh)://(?:[^/\s?#]*@)?([A-Za-z0-9][A-Za-z0-9.-]*)")
GIT_SSH = re.compile(r"\bgit@([A-Za-z0-9][A-Za-z0-9.-]*):")
HOST_OK = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
# D2: reserved NON-hostname placeholders for implicit endpoints whose real host is not derivable from
# the repo (apt mirrors come from the OS sources). Only these may appear in the baseline without a dot.
IMPLICIT_PSEUDO_HOSTS = frozenset({"apt-os-mirrors"})
SOURCE_ROOTS = (("scripts", "scripts/**/*.sh"), ("gitops/apps", "gitops/apps/**/*"),
                ("gitops/charts", "gitops/charts/**/*"), ("demo", "demo/**/Dockerfile*"))
IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
INTERNAL_SUFFIXES = (".svc", ".cluster.local", ".beluga.internal")
MESSAGE_LINE = re.compile(r"^\s*@?(?:echo|printf|log_\w+|print)\b")
TRAILING_COMMENT = re.compile(r"\s#.*$")
MESSAGE_ARG = re.compile(r"\b(?:echo|printf|log_\w+)\s+(?:\"[^\"]*\"|'[^']*')")
IMPLICIT_RULES = (
    (re.compile(r"\b(?:pip3?|uv\s+pip)\s+install\b"), ("pypi.org", "files.pythonhosted.org")),
    (re.compile(r"\bapt(?:-get)?\s+(?:-\S+\s+)*(?:install|update)\b"), ("apt-os-mirrors",)),
)
VAGRANT_BOX = re.compile(r"^\s*config\.vm\.box\s*=")
DOCKER_FROM = re.compile(r"^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?", re.IGNORECASE)


def _load_immutability():
    spec = importlib.util.spec_from_file_location(
        "check_image_tag_immutability", Path(__file__).resolve().parent / "check-image-tag-immutability.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_baseline(path: Path) -> dict[tuple[str, str], str]:
    """Parse and strictly validate the baseline; raises ValueError (fail closed) on any defect."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise ValueError(f"{path}: invalid YAML: {error}") from error
    if not isinstance(data, dict) or set(data) != {"endpoints"} or not isinstance(data["endpoints"], list):
        raise ValueError(f"{path}: must be a mapping with exactly one key 'endpoints' holding a list")
    entries: dict[tuple[str, str], str] = {}
    for index, item in enumerate(data["endpoints"], 1):
        if not isinstance(item, dict) or set(item) != {"host", "phase", "reason"}:
            raise ValueError(f"{path}: endpoint #{index} must be a mapping with exactly host, phase, reason")
        host, phase, reason = item["host"], item["phase"], item["reason"]
        if not all(isinstance(v, str) for v in (host, phase, reason)):
            raise ValueError(f"{path}: endpoint #{index} fields must be strings")
        if host not in IMPLICIT_PSEUDO_HOSTS and not HOST_OK.fullmatch(host):
            raise ValueError(f"{path}: endpoint #{index} invalid host {host!r} "
                             f"(lowercase dotted hostname or a reserved implicit placeholder: {', '.join(sorted(IMPLICIT_PSEUDO_HOSTS))})")
        if phase not in PHASES:
            raise ValueError(f"{path}: endpoint #{index} unknown phase {phase!r}; expected one of {', '.join(PHASES)}")
        if not reason.strip():
            raise ValueError(f"{path}: endpoint #{index} ({host}) has an empty reason")
        if (host, phase) in entries:
            raise ValueError(f"{path}: duplicate entry for {host} in phase {phase}")
        entries[(host, phase)] = reason
    if not entries:
        raise ValueError(f"{path}: empty endpoint list")
    return entries


def is_internal(host: str) -> bool:
    return (host == "localhost" or "." not in host or bool(IPV4.fullmatch(host))
            or host.endswith(INTERNAL_SUFFIXES))


def registry_of(ref: str) -> str:
    """Registry host of an image reference; a bare/namespaced name is Docker Hub."""
    first = ref.split("/", 1)[0] if "/" in ref else ""
    if first and ("." in first or ":" in first or first == "localhost"):
        return first.split(":", 1)[0].lower()
    return "docker.io"


def phase_for(rel: str) -> str:
    if rel.startswith("scripts/gitops/"):
        return "deploy-bootstrap"
    if rel.startswith("gitops/apps/"):
        return "gitops-sync"
    if rel.startswith("gitops/"):
        return "pod-runtime"
    if rel.startswith("demo/"):
        return "demo-build"
    return "host-install"


def code_lines(text: str):
    """Yield (lineno, line) with comments, trailing comments and quoted echo/printf/log_* messages removed."""
    for number, raw in enumerate(text.splitlines(), 1):
        if raw.lstrip().startswith("#") or MESSAGE_LINE.match(raw):
            continue
        yield number, MESSAGE_ARG.sub(" ", TRAILING_COMMENT.sub("", raw))


def scan_text(rel: str, text: str) -> list[tuple[str, str, str]]:
    """Return (host, phase, 'rel:line') hits for one file's text."""
    phase, hits = phase_for(rel), []
    stages: set[str] = set()
    for number, line in code_lines(text):
        where = f"{rel}:{number}"
        for match in URL.finditer(line):
            host = match.group(1).lower()
            following = line[match.end():match.end() + 1]
            if host.endswith(".") or ".." in host or following in ("$", "{", "<") or is_internal(host):
                continue
            hits.append((host, phase, where))
        for match in GIT_SSH.finditer(line):
            host = match.group(1).lower()
            if not (host.endswith(".") or ".." in host or is_internal(host)):
                hits.append((host, phase, where))
        for pattern, hosts in IMPLICIT_RULES:
            if pattern.search(line):
                hits += [(host, phase, where) for host in hosts]
        if rel == "Vagrantfile" and VAGRANT_BOX.match(line):
            hits.append(("app.vagrantup.com", phase, where))
        if Path(rel).name.startswith("Dockerfile"):
            match = DOCKER_FROM.match(line)
            if match and match.group(1).lower() != "scratch" and match.group(1) not in stages:
                hits.append((registry_of(match.group(1)), phase, where))
            if match and match.group(2):
                stages.add(match.group(2))
    return hits


def source_files(root: Path) -> list[Path]:
    files: list[Path] = [p for p in (root / "Vagrantfile", root / "Makefile") if p.is_file()]
    for name, pattern in SOURCE_ROOTS:
        found = [p for p in sorted(root.glob(pattern)) if p.is_file() and not p.is_symlink()]
        if not found:
            raise ValueError(f"source root {name}/ is missing or yields zero files "
                             f"(pattern {pattern}); coverage would silently vanish")
        files += found
    return files


def scan_repo(root: Path) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = {}
    for path in source_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for host, phase, where in scan_text(path.relative_to(root).as_posix(), text):
            found.setdefault((host, phase), []).append(where)
    return found


def locate(root: Path, ref: str) -> str:
    """Best-effort 'path:line' of an image ref in chart/DAG sources (the render has no line numbers)."""
    repo = ref.rsplit(":", 1)[0] if ":" in ref.rsplit("/", 1)[-1] else ref
    for needle in (ref, repo):
        for path in sorted((root / "gitops").glob("**/*")):
            if path.is_file() and not path.is_symlink():
                try:
                    lines = path.read_text(encoding="utf-8").splitlines()
                except UnicodeDecodeError:
                    continue
                for number, line in enumerate(lines, 1):
                    if needle in line and not line.lstrip().startswith("#"):
                        return f"{path.relative_to(root).as_posix()}:{number}"
    return "rendered chart"


def image_hits(root: Path, refs: list[str]) -> dict[tuple[str, str], list[str]]:
    found: dict[tuple[str, str], list[str]] = {}
    for ref in sorted(set(refs)):
        found.setdefault((registry_of(ref), "image-registry"), []).append(f"{locate(root, ref)} ({ref})")
    return found


def rendered_image_refs() -> list[str]:
    imm = _load_immutability()
    refs: list[str] = []
    for label, chart, overrides in imm.RENDER_COMBOS:
        found = imm.extract_images_from_yaml(imm.render(chart, overrides))
        if not found:
            raise RuntimeError(f"{label}: render produced no images (coverage silently vanished)")
        refs += found
    dags = imm.dag_paths()
    if not dags:
        raise RuntimeError("no Airflow DAG files found under gitops/**/dags/ (coverage silently vanished)")
    for path in dags:
        refs += [f.value for f in imm.scan_dag_images(path) if f.kind == "ref"]
    return [ref for ref in refs if not is_internal(registry_of(ref))]


def compare(found: dict[tuple[str, str], list[str]], baseline: dict[tuple[str, str], str]) -> list[str]:
    errors = []
    for key in sorted(set(found) - set(baseline)):
        errors.append(f"NEW external endpoint {key[0]} (phase {key[1]}) not in {BASELINE_PATH.name}: "
                      f"{', '.join(found[key][:3])}. Review, then add an entry with a reason (inventory fact, not approval).")
    for key in sorted(set(baseline) - set(found)):
        errors.append(f"STALE baseline entry {key[0]} (phase {key[1]}) is no longer referenced; delete it.")
    return errors


def check_docs(root: Path, baseline: dict[tuple[str, str], str]) -> list[str]:
    errors = []
    for doc in DOCS:
        path = root / doc
        if not path.is_file():
            errors.append(f"{doc}: missing")
            continue
        text = path.read_text(encoding="utf-8")
        errors += [f"{doc}: host `{host}` from the baseline is not documented"
                   for host in sorted({h for h, _ in baseline}) if f"`{host}`" not in text]
    return errors


def collect(root: Path, refs: list[str]) -> dict[tuple[str, str], list[str]]:
    found = scan_repo(root)
    for key, where in image_hits(root, refs).items():
        found.setdefault(key, []).extend(where)
    return found


def evaluate(root: Path, baseline_path: Path, refs: list[str]) -> tuple[list[str], dict]:
    baseline = load_baseline(baseline_path)
    found = collect(root, refs)
    return compare(found, baseline) + check_docs(root, baseline), found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", action="store_true", help="print phase, host and evidence as tab-separated rows")
    args = parser.parse_args()
    try:
        refs = rendered_image_refs()
        if args.report:
            found = collect(REPO_ROOT, refs)
            errors: list[str] = []
        else:
            errors, found = evaluate(REPO_ROOT, BASELINE_PATH, refs)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"External endpoints FAIL: {error}", file=sys.stderr)
        return 1
    if args.report:
        for (host, phase), where in sorted(found.items(), key=lambda kv: (PHASES.index(kv[0][1]), kv[0][0])):
            print(f"{phase}\t{host}\t{'; '.join(sorted(set(where)))}")
        return 0
    if errors:
        print("External endpoints FAIL:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    hosts = {h for h, _ in found}
    print(f"External endpoints OK: {len(hosts)} hosts / {len(found)} (host, phase) pairs match the baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
