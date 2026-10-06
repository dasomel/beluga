#!/usr/bin/env python3
"""Fail-closed gate for the security control-to-evidence map (Issue #50 static slice).

docs/security-control-evidence-map.md (and its -ko pair) hold two marker-delimited
pipe tables. This gate checks only that the map is internally consistent and points at
things that exist; it does not decide which controls are mandatory or who owns them.

1. Every backticked path in a control's verifier cell exists in the repository.
2. Every backticked Make target exists in the Makefile.
3. Every scripts/ci/check-*.py is mapped by a control or listed as out-of-scope with a reason.
4. Out-of-scope entries exist, are not also mapped, and carry a non-empty reason.
5. Status is implemented|partial|gap; gap rows cite no verifier or Make target, other rows cite at least one.
6. Every script/test verifier of a row that cites Make targets is invoked by the recipe of
   EVERY one of those targets (prerequisites, `$(MAKE) x` and tests/run-all.sh followed; echo text
   and comments do not count).
7. Verifier paths are relative, stay inside the repository and are not symlinks.
8. The Korean pair carries the same IDs, verifiers, Make targets, status and out-of-scope set.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOC = "docs/security-control-evidence-map.md"
DOC_KO = "docs/security-control-evidence-map-ko.md"
STATUSES = {"implemented", "partial", "gap"}
TICK = re.compile(r"`([^`]+)`")
TARGET = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?!=)", re.MULTILINE)
SECTIONS = {"controls": 6, "out-of-scope": 2}
HEADERS = {"controls": {"ID"}, "out-of-scope": {"Script", "스크립트"}}
RULE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)\s*([^#\n]*)$")
COMMENT = re.compile(r"(?:^|\s)#.*$")
ECHO = re.compile(r"\b(?:echo|printf)\b(?:\s+(?:\"[^\"]*\"|'[^']*'|[^&;|\n]*))?")


def section_rows(text: str, name: str, path: str) -> list[list[str]]:
    match = re.search(rf"<!-- {name}:start -->(.*?)<!-- {name}:end -->", text, re.DOTALL)
    if not match:
        raise ValueError(f"{path}: missing <!-- {name}:start/end --> markers")
    rows = []
    for line in match.group(1).splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            continue
        rows.append(cells)
    if not rows or rows[0][0] not in HEADERS[name]:
        raise ValueError(f"{path}: {name} table must start with its header row")
    for cells in rows:
        if len(cells) != SECTIONS[name]:
            raise ValueError(f"{path}: {name} row must have {SECTIONS[name]} columns: {cells[0]}")
    return rows[1:]


def join_continuations(text: str) -> str:
    """Join backslash-newline continuations into logical lines (before any exclusion is applied)."""
    return re.sub(r"\\\n[ \t]*", " ", text)


def recipe_text(root: Path, makefile: str, target: str, seen: set[str] | None = None) -> str:
    """Executable text of a target's recipe, following prerequisites, `$(MAKE) x` and run-all.sh."""
    seen = set() if seen is None else seen
    if target in seen:
        return ""
    seen.add(target)
    out: list[str] = []
    in_recipe = False
    deps: list[str] = []
    for line in join_continuations(makefile).splitlines():
        if line.startswith("\t"):
            if in_recipe:
                # Echo text first (it may hold `#`), then any ` #` starts a comment; over-stripping only false-FAILs.
                out.append(COMMENT.sub("", ECHO.sub(" ", line.strip())))
            continue
        if line.strip() and not line.lstrip().startswith("#"):
            rule = RULE.match(line)
            in_recipe = bool(rule and rule.group(1) == target)
            if in_recipe:
                deps += rule.group(2).split()
    text = "\n".join(out)
    deps += re.findall(r"\$\(MAKE\)(?:\s+-\S+)*\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)", text)
    if re.search(r"(?<![\w/.-])tests/run-all\.sh(?![\w.-])", text):
        run_all = (root / "tests/run-all.sh").read_text(encoding="utf-8")
        run_all = "\n".join(ln for ln in join_continuations(run_all).splitlines() if not ln.strip().startswith("#"))
        text += "\n" + ECHO.sub(" ", run_all).replace("${SCRIPT_DIR}/", "tests/")
    for dep in deps:
        text += "\n" + recipe_text(root, makefile, dep, seen)
    return text


