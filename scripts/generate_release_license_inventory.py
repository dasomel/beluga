#!/usr/bin/env python3
"""Write deterministic Markdown and JSON release license inventory artifacts."""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI_DIR = Path(__file__).resolve().parent / "ci"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


license_policy = load_module("check_license_policy", CI_DIR / "check-license-policy.py")
notice_check = load_module("check_notice_consistency", CI_DIR / "check-notice-consistency.py")

REPO_ROOT = Path(__file__).resolve().parents[1]


def load_policy(path: Path) -> tuple[set[str], str, dict[str, str]]:
    import yaml
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("license policy must be a mapping")
    approved = data.get("approved_licenses")
    marker = data.get("own_project_marker", {}).get("value") if isinstance(data.get("own_project_marker"), dict) else None
    classes = data.get("license_classifications")
    if not isinstance(approved, list) or not isinstance(marker, str) or not isinstance(classes, dict):
        raise ValueError("policy requires approved_licenses, own_project_marker.value, and license_classifications")
    if any(not isinstance(name, str) or not isinstance(value, str) or not value.strip()
           for name, value in classes.items()):
        raise ValueError("license_classifications must map license names to non-empty classifications")
    return set(approved), marker, classes


def build_inventory(versions_path: Path, notice_path: Path, policy_path: Path) -> list[dict]:
    approved, marker, classes = load_policy(policy_path)
    versions = license_policy.parse_versions_md(versions_path)
    apache, exceptions, siblings = notice_check.parse_notice(notice_path)
    notice_names = set(apache)
    notice_names.update(item[0] for item in exceptions)
    notice_names.update(item[0] for item in siblings)
    # Exact component-name matching avoids binding short project names to unrelated image paths.
    named_components = set()
    normalized_notice_names = {notice_check.strip_parenthetical(name) for name in notice_names}
    for component, _version, _image, _license_cell in versions:
        if component in notice_names or notice_check.strip_parenthetical(component) in normalized_notice_names:
            named_components.add(component)
    inventory = []
    for component, version, _image, license_cell in versions:
        parts = [license_policy.normalize_license_part(part) for part in license_cell.split(" / ")]
        if license_cell.startswith(marker):
            classification = "own-project"
        else:
            missing_classes = [part for part in parts if part not in classes]
            if missing_classes:
                raise ValueError(f"no license classification for {component}: {missing_classes!r}")
            # D3: classify a multi-license cell as dual even when each option is permissive;
            # this keeps release reviewers aware of the choice while allowing policy classes to evolve.
            classification = ("dual (" + "; ".join(dict.fromkeys(classes[part] for part in parts)) + ")"
                              if len(parts) > 1 else classes[parts[0]])
        if not license_cell.startswith(marker):
            unapproved = [part for part in parts if part not in approved]
            if unapproved:
                raise ValueError(f"unapproved license(s) for {component}: {unapproved!r}")
        # An explicit NOTICE attribution means that component requires bundled notice text.
        component_classes = [classes[part] for part in parts] if not license_cell.startswith(marker) else []
        if classification == "own-project":
            notice_obligation = "none (Beluga-owned)"
        elif any("weak-copyleft" in value or "strong-copyleft" in value for value in component_classes):
            notice_obligation = "license text + source availability"
        else:
            notice_obligation = "attribution + license text"
        inventory.append({"component": component, "version": version, "image_chart": _image,
                          "license": license_cell,
                          "license_policy_classification": classification,
                          "notice_obligation": notice_obligation,
                          "named_in_notice": component in named_components})
    return sorted(inventory, key=lambda item: item["component"].casefold())


def render_markdown(inventory: list[dict]) -> str:
    lines = ["# Release Third-Party License Inventory", "",
             "Generated from `VERSIONS.md`, `NOTICE`, and `policies/license-policy.yaml`.", "",
             "| Component | Version | Image / chart | License | Policy classification | NOTICE obligation | Named in NOTICE |",
             "|---|---|---|---|---|---|---|"]
    for item in inventory:
        values = [item["component"], item["version"], item["image_chart"], item["license"],
                  item["license_policy_classification"],
                  item["notice_obligation"], "Yes" if item["named_in_notice"] else "No"]
        lines.append("| " + " | ".join(value.replace("|", "\\|") for value in values) + " |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--versions", type=Path, default=REPO_ROOT / "VERSIONS.md")
    parser.add_argument("--notice", type=Path, default=REPO_ROOT / "NOTICE")
    parser.add_argument("--policy", type=Path, default=REPO_ROOT / "policies/license-policy.yaml")
    args = parser.parse_args()
    try:
        inventory = build_inventory(args.versions, args.notice, args.policy)
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "release-license-inventory.json").write_text(
            json.dumps(inventory, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        (args.out / "release-license-inventory.md").write_text(render_markdown(inventory), encoding="utf-8")
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"release license inventory FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"release license inventory PASS ({len(inventory)} components; output: {args.out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
