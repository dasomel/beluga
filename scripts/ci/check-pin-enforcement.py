#!/usr/bin/env python3
"""#103: Helm 차트 버전 + 컨테이너 이미지 고정(pin)을 fail-closed로 강제한다.

1) Helm 차트: scripts/ tests/ demo/ 셸의 원격 차트(`repo/chart`, `oci://`) 설치는 정확한
   버전(`--version X.Y.Z`)이 있어야 한다(없음/latest/범위/변수 모두 FAIL). ArgoCD Application의
   `chart:` 소스는 정확한 targetRevision, Chart.yaml dependencies는 정확한 version이어야 한다.
   `path:` 소스(이 저장소 자신의 차트, targetRevision HEAD)는 GitOps 자기 참조라 의도적으로 제외한다.
2) 이미지: 렌더된 차트/평문 매니페스트/Airflow DAG의 모든 이미지는 명시적 non-latest 태그여야 하며
   (분류는 check-image-tag-immutability.py를 재사용), digest 없는 저장소는 보고하되
   image-digest-baseline.yaml에 있는 것만 허용한다.

D1: 래칫 — 베이스라인 항목 수는 코드의 BASELINE_CEILING과 정확히 같아야 한다. 새 미고정 저장소는
베이스라인 추가(=천장 초과)가 필요해 코드 리뷰에서 드러나고, digest 고정으로 사라진 항목은
stale로 FAIL이라 반드시 삭제(=천장 하향)해야 한다. 탈출구: digest로 고정한 뒤 항목을 지우고 천장을 낮춘다.
"""
from __future__ import annotations

