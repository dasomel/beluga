#!/usr/bin/env python3
"""#103: Helm 차트 버전 + 컨테이너 이미지 고정(pin)을 fail-closed로 강제한다.

1) Helm 차트: scripts/ tests/ demo/ 셸의 원격 차트(`repo/chart`, `oci://`) 설치는 정확한
   버전(`--version X.Y.Z`)이 있어야 한다(없음/latest/범위/변수 모두 FAIL). ArgoCD Application의
   `chart:` 소스는 정확한 targetRevision, Chart.yaml dependencies는 정확한 version이어야 한다.
   `path:` 소스(이 저장소 자신의 차트, targetRevision HEAD)는 GitOps 자기 참조라 의도적으로 제외한다.
2) 이미지: 렌더된 차트/평문 매니페스트/Airflow DAG의 모든 이미지는 명시적 non-latest 태그여야 하며
   (분류는 check-image-tag-immutability.py를 재사용), digest 없는 저장소는 보고하되
   image-digest-baseline.yaml에 있는 것만 허용한다.

D3: 환경변수 PIN_BASE_REF(예: origin/main)가 있으면 베이스 ref의 베이스라인/천장 대비 증가를 FAIL한다.
없으면 명시적으로 skip(로컬 실행 보호). CI는 PR 베이스 ref를 PIN_BASE_REF로 넘겨야 한다
(.github/workflows/ci.yml env 연결은 후속 — release.yml 소유 레인과 충돌 회피).

D1: 래칫 — 베이스라인 항목 수는 코드의 BASELINE_CEILING과 정확히 같아야 한다. 새 미고정 저장소는
베이스라인 추가(=천장 초과)가 필요해 코드 리뷰에서 드러나고, digest 고정으로 사라진 항목은
stale로 FAIL이라 반드시 삭제(=천장 하향)해야 한다. 탈출구: digest로 고정한 뒤 항목을 지우고 천장을 낮춘다.
"""
from __future__ import annotations