def safe_file(root: Path, rel: str) -> bool:
    if os.path.isabs(rel) or ".." in Path(rel).parts:
        return False
    base = root.resolve()
    cand = base / rel
    return cand.resolve() == Path(os.path.normpath(cand)) and cand.is_file() and not cand.is_symlink()


def parse(root: Path, rel: str):
    text = (root / rel).read_text(encoding="utf-8")
    controls = {}
    for cid, _area, verifiers, make, _evidence, status in section_rows(text, "controls", rel):
        if cid in controls:
            raise ValueError(f"{rel}: duplicate control id {cid}")
        controls[cid] = (TICK.findall(verifiers), TICK.findall(make), status.strip("` "))
    out_of_scope = {}
    for script, reason in section_rows(text, "out-of-scope", rel):
        names = TICK.findall(script)
        if len(names) != 1:
            raise ValueError(f"{rel}: out-of-scope entry must name exactly one script: {script}")
        out_of_scope[names[0]] = reason
    return controls, out_of_scope


def check(root: Path = REPO_ROOT) -> None:
    controls, out_of_scope = parse(root, DOC)
    if not controls:
        raise ValueError(f"{DOC}: no controls")
    makefile = (root / "Makefile").read_text(encoding="utf-8")
    targets = set(TARGET.findall(makefile))
    mapped: set[str] = set()
    for cid, (verifiers, make, status) in controls.items():
        if status not in STATUSES:
            raise ValueError(f"{cid}: invalid status {status!r}")
        if status == "gap" and (verifiers or make):
            raise ValueError(f"{cid}: gap control must not cite a verifier or Make target")
        if status != "gap" and not verifiers:
            raise ValueError(f"{cid}: {status} control cites no verifier")
        for path in verifiers:
            if not safe_file(root, path):
                raise ValueError(f"{cid}: referenced file does not exist or is unsafe: {path}")
            mapped.add(path)
        for target in make:
            if target not in targets:
                raise ValueError(f"{cid}: Make target does not exist: {target}")
        recipes = {target: recipe_text(root, makefile, target) for target in make}
        for path in verifiers:
            if not make or path.startswith(".github/"):
                continue
            pattern = rf"(?<![\w/.-]){re.escape(path)}(?![\w.-])"
            missing = [t for t in make if not re.search(pattern, recipes[t])]
            if len(missing) == len(make):
                raise ValueError(f"{cid}: {path} is not run by any claimed Make target ({', '.join(make)})")
            if missing:
                raise ValueError(
                    f"{cid}: {path} is not run by claimed Make target(s) {', '.join(missing)}; "
                    f"claim only the targets that run it")
    for script, reason in out_of_scope.items():
        if not reason.strip():
            raise ValueError(f"out-of-scope {script}: reason is empty")
        if not (root / script).is_file():
            raise ValueError(f"out-of-scope script does not exist: {script}")
        if script in mapped:
            raise ValueError(f"{script} is both mapped and out-of-scope")
    gates = {p.relative_to(root).as_posix() for p in (root / "scripts/ci").glob("check-*.py")}
    unmapped = sorted(gates - mapped - set(out_of_scope))
    if unmapped:
        raise ValueError(f"gate scripts neither mapped nor out-of-scope: {', '.join(unmapped)}")

    ko_controls, ko_scope = parse(root, DOC_KO)
    if ko_controls != controls:
        raise ValueError(f"{DOC_KO}: controls (id/verifier/make/status) differ from {DOC}")
    if set(ko_scope) != set(out_of_scope) or not all(r.strip() for r in ko_scope.values()):
        raise ValueError(f"{DOC_KO}: out-of-scope set or reasons differ from {DOC}")


def main() -> int:
    try:
        check()
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Control evidence map FAIL: {error}", file=sys.stderr)
        return 1
    controls, _ = parse(REPO_ROOT, DOC)
    counts = {s: sum(1 for c in controls.values() if c[2] == s) for s in sorted(STATUSES)}
    print(f"Control evidence map OK: {len(controls)} controls {counts}; every check-*.py accounted for")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
