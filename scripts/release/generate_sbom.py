#!/usr/bin/env python3
"""Generate a CycloneDX 1.5 JSON SBOM for a Beluga release (Issue #100).

Scope is deliberately limited to what this repository can truthfully enumerate
without a live cluster: the VERSIONS.md component rows (declared name/version/
license) and the container image references in the rendered Helm charts. It does
not scan image contents (transitive packages) — that remains scripts/generate-sbom.sh
against a live cluster. No purl/CPE/hash is invented: fields are only emitted when
the source states them. Fail closed: any unparsable/empty input is an error.
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHARTS = ("gitops/charts/beluga-platform", "gitops/charts/beluga-data")
IMAGE_RE = re.compile(r"^\s*-?\s*image:\s*[\"']?([^\"'\s#]+)", re.MULTILINE)
SPEC_VERSION = "1.5"


class SbomError(ValueError):
    pass


def _load_license_policy():
    path = REPO_ROOT / "scripts/ci/check-license-policy.py"
    spec = importlib.util.spec_from_file_location("check_license_policy", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_charts(charts=CHARTS, root: Path = REPO_ROOT) -> str:
    out = []
    for chart in charts:
        try:
            proc = subprocess.run(["helm", "template", str(root / chart)], capture_output=True,
                                  text=True, check=False)
        except OSError as exc:
            raise SbomError(f"cannot run helm: {exc}") from exc
        if proc.returncode != 0:
            raise SbomError(f"helm template {chart} failed: {proc.stderr.strip()}")
        out.append(proc.stdout)
    return "\n---\n".join(out)


def split_image(ref: str) -> tuple[str, str]:
    """Return (name, version) where version is the tag or the sha256 digest."""
    if "@" in ref:
        name, version = ref.split("@", 1)
        name = name.rsplit(":", 1)[0] if ":" in name.rsplit("/", 1)[-1] else name
    else:
        last = ref.rsplit("/", 1)[-1]
        if ":" not in last:
            raise SbomError(f"image reference without tag or digest: {ref!r}")
        name, version = ref.rsplit(":", 1)
    if not name or not version or "{{" in ref:
        raise SbomError(f"unresolvable image reference: {ref!r}")
    return name, version


def image_components(rendered: str) -> list[dict]:
    refs = sorted(set(IMAGE_RE.findall(rendered)))
    if not refs:
        raise SbomError("no container images found in rendered charts")
    comps = []
    for ref in refs:
        name, version = split_image(ref)
        comps.append({"type": "container", "bom-ref": f"image:{ref}", "name": name,
                      "version": version,
                      "properties": [{"name": "beluga:image-reference", "value": ref},
                                     {"name": "beluga:source", "value": "helm-template"}]})
    return comps


def versions_components(versions_md: Path, policy_yaml: Path) -> list[dict]:
    lp = _load_license_policy()
    approved, marker = lp.load_policy(policy_yaml)
    rows = lp.parse_versions_md(versions_md)
    if not rows:
        raise SbomError(f"no component rows parsed from {versions_md}")
    comps = []
    for idx, (name, version, image, license_cell) in enumerate(rows):
        comp = {"type": "application", "bom-ref": f"versions-md:{idx}:{name}", "name": name,
                "properties": [{"name": "beluga:image-or-chart", "value": image},
                               {"name": "beluga:source", "value": "VERSIONS.md"}]}
        if version and version != "-":
            comp["version"] = version
        if not license_cell.startswith(marker):
            # License names are declared prose (not always SPDX ids), so use `name`.
            comp["licenses"] = [{"license": {"name": lp.normalize_license_part(part)}}
                                for part in license_cell.split(" / ")]
        comps.append(comp)
    return comps


def build_bom(version: str, commit: str, versions_md: Path, policy_yaml: Path,
              rendered: str, timestamp: str | None = None) -> dict:
    components = versions_components(versions_md, policy_yaml) + image_components(rendered)
    refs = [c["bom-ref"] for c in components]
    if len(refs) != len(set(refs)):
        raise SbomError("duplicate bom-ref in generated components")
    metadata = {"component": {"type": "application", "bom-ref": "beluga", "name": "beluga",
                              "version": version},
                "properties": [{"name": "beluga:source-commit", "value": commit}]}
    if timestamp:
        metadata["timestamp"] = timestamp
    serial = uuid.uuid5(uuid.NAMESPACE_URL, f"beluga:{version}:{commit}:{json.dumps(components, sort_keys=True)}")
    bom = {"bomFormat": "CycloneDX", "specVersion": SPEC_VERSION, "version": 1,
           "serialNumber": f"urn:uuid:{serial}", "metadata": metadata, "components": components}
    validate_bom(bom)
    return bom


def validate_bom(bom) -> None:
    if not isinstance(bom, dict) or bom.get("bomFormat") != "CycloneDX":
        raise SbomError("not a CycloneDX document")
    if not isinstance(bom.get("specVersion"), str) or not isinstance(bom.get("components"), list):
        raise SbomError("missing specVersion/components")
    if not bom["components"]:
        raise SbomError("SBOM has no components")
    refs = set()
    for comp in bom["components"]:
        if not isinstance(comp, dict) or not comp.get("name") or not comp.get("type") or not comp.get("bom-ref"):
            raise SbomError(f"component missing name/type/bom-ref: {comp!r}")
        if comp["bom-ref"] in refs:
            raise SbomError(f"duplicate bom-ref {comp['bom-ref']}")
        refs.add(comp["bom-ref"])
    props = {p.get("name"): p.get("value") for p in bom.get("metadata", {}).get("properties", [])}
    if not re.fullmatch(r"[0-9a-f]{40}", str(props.get("beluga:source-commit", ""))):
        raise SbomError("metadata lacks a 40-hex beluga:source-commit")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--versions", type=Path, default=REPO_ROOT / "VERSIONS.md")
    parser.add_argument("--policy", type=Path, default=REPO_ROOT / "policies/license-policy.yaml")
    parser.add_argument("--rendered", type=Path, help="pre-rendered manifests (default: helm template)")
    parser.add_argument("--timestamp", help="optional RFC 3339 timestamp (omitted by default for determinism)")
    args = parser.parse_args()
    try:
        rendered = args.rendered.read_text(encoding="utf-8") if args.rendered else render_charts()
        bom = build_bom(args.version, args.commit, args.versions, args.policy, rendered, args.timestamp)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(bom, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                            encoding="utf-8")
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"SBOM generation FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"SBOM generation PASS ({len(bom['components'])} components; output: {args.out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
