#!/usr/bin/env python3
"""Build and offline-verify the Beluga release evidence bundle (Issue #100).

Bundle = CycloneDX SBOM + release license inventory + manifest.json (version,
commit) + SHA256SUMS over every other file. `verify` needs no network and no
repository checkout: it recomputes checksums and cross-checks the manifest, SBOM
and inventory. Fail closed: a missing, extra, altered or unparsable file fails.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SUMS = "SHA256SUMS"
MANIFEST = "manifest.json"
SBOM = "sbom.cdx.json"
INV_JSON = "release-license-inventory.json"
INV_MD = "release-license-inventory.md"
REQUIRED = (MANIFEST, SBOM, INV_JSON, INV_MD)
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
          rendered: str | None = None) -> None:
    check_identity(version, commit)
    sbom_mod = _load("release_generate_sbom", "scripts/release/generate_sbom.py")
    inv_mod = _load("release_license_inventory", "scripts/generate_release_license_inventory.py")
    # Gate order matters: any failure aborts before a bundle exists (no partial evidence).
    inventory = inv_mod.build_inventory(versions_md, notice, policy)  # raises on unapproved license
    bom = sbom_mod.build_bom(version, commit, versions_md, policy,
                             rendered if rendered is not None else sbom_mod.render_charts())
    out.mkdir(parents=True, exist_ok=True)
    (out / SBOM).write_text(json.dumps(bom, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / INV_JSON).write_text(json.dumps(inventory, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / INV_MD).write_text(inv_mod.render_markdown(inventory), encoding="utf-8")
    (out / MANIFEST).write_text(json.dumps(
        {"schema": "beluga-release-evidence/v1", "version": version, "commit": commit,
         "sbom": SBOM, "license_inventory": [INV_JSON, INV_MD]}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    lines = [f"{sha256(out / name)}  {name}" for name in sorted(REQUIRED)]
    (out / SUMS).write_text("\n".join(lines) + "\n", encoding="utf-8")


def verify(bundle: Path, expect_commit: str | None = None) -> None:
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
        if not path.is_file():
            raise EvidenceError(f"listed file missing: {name}")
        if sha256(path) != digest:
            raise EvidenceError(f"checksum mismatch: {name}")
    try:
        manifest = json.loads((bundle / MANIFEST).read_text(encoding="utf-8"))
        bom = json.loads((bundle / SBOM).read_text(encoding="utf-8"))
        inventory = json.loads((bundle / INV_JSON).read_text(encoding="utf-8"))
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
    args = parser.parse_args()
    try:
        if args.cmd == "build":
            build(args.out, args.version, args.commit, args.versions, args.notice, args.policy,
                  args.rendered.read_text(encoding="utf-8") if args.rendered else None)
            verify(args.out, args.commit)
            print(f"evidence bundle build PASS (output: {args.out})")
        else:
            verify(args.bundle, args.expect_commit)
            print(f"evidence bundle verify PASS ({args.bundle})")
    except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"evidence bundle {args.cmd} FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