import importlib.util
import re
import shlex
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "image-digest-baseline.yaml"
BASELINE_CEILING = 19  # D1: 베이스라인 항목 수 == 이 값. 줄이기만 가능.
SHELL_DIRS = ("scripts", "tests", "demo")
EXACT_VERSION = re.compile(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
REMOTE_CHART = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*|oci://\S+")
HELM_CMD = re.compile(r"\bhelm\s+(upgrade|install|pull|template|show|fetch)\b")
BOOL_FLAGS = {"--install", "-i", "--create-namespace", "--wait", "--atomic", "--dry-run", "--devel", "--untar"}


def _load_immutability():
    spec = importlib.util.spec_from_file_location(
        "check_image_tag_immutability", Path(__file__).resolve().parent / "check-image-tag-immutability.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- helm charts
def check_shell_helm(rel: str, text: str) -> tuple[int, list[str]]:
    """Return (remote chart refs seen, errors) for one shell script."""
    seen, errors = 0, []
    joined = re.sub(r"\\\n", " ", text)
    for number, raw in enumerate(joined.splitlines(), 1):
        line = raw.strip()
        if line.startswith("#") or not HELM_CMD.search(line):
            continue
        try:
            tokens = shlex.split(line[HELM_CMD.search(line).start():], comments=True)
        except ValueError:
            continue
        chart, version, prev = None, None, ""
        for i, tok in enumerate(tokens):
            if tok == "--version" and i + 1 < len(tokens):
                version = tokens[i + 1]
            elif tok.startswith("--version="):
                version = tok.split("=", 1)[1]
            elif tok == "--devel":
                errors.append(f"{rel}:{number}: --devel selects pre-release charts (floating)")
            elif i >= 2 and chart is None and (prev not in BOOL_FLAGS and prev.startswith("-")) is False \
                    and not tok.startswith("-") and "$" not in tok and "=" not in tok and REMOTE_CHART.fullmatch(tok):
                chart = tok
            prev = tok
        if chart is None:
            continue
        seen += 1
        if version is None:
            errors.append(f"{rel}:{number}: helm chart {chart} has no --version (floating)")
        elif not EXACT_VERSION.fullmatch(version):
            errors.append(f"{rel}:{number}: helm chart {chart} version '{version}' is not an exact version")
    return seen, errors


def check_application(rel: str, doc: object) -> tuple[int, list[str]]:
    """Return (chart sources seen, errors) for one ArgoCD Application document."""
    if not isinstance(doc, dict) or doc.get("kind") != "Application":
        return 0, []
    spec = doc.get("spec") or {}
    sources = list(spec.get("sources") or []) + ([spec["source"]] if spec.get("source") else [])
    seen, errors = 0, []
    for src in sources:
        if not isinstance(src, dict) or "chart" not in src:
            continue
        seen += 1
        rev = str(src.get("targetRevision") or "")
        if not EXACT_VERSION.fullmatch(rev):
            errors.append(f"{rel}: chart '{src['chart']}' targetRevision '{rev}' is not an exact version")
    return seen, errors


def check_chart_yaml(rel: str, doc: object) -> tuple[int, list[str]]:
    deps = doc.get("dependencies") if isinstance(doc, dict) else None
    seen, errors = 0, []
    for dep in deps or []:
        seen += 1
        ver = str(dep.get("version") or "")
        if not EXACT_VERSION.fullmatch(ver):
            errors.append(f"{rel}: dependency '{dep.get('name')}' version '{ver}' is not an exact version")
    return seen, errors


def scan_charts() -> list[str]:
    errors, shell_refs, apps = [], 0, 0
    for d in SHELL_DIRS:
        for path in sorted((REPO_ROOT / d).rglob("*.sh")):
            n, errs = check_shell_helm(str(path.relative_to(REPO_ROOT)), path.read_text(encoding="utf-8"))
            shell_refs += n
            errors += errs
    for path in sorted((REPO_ROOT / "gitops" / "apps").glob("*.yaml")):
        for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            apps += 1 if isinstance(doc, dict) and doc.get("kind") == "Application" else 0
            errors += check_application(str(path.relative_to(REPO_ROOT)), doc)[1]
    charts = sorted((REPO_ROOT / "gitops" / "charts").glob("*/Chart.yaml"))
    for path in charts:
        errors += check_chart_yaml(str(path.relative_to(REPO_ROOT)), yaml.safe_load(path.read_text(encoding="utf-8")))[1]
    # fail closed on silently vanished coverage
    if shell_refs == 0:
        errors.append("no remote helm chart references found in shell scripts — coverage silently vanished")
    if apps == 0 or not charts:
        errors.append("no ArgoCD Applications / Chart.yaml found — coverage silently vanished")
    print(f"Helm pins: {shell_refs} remote chart ref(s) in shell, {apps} Application(s), {len(charts)} Chart.yaml")
    return errors


# --------------------------------------------------------------------- images
def load_baseline(path: Path = BASELINE_PATH) -> dict[str, str]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries = data.get("images") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError("baseline must contain an images list")
    out: dict[str, str] = {}
    for e in entries:
        if not isinstance(e, dict) or not e.get("repository") or not str(e.get("reason") or "").strip():
            raise ValueError("each baseline image needs repository and non-empty reason")
        if e["repository"] in out:
            raise ValueError(f"duplicate baseline repository: {e['repository']}")
        out[e["repository"]] = e["reason"]
    return out


def evaluate_images(refs: set[str], baseline: dict[str, str], ceiling: int, imm) -> list[str]:
    errors = []
    undigested: set[str] = set()
    for ref in sorted(refs):
        repo, tag, digest = imm.parse_ref(ref)
        status, why = imm.classify(ref)
        if status == "FAIL" and ref not in imm.KNOWN_MUTABLE_BASELINE:
            errors.append(f"image {ref}: {why}")
        if not digest:
            undigested.add(repo)
    for repo in sorted(undigested - baseline.keys()):
        errors.append(f"image {repo}: no digest and not in image-digest-baseline.yaml (new unpinned image)")
    for repo in sorted(baseline.keys() - undigested):
        errors.append(f"baseline {repo}: stale (now digest-pinned or gone) — delete it and lower BASELINE_CEILING")
    if len(baseline) != ceiling:
        errors.append(f"baseline has {len(baseline)} entries but BASELINE_CEILING is {ceiling}: "
                      "the baseline may only shrink (lower the ceiling in the same change)")
    return errors


def collect_refs(imm) -> set[str]:
    refs: set[str] = set()
    for _label, chart, overrides in imm.RENDER_COMBOS:
        found = imm.extract_images_from_yaml(imm.render(chart, overrides))
        if not found:
            raise RuntimeError(f"{chart}: rendered zero images — coverage silently vanished")
        refs.update(found)
    for path in imm.plain_manifest_paths():
        refs.update(imm.extract_images_from_yaml(path.read_text(encoding="utf-8")))
    for py in imm.dag_paths():
        for f in imm.scan_dag_images(py):
            if f.kind == "ref":
                refs.add(f.value)
            elif f.value not in imm.KNOWN_UNVERIFIABLE_BASELINE:
                raise RuntimeError(f"unverifiable DAG image reference {f.value}")
    return refs


# ------------------------------------------------------------------ self-test
def self_test(imm) -> int:
    def expect(cond: bool, msg: str) -> None:
        if not cond:
            raise ValueError(f"self-test failed: {msg}")

    pinned = 'helm upgrade --install x repo/chart \\\n  --namespace ns \\\n  --version 1.2.3 \\\n  --set a=b\n'
    expect(check_shell_helm("t.sh", pinned) == (1, []), "pinned chart should pass")
    for label, script in {
        "missing version": 'helm upgrade --install x repo/chart --namespace ns\n',
        "latest": 'helm install x repo/chart --version latest\n',
        "range": 'helm install x repo/chart --version "^1.2.0"\n',
        "wildcard": 'helm install x repo/chart --version 1.*\n',
        "variable": 'helm install x repo/chart --version "${V}"\n',
        "oci unpinned": 'helm install x oci://ghcr.io/o/chart\n',
        "devel": 'helm install x repo/chart --version 1.2.3 --devel\n',
    }.items():
        expect(check_shell_helm("t.sh", script)[1], f"helm {label} must fail")
    expect(check_shell_helm("t.sh", 'helm template x ./local -f values/a.yaml\n') == (0, []), "local chart ignored")
    expect(check_shell_helm("t.sh", 'helm template x "${ROOT}/charts/y" -f values/a.yaml\n') == (0, []), "var path ignored")

    app = lambda rev: {"kind": "Application", "spec": {"source": {"chart": "c", "repoURL": "https://r", "targetRevision": rev}}}
    expect(check_application("a.yaml", app("1.2.3"))[1] == [], "pinned Application chart should pass")
    for rev in ("", "HEAD", "*", "1.x", ">=1.0.0", "latest"):
        expect(check_application("a.yaml", app(rev))[1], f"Application targetRevision '{rev}' must fail")
    git_src = {"kind": "Application", "spec": {"source": {"path": "p", "targetRevision": "HEAD"}}}
    expect(check_application("a.yaml", git_src) == (0, []), "self-repo path source exempt")
    expect(check_chart_yaml("C.yaml", {"dependencies": [{"name": "d", "version": "~1.2.0"}]})[1], "dep range must fail")
    expect(check_chart_yaml("C.yaml", {"dependencies": [{"name": "d", "version": "1.2.0"}]})[1] == [], "dep exact ok")

    base = {"docker.io/a/b": "r"}
    ok = {"docker.io/a/b:1.0", "docker.io/c/d:2@sha256:" + "0" * 64}
    expect(evaluate_images(ok, base, 1, imm) == [], "baselined + digest image should pass")
    expect(any("latest" in e for e in evaluate_images(ok | {"x.io/f:latest"}, base | {"x.io/f": "r"}, 2, imm)), "latest must fail even if baselined")
    expect(any("no tag" in e or "missing tag" in e for e in evaluate_images(ok | {"x.io/g"}, base | {"x.io/g": "r"}, 2, imm)), "tagless must fail")
    expect(any("new unpinned" in e for e in evaluate_images(ok | {"x.io/n:1"}, base, 1, imm)), "new undigested repo must fail")
    expect(any("BASELINE_CEILING" in e for e in evaluate_images(ok | {"x.io/n:1"}, base | {"x.io/n": "r"}, 1, imm)),
           "baseline growth must fail against ceiling")
    expect(any("stale" in e for e in evaluate_images({"docker.io/a/b:1@sha256:" + "0" * 64}, base, 1, imm)), "stale entry must fail")
    expect(any("BASELINE_CEILING" in e for e in evaluate_images({"docker.io/a/b:1"}, base, 5, imm)), "ceiling must equal baseline size")
    return 0


def main() -> int:
    imm = _load_immutability()
    try:
        self_test(imm)
        print("Pin enforcement self-test OK", file=sys.stderr)
        errors = scan_charts()
        refs = collect_refs(imm)
        baseline = load_baseline()
        errors += evaluate_images(refs, baseline, BASELINE_CEILING, imm)
    except (ValueError, RuntimeError, OSError, yaml.YAMLError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    undigested = sorted({imm.parse_ref(r)[0] for r in refs if not imm.parse_ref(r)[2]})
    print(f"Images: {len(refs)} reference(s), {len(refs) - sum(1 for r in refs if not imm.parse_ref(r)[2])} digest-pinned, "
          f"{len(undigested)} repositories without digest (baselined ratchet):")
    for repo in undigested:
        print(f"  - {repo}")
    if errors:
        print("\nPin enforcement FAIL:")
        print("\n".join(f"- {e}" for e in errors))
        return 1
    print("Pin enforcement OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
