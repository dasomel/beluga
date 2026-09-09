#!/usr/bin/env python3
"""Deterministic repository verification for the current Beluga Manager foundation.

The application stack is intentionally not selected yet. This verifier therefore owns
checks that are real today: repository foundation files, bilingual documentation pairs,
language switchers, local Markdown links, and GitHub workflow structure.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import unquote

REQUIRED_FILES = (
    "README.md",
    "README-ko.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CONTRIBUTING-ko.md",
    "SECURITY.md",
    "SECURITY-ko.md",
    "CODE_OF_CONDUCT.md",
    "CODE_OF_CONDUCT-ko.md",
    ".gitignore",
    ".editorconfig",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/architecture.md",
    "docs/architecture-ko.md",
    "docs/development.md",
    "docs/development-ko.md",
)

LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:", "data:")


def user_facing_markdown(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*.md"):
        rel = path.relative_to(root)
        if any(part in {".git", ".github", ".agents", ".claude"} for part in rel.parts):
            continue
        if path.name in {"AGENTS.md", "CLAUDE.md"}:
            continue
        files.append(path)
    return sorted(files)


def validate_required_files(root: Path) -> list[str]:
    return [f"Missing required file: {name}" for name in REQUIRED_FILES if not (root / name).is_file()]


def validate_bilingual_pairs(root: Path) -> list[str]:
    errors: list[str] = []
    for path in user_facing_markdown(root):
        rel = path.relative_to(root)
        if path.name.endswith("-ko.md") or path.name == "README.md" or path.name == "LICENSE.md":
            continue
        korean = path.with_name(f"{path.stem}-ko.md")
        if not korean.is_file():
            errors.append(f"Missing Korean document: {korean.relative_to(root)} (for {rel})")
    return errors


def validate_language_switcher(root: Path) -> list[str]:
    errors: list[str] = []
    marker = "English |"
    korean_link = "README-ko.md"
    for name in ("README.md", "README-ko.md"):
        path = root / name
        if not path.is_file():
            continue
        head = "\n".join(path.read_text(encoding="utf-8").splitlines()[:2])
        if marker not in head or korean_link not in head:
            errors.append(f"Language switcher missing from first two lines: {name}")
    return errors


def normalize_link_target(raw: str) -> str:
    target = raw.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    elif " \"" in target:
        target = target.split(" \"", 1)[0]
    elif " '" in target:
        target = target.split(" '", 1)[0]
    return unquote(target.split("#", 1)[0].strip())


def validate_markdown_links(root: Path) -> list[str]:
    errors: list[str] = []
    resolved_root = root.resolve()
    for path in user_facing_markdown(root):
        text = path.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            raw = match.group(1).strip()
            if not raw or raw.startswith("#") or raw.lower().startswith(EXTERNAL_PREFIXES):
                continue
            target = normalize_link_target(raw)
            if not target:
                continue
            candidate = (path.parent / target).resolve()
            try:
                candidate.relative_to(resolved_root)
            except ValueError:
                errors.append(f"Local link escapes repository: {path.relative_to(root)} -> {raw}")
                continue
            if not candidate.exists():
                errors.append(f"Broken local link: {path.relative_to(root)} -> {raw}")
    return errors


def validate_workflows(root: Path) -> list[str]:
    errors: list[str] = []
    workflow_root = root / ".github" / "workflows"
    workflows = sorted(workflow_root.glob("*.yml")) + sorted(workflow_root.glob("*.yaml"))
    if not workflows:
        return ["No GitHub Actions workflow found"]
    for path in workflows:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(root)
        if not text.strip():
            errors.append(f"Empty workflow: {rel}")
            continue
        if not re.search(r"(?m)^name:\s*\S", text):
            errors.append(f"Workflow missing name: {rel}")
        if not re.search(r"(?m)^jobs:\s*$", text):
            errors.append(f"Workflow missing jobs: {rel}")
    return errors


def verify(root: Path) -> list[str]:
    errors: list[str] = []
    errors.extend(validate_required_files(root))
    errors.extend(validate_bilingual_pairs(root))
    errors.extend(validate_language_switcher(root))
    errors.extend(validate_markdown_links(root))
    errors.extend(validate_workflows(root))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    errors = verify(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("Beluga Manager repository verification: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
