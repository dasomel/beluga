#!/usr/bin/env python3
"""Build and offline-verify the Beluga release evidence bundle (Issue #100).

Bundle = CycloneDX SBOM + release license inventory + declared-state platform asset
inventory (#42) + NOTICE + LICENSE + manifest.json (version, commit) + SHA256SUMS over
every other file. `verify` needs
no network, but does need a checkout of the release commit: it recomputes
checksums, cross-checks the manifest, SBOM and inventory, and requires the shipped
NOTICE/LICENSE and the SBOM's VERSIONS.md components to match that checkout. The asset
inventory is NOT regenerated at verify time (that needs helm at the CI-pinned version, and
other versions may render differently): verify checks its shape and that the shipped
Markdown is exactly the generator's rendering of the shipped JSON.
Fail closed: a missing, extra, altered or
unparsable file fails.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SUMS = "SHA256SUMS"
MANIFEST = "manifest.json"
SBOM = "sbom.cdx.json"
INV_JSON = "release-license-inventory.json"
INV_MD = "release-license-inventory.md"
ASSET_JSON = "platform-asset-inventory.json"
ASSET_MD = "platform-asset-inventory.md"
NOTICE_NAME = "NOTICE"
LICENSE_NAME = "LICENSE"
REQUIRED = (MANIFEST, SBOM, INV_JSON, INV_MD, ASSET_JSON, ASSET_MD, NOTICE_NAME, LICENSE_NAME)
VERSION_RE = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
SUM_LINE_RE = re.compile(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)")


class EvidenceError(ValueError):
    pass


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / rel)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_identity(version: str, commit: str) -> None:
    if not VERSION_RE.fullmatch(version):
        raise EvidenceError(f"version {version!r} is not vMAJOR.MINOR.PATCH")
    if not COMMIT_RE.fullmatch(commit):
        raise EvidenceError(f"commit {commit!r} is not a 40-hex sha")


def build(out: Path, version: str, commit: str, versions_md: Path, notice: Path, policy: Path,
          rendered: str | None = None, license_file: Path = REPO_ROOT / "LICENSE",
          asset_inventory: dict | None = None) -> None:
    check_identity(version, commit)
    sbom_mod = _load("release_generate_sbom", "scripts/release/generate_sbom.py")
    inv_mod = _load("release_license_inventory", "scripts/generate_release_license_inventory.py")
    # Gate order matters: any failure aborts before a bundle exists (no partial evidence).
    inventory = inv_mod.build_inventory(versions_md, notice, policy)  # raises on unapproved license
    bom = sbom_mod.build_bom(version, commit, versions_md, policy,
                             rendered if rendered is not None else sbom_mod.render_charts())
    # Same generator functions as the committed docs/drift gate; renders both charts via helm (CI pin v3.16.4).
    asset_mod = _load("release_asset_inventory", "scripts/generate_platform_asset_inventory.py")
    if asset_inventory is None:
        asset_inventory = asset_mod.build_inventory(versions_md.parent)
    out.mkdir(parents=True, exist_ok=True)
    (out / NOTICE_NAME).write_bytes(notice.read_bytes())
    (out / LICENSE_NAME).write_bytes(license_file.read_bytes())
    (out / SBOM).write_text(json.dumps(bom, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / INV_JSON).write_text(json.dumps(inventory, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / INV_MD).write_text(inv_mod.render_markdown(inventory), encoding="utf-8")
    (out / ASSET_JSON).write_text(json.dumps(asset_inventory, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / ASSET_MD).write_text(asset_mod.render_markdown_en(asset_inventory), encoding="utf-8")
    (out / MANIFEST).write_text(json.dumps(
        {"schema": "beluga-release-evidence/v1", "version": version, "commit": commit,
         "sbom": SBOM, "license_inventory": [INV_JSON, INV_MD], "asset_inventory": [ASSET_JSON, ASSET_MD], "notice": [NOTICE_NAME, LICENSE_NAME]}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    lines = [f"{sha256(out / name)}  {name}" for name in sorted(REQUIRED)]
    (out / SUMS).write_text("\n".join(lines) + "\n", encoding="utf-8")


def check_asset_inventory(assets: object, assets_md: str, asset_mod) -> None:
    sections = ("workloads", "customResources", "images", "storage")
    if not isinstance(assets, dict) or not isinstance(assets.get("summary"), dict):
        raise EvidenceError("asset inventory malformed")
    if assets.get("charts") != list(asset_mod.CHARTS) or assets.get("profiles") != list(asset_mod.PROFILES):
        raise EvidenceError("asset inventory charts/profiles do not match the generator")
    for key in sections:
        if not isinstance(assets.get(key), list) or not assets[key]:
            raise EvidenceError(f"asset inventory section empty or malformed: {key}")
    counts = {"workloads": "workloads", "customResources": "customResources", "images": "images", "storageAssets": "storage"}
    if any(assets["summary"].get(k) != len(assets[v]) for k, v in counts.items()):
        raise EvidenceError("asset inventory summary does not match its sections")
    try:
        rendered = asset_mod.render_markdown_en(assets)
    except (KeyError, TypeError, AttributeError) as exc:
        raise EvidenceError(f"asset inventory cannot be rendered: {exc!r}") from exc
    if rendered != assets_md:
        raise EvidenceError("asset inventory Markdown does not match its JSON")


def verify(bundle: Path, expect_commit: str | None = None, repo_root: Path = REPO_ROOT, *,
           notice: Path | None = None, license_file: Path | None = None,
           versions_md: Path | None = None, policy: Path | None = None) -> None:
    # Overrides exist so `build` can verify against the exact inputs it built from (default: repo_root).
    notice = notice or repo_root / NOTICE_NAME
    license_file = license_file or repo_root / LICENSE_NAME
    versions_md = versions_md or repo_root / "VERSIONS.md"
    policy = policy or repo_root / "policies/license-policy.yaml"
    if not bundle.is_dir():
        raise EvidenceError(f"{bundle} is not a directory")
    sums_path = bundle / SUMS
    if not sums_path.is_file():
        raise EvidenceError(f"{SUMS} missing")
    listed: dict[str, str] = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        match = SUM_LINE_RE.fullmatch(line)
        if not match:
            raise EvidenceError(f"malformed {SUMS} line: {line!r}")
        digest, name = match.groups()
        if name in listed or name == SUMS:
            raise EvidenceError(f"duplicate/illegal {SUMS} entry: {name}")
        listed[name] = digest
    if set(listed) != set(REQUIRED):
        raise EvidenceError(f"{SUMS} must list exactly {sorted(REQUIRED)}, got {sorted(listed)}")
    present = {p.name for p in bundle.iterdir()}
    extra = present - set(listed) - {SUMS}
    if extra:
        raise EvidenceError(f"unlisted files in bundle: {sorted(extra)}")
    for name, digest in listed.items():
        path = bundle / name
        if path.is_symlink():
            raise EvidenceError(f"symlink not allowed in bundle: {name}")
        if not path.is_file():
            raise EvidenceError(f"listed file missing: {name}")
        if sha256(path) != digest:
            raise EvidenceError(f"checksum mismatch: {name}")
    try:
        manifest = json.loads((bundle / MANIFEST).read_text(encoding="utf-8"))
        bom = json.loads((bundle / SBOM).read_text(encoding="utf-8"))
        inventory = json.loads((bundle / INV_JSON).read_text(encoding="utf-8"))
        assets = json.loads((bundle / ASSET_JSON).read_text(encoding="utf-8"))
        assets_md = (bundle / ASSET_MD).read_text(encoding="utf-8")
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"unparsable evidence file: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != "beluga-release-evidence/v1":
        raise EvidenceError("manifest schema mismatch")
    check_identity(str(manifest.get("version")), str(manifest.get("commit")))
    if expect_commit is not None and manifest["commit"] != expect_commit:
        raise EvidenceError(f"manifest commit {manifest['commit']} != expected {expect_commit}")
    sbom_mod = _load("release_generate_sbom", "scripts/release/generate_sbom.py")
    try:
        sbom_mod.validate_bom(bom)
    except (ValueError, AttributeError, TypeError) as exc:
        raise EvidenceError(f"SBOM invalid: {exc}") from exc
    try:
        props = {p["name"]: p["value"] for p in bom["metadata"]["properties"]}
        sbom_version = bom["metadata"]["component"]["version"]
        matches = props["beluga:source-commit"] == manifest["commit"] and sbom_version == manifest["version"]
    except (KeyError, TypeError, AttributeError) as exc:
        raise EvidenceError(f"SBOM metadata malformed: {exc!r}") from exc
    if not matches:
        raise EvidenceError("SBOM metadata does not match manifest version/commit")
    if not isinstance(inventory, list) or not inventory:
        raise EvidenceError("license inventory empty")
    asset_mod = _load("release_asset_inventory", "scripts/generate_platform_asset_inventory.py")
    check_asset_inventory(assets, assets_md, asset_mod)
    for name, source in ((NOTICE_NAME, notice), (LICENSE_NAME, license_file)):
        if source.is_symlink():
            raise EvidenceError(f"checked-out {name} must not be a symlink")
        try:
            same = (bundle / name).read_bytes() == source.read_bytes()
        except OSError as exc:
            raise EvidenceError(f"cannot compare {name} with checkout: {exc}") from exc
        if not same:
            raise EvidenceError(f"{name} differs from the checked-out {name} (verify from the release commit)")
    try:
        expected = sorted(c["name"] for c in sbom_mod.versions_components(
            versions_md, policy))
    except (OSError, ValueError, KeyError) as exc:
        raise EvidenceError(f"cannot parse checked-out VERSIONS.md: {exc}") from exc
    shipped = sorted(c["name"] for c in bom["components"]
                     if any(p.get("name") == "beluga:source" and p.get("value") == "VERSIONS.md"
                            for p in c.get("properties", [])))
    if shipped != expected:
        raise EvidenceError("SBOM VERSIONS.md components do not match the checked-out VERSIONS.md")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--out", required=True, type=Path)
    b.add_argument("--version", required=True)
    b.add_argument("--commit", required=True)
    b.add_argument("--versions", type=Path, default=REPO_ROOT / "VERSIONS.md")
    b.add_argument("--notice", type=Path, default=REPO_ROOT / "NOTICE")
    b.add_argument("--policy", type=Path, default=REPO_ROOT / "policies/license-policy.yaml")
    b.add_argument("--rendered", type=Path, help="pre-rendered manifests (default: helm template)")
    v = sub.add_parser("verify")
    v.add_argument("bundle", type=Path)
    v.add_argument("--expect-commit")
    v.add_argument("--repo-root", type=Path, default=REPO_ROOT, help="checkout of the release commit (default: this repo)")
    args = parser.parse_args()
    try:
        if args.cmd == "build":
            build(args.out, args.version, args.commit, args.versions, args.notice, args.policy,
                  args.rendered.read_text(encoding="utf-8") if args.rendered else None)
            verify(args.out, args.commit, notice=args.notice, versions_md=args.versions, policy=args.policy)
            print(f"evidence bundle build PASS (output: {args.out})")
        else:
            verify(args.bundle, args.expect_commit, args.repo_root)
            print(f"evidence bundle verify PASS ({args.bundle})")
    except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, ImportError, subprocess.SubprocessError) as exc:  # SbomError is a ValueError; SubprocessError = helm failure in build
        print(f"evidence bundle {args.cmd} FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