import importlib.util
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "image-digest-baseline.yaml"
MIN_SHELL_CHART_REFS, MIN_APPLICATIONS, MIN_CHART_YAMLS = 3, 3, 2  # D2: cilium+metallb+flink; 3 Applications; 2 charts
BASELINE_CEILING = 19  # D1: 베이스라인 항목 수 == 이 값. 줄이기만 가능.
SHELL_DIRS = ("scripts", "tests", "demo")
EXACT_VERSION = re.compile(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
REMOTE_CHART = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*|oci://\S+")
HELM_CMD = re.compile(r"(?:^|[;&|(]\s*|\bthen\s+|\bif\s+!?\s*)(?:sudo\s+)?(?P<h>helm)\s+(?:upgrade|install|pull|template|show|fetch)\b")
BOOL_FLAGS = {"--install", "-i", "--create-namespace", "--wait", "--atomic", "--dry-run", "--devel", "--untar"}


def _load_immutability():
    spec = importlib.util.spec_from_file_location(
        "check_image_tag_immutability", Path(__file__).resolve().parent / "check-image-tag-immutability.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- helm charts
LOCAL_VAR_PATH = re.compile(r"\$\{?[A-Za-z_]*(?:ROOT|DIR)\}?/")


def _positionals(tokens: list[str]) -> list[str]:
    out, skip = [], False
    for tok in tokens:
        if skip:
            skip = False
        elif tok.startswith("-"):
            skip = "=" not in tok and tok not in BOOL_FLAGS
        else:
            out.append(tok)
    return out


def check_shell_helm(rel: str, text: str, root: Path = REPO_ROOT) -> tuple[int, list[str]]:
    """Return (remote chart refs seen, errors) for one shell script. Anything unparsable fails closed."""
    seen, errors = 0, []
    joined = re.sub(r"\\\n", " ", text)
    for number, raw in enumerate(joined.splitlines(), 1):
        line = raw.strip()
        match = HELM_CMD.search(line)
        if line.startswith("#") or not match:
            continue
        try:
            tokens = shlex.split(line[match.start('h'):], comments=True)
        except ValueError as exc:
            errors.append(f"{rel}:{number}: unparsable helm command ({exc}) — cannot verify chart pin")
            continue
        version = None
        for i, tok in enumerate(tokens):
            if tok == "--version" and i + 1 < len(tokens):
                version = tokens[i + 1]
            elif tok.startswith("--version="):
                version = tok.split("=", 1)[1]
            elif tok == "--devel":
                errors.append(f"{rel}:{number}: --devel selects pre-release charts (floating)")
        pos = _positionals(tokens[1:])
        idx = 1 if pos[0] in ("pull", "fetch") else 2
        if len(pos) <= idx:
            continue
        chart = pos[idx]
        if REMOTE_CHART.fullmatch(chart) and not (root / chart).is_dir():
            seen += 1
            if version is None:
                errors.append(f"{rel}:{number}: helm chart {chart} has no --version (floating)")
            elif not EXACT_VERSION.fullmatch(version):
                errors.append(f"{rel}:{number}: helm chart {chart} version '{version}' is not an exact version")
        elif "$" in chart and not LOCAL_VAR_PATH.match(chart):
            errors.append(f"{rel}:{number}: helm chart '{chart}' is variable-built — cannot verify it is local or pinned")
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


def scan_charts(root: Path = REPO_ROOT, mins: tuple[int, int, int] = (MIN_SHELL_CHART_REFS, MIN_APPLICATIONS, MIN_CHART_YAMLS)) -> list[str]:
    errors, shell_refs, apps = [], 0, 0
    for d in SHELL_DIRS:
        for path in sorted((root / d).rglob("*.sh")):
            n, errs = check_shell_helm(str(path.relative_to(root)), path.read_text(encoding="utf-8"), root)
            shell_refs += n
            errors += errs
    app_files = sorted(p for ext in ("*.yaml", "*.yml") for p in (root / "gitops" / "apps").rglob(ext))
    for path in app_files:
        for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            apps += 1 if isinstance(doc, dict) and doc.get("kind") == "Application" else 0
            errors += check_application(str(path.relative_to(root)), doc)[1]
    charts = sorted(p for ext in ("Chart.yaml", "Chart.yml") for p in (root / "gitops" / "charts").rglob(ext))
    for path in charts:
        errors += check_chart_yaml(str(path.relative_to(root)), yaml.safe_load(path.read_text(encoding="utf-8")))[1]
    # fail closed on silently vanished coverage (D2: minimums are the counts known at #103 landing)
    for label, got, minimum in (("remote helm chart refs in shell", shell_refs, mins[0]),
                                ("ArgoCD Applications", apps, mins[1]), ("Chart.yaml files", len(charts), mins[2])):
        if got < minimum:
            errors.append(f"only {got} {label} found, expected at least {minimum} — coverage silently vanished")
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


def check_base_growth(base_repos: set[str] | None, base_ceiling: int | None, cur_repos: set[str], cur_ceiling: int) -> list[str]:
    """Pure: baseline entries/ceiling must not grow relative to the base ref."""
    if base_repos is None or base_ceiling is None:
        return []
    errors = [f"baseline entry {r} was added relative to base ref (baseline may only shrink)" for r in sorted(cur_repos - base_repos)]
    if cur_ceiling > base_ceiling:
        errors.append(f"BASELINE_CEILING grew from {base_ceiling} to {cur_ceiling} relative to base ref")
    return errors


def base_growth_errors(ref: str | None) -> list[str]:
    if not ref:
        print("Baseline growth vs base ref: SKIPPED (PIN_BASE_REF not set)")
        return []
    def show(path: str) -> str | None:
        r = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=REPO_ROOT, capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else None
    base_yaml, base_py = show("scripts/ci/image-digest-baseline.yaml"), show("scripts/ci/check-pin-enforcement.py")
    if base_yaml is None or base_py is None:
        if subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=REPO_ROOT, capture_output=True).returncode != 0:
            return [f"PIN_BASE_REF '{ref}' is not a valid ref — cannot verify the ratchet"]
        print(f"Baseline growth vs base ref: SKIPPED (gate not present at {ref}; first introduction)")
        return []
    m = re.search(r"^BASELINE_CEILING = (\d+)", base_py, re.M)
    if not m:
        return [f"cannot read BASELINE_CEILING at {ref}"]
    base_repos = {e["repository"] for e in yaml.safe_load(base_yaml).get("images", [])}
    print(f"Baseline growth vs base ref {ref}: checked ({len(base_repos)} base entries)")
    return check_base_growth(base_repos, int(m.group(1)), set(load_baseline()), BASELINE_CEILING)


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
    expect(check_shell_helm("t.sh", 'helm install x repo/chart --version=1.2.3\n') == (1, []), "--version= exact should pass")
    expect(check_shell_helm("t.sh", 'helm install x repo/chart --version=latest\n')[1], "--version=latest must fail")
    expect(check_shell_helm("t.sh", "helm install x repo/chart --version '1.2.3\n")[1], "unparsable line must fail closed")
    expect(check_shell_helm("t.sh", 'helm install x "$CHART" --version 1.2.3\n')[1], "variable chart must fail")
    expect(check_shell_helm("t.sh", 'helm install x "${REPO}/c" --version 1.2.3\n')[1], "non-ROOT variable path must fail")
    expect(check_shell_helm("t.sh", 'helm pull repo/chart\n')[1], "helm pull unpinned must fail")
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

    with tempfile.TemporaryDirectory(prefix="pin-selftest-") as tmp:
        t = Path(tmp)
        (t / "scripts").mkdir()
        (t / "scripts" / "ok.sh").write_text("helm install x repo/chart --version 1.2.3\n")
        nested = t / "gitops" / "apps" / "deep" / "er"
        nested.mkdir(parents=True)
        (nested / "bad.yml").write_text("kind: Application\nspec:\n  source:\n    chart: c\n    targetRevision: '*'\n")
        sub = t / "gitops" / "charts" / "a" / "charts" / "b"
        sub.mkdir(parents=True)
        (sub / "Chart.yaml").write_text("dependencies:\n- name: d\n  version: '^1.0.0'\n")
        errs = scan_charts(t, (1, 1, 1))
        expect(any("bad.yml" in e for e in errs), "nested .yml Application must be scanned")
        expect(any("Chart.yaml" in e for e in errs), "nested Chart.yaml must be scanned")
        expect(any("coverage silently vanished" in e for e in scan_charts(t, (2, 1, 1))), "min count above found must fail")
        good = t / "baseline.yaml"
        good.write_text("images:\n- repository: a/b\n  reason: why\n")
        expect(load_baseline(good) == {"a/b": "why"}, "baseline loads")
        for label, body in {"no reason": "images:\n- repository: a/b\n", "dup": "images:\n- {repository: a, reason: r}\n- {repository: a, reason: r}\n",
                            "not list": "images: x\n"}.items():
            good.write_text(body)
            try:
                load_baseline(good)
            except ValueError:
                continue
            raise ValueError(f"self-test failed: baseline {label} must be rejected")
    expect(check_base_growth({"a"}, 1, {"a"}, 1) == [], "unchanged vs base ok")
    expect(check_base_growth({"a", "b"}, 2, {"a"}, 1) == [], "shrink vs base ok")
    expect(check_base_growth({"a"}, 1, {"a", "n"}, 1), "new entry vs base must fail")
    expect(check_base_growth({"a"}, 1, {"a"}, 2), "ceiling growth vs base must fail")
    expect(check_base_growth(None, None, {"a"}, 9) == [], "no base: skipped")

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
        errors += base_growth_errors(os.environ.get("PIN_BASE_REF"))
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
