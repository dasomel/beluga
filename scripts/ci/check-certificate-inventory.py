#!/usr/bin/env python3
"""Offline certificate inventory/policy gate for every deployment profile.

Stdout is deterministic JSON, emitted only after validation and built-in fixtures
pass. No cluster access, certificate bytes, or stored inventory to drift.
"""
import base64
import json
import os
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import yaml

from certificate_endpoints import names, references, text

REPO_ROOT = Path(__file__).resolve().parents[2]
CHARTS = ("beluga-platform", "beluga-data")
# Mirrors scripts/common/env.sh: 32GB and below disable both optional data
# components; 48GB+ enables both. Keep 48 and 64 separate because up.sh selects
# them independently, even though their Helm values currently match.
PROFILES = {
    "32": ("false", "false"),
    "48": ("true", "true"),
    "64": ("true", "true"),
}
DURATION = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:h|m|s)")


class UniqueLoader(yaml.SafeLoader):
    """Reject duplicate YAML keys instead of silently losing a TLS declaration."""


def unique_mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if key in result:
            raise ValueError(f"duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def documents(manifest):
    result = []

    def add(resource):
        if not isinstance(resource, dict):
            raise ValueError("rendered document must be a resource mapping")
        if resource.get("kind") == "List":
            for item in resource["items"]:
                add(item)
        else:
            text(resource["apiVersion"])
            text(resource["kind"])
            text(resource["metadata"]["name"])
            text(resource["metadata"].get("namespace", "default"))
            result.append(resource)

    for document in yaml.load_all(manifest, Loader=UniqueLoader):
        if document is not None:
            add(document)
    if not result:
        raise ValueError("empty rendered chart")
    return result


def duration(value):
    value = text(value)
    parts = DURATION.findall(value)
    if "".join(parts) != value:
        raise ValueError(f"invalid duration {value!r}: use Go h/m/s units")
    seconds = sum(Decimal(part[:-1]) * {"h": 3600, "m": 60, "s": 1}[part[-1]] for part in parts)
    if seconds <= 0:
        raise ValueError("duration/renewBefore must be positive")
    return seconds


def identity(resource):
    return (resource["kind"], resource["metadata"].get("namespace", "default"),
            resource["metadata"]["name"])


def covers(pattern, host):
    pattern, host = pattern.lower().rstrip("."), host.lower().rstrip(".")
    return pattern == host or (pattern.startswith("*.") and host.count(".") == pattern.count(".")
                               and host.endswith(pattern[1:]))


def inline_certificate(secret):
    for field in ("data", "stringData"):
        for key, value in secret.get(field, {}).items():
            if key in ("tls.crt", "tls.key", "keystore.p12", "keystore.jks"):
                return True
            if field == "data":
                value = base64.b64decode(value, validate=True).decode("utf-8", errors="replace")
            if re.search(r"-----BEGIN (?:CERTIFICATE|(?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----", value):
                return True
    return False


def inventory(resources):
    errors, issuers, certificates, secrets, seen = [], set(), {}, {}, set()
    for resource in resources:
        kind, namespace, name = identity(resource)
        group = resource["apiVersion"].split("/")[0] if "/" in resource["apiVersion"] else ""
        rid = (group, kind, "" if kind == "ClusterIssuer" else namespace, name)
        if rid in seen:
            errors.append(f"{kind}/{namespace}/{name}: duplicate resource")
        seen.add(rid)
        if kind in ("Certificate", "Issuer", "ClusterIssuer"):
            if resource["apiVersion"] != "cert-manager.io/v1":
                errors.append(f"{kind}/{name}: expected cert-manager.io/v1")
                continue
        if kind in ("Issuer", "ClusterIssuer"):
            issuers.add((kind, namespace if kind == "Issuer" else "", name))
        if kind == "Secret":
            secrets[(namespace, name)] = resource
            if (resource.get("type") == "kubernetes.io/tls"
                    and (resource.get("data") or resource.get("stringData"))) or inline_certificate(resource):
                errors.append(f"Secret/{namespace}/{name}: inline TLS certificate/key material is forbidden")

    for resource in resources:
        kind, namespace, name = identity(resource)
        if kind != "Certificate":
            continue
        label = f"Certificate/{namespace}/{name}"
        try:
            spec = resource["spec"]
            secret = text(spec["secretName"])
            dns = names(spec.get("dnsNames", []))
            common_name = text(spec["commonName"]) if "commonName" in spec else None
            if not dns and not common_name:
                raise ValueError("dnsNames or commonName is required")
            lifetime, renewal = duration(spec["duration"]), duration(spec["renewBefore"])
            if lifetime < 3600 or renewal < 300:
                raise ValueError("duration must be >= 1h and renewBefore >= 5m (cert-manager minimums)")
            if renewal >= lifetime:
                raise ValueError("renewBefore must be less than duration")
            if "renewBeforePercentage" in spec:
                raise ValueError("renewBeforePercentage conflicts with explicit renewBefore")
            ref = spec["issuerRef"]
            issuer_kind = ref.get("kind", "Issuer")
            issuer = (issuer_kind, namespace if issuer_kind == "Issuer" else "", text(ref["name"]))
            if ref.get("group", "cert-manager.io") != "cert-manager.io" or issuer not in issuers:
                raise ValueError(f"missing/unsupported issuer {issuer}")
            key = (namespace, secret)
            if key in certificates:
                raise ValueError(f"multiple Certificates manage Secret/{namespace}/{secret}")
            certificates[key] = {
                "certificate": label, "secret": f"{namespace}/{secret}", "dnsNames": sorted(dns),
                "commonName": common_name, "isCA": spec.get("isCA", False),
                "issuer": "/".join(part for part in issuer if part),
                "duration": spec["duration"], "renewBefore": spec["renewBefore"], "consumers": [],
            }
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(f"{label}: {exc}")

    for resource in resources:
        label = "/".join(identity(resource))
        try:
            for namespace, secret, field, hosts in references(resource, certificates, secrets):
                certificate = certificates.get((namespace, secret))
                if certificate is None:
                    errors.append(f"{label} {field}: Secret/{namespace}/{secret} has no valid Certificate")
                    continue
                identities = certificate["dnsNames"] or [certificate["commonName"]]
                if any(not any(covers(pattern, host) for pattern in identities) for host in hosts):
                    errors.append(f"{label} {field}: hostnames are not covered by {certificate['certificate']}")
                consumer = {"resource": label, "field": field, "hosts": sorted(hosts)}
                if consumer not in certificate["consumers"]:
                    certificate["consumers"].append(consumer)
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(f"{label}: invalid/uninventoried TLS reference: {exc}")
    if not certificates:
        errors.append("no valid Certificates found")
    if not any(cert["consumers"] for cert in certificates.values()):
        errors.append("no TLS endpoints found")
    if errors:
        raise ValueError("\n".join(errors))
    for certificate in certificates.values():
        certificate["consumers"].sort(key=lambda entry: (entry["resource"], entry["field"]))
    return {"schemaVersion": 1, "scope": "static declarations, not live expiry",
            "charts": list(CHARTS), "certificates": [certificates[key] for key in sorted(certificates)]}


def profile_inventories(profile_resources):
    result = {}
    for profile, resources in profile_resources.items():
        try:
            result[profile] = inventory(resources)
        except ValueError as exc:
            raise ValueError(f"profile {profile}:\n{exc}") from exc
    return result


def dedupe_certificates(profiles):
    unique = {}
    for profile in profiles.values():
        for certificate in profile["certificates"]:
            key = json.dumps(certificate, sort_keys=True)
            unique.setdefault(key, certificate)
    return list(unique.values())


def main():
    try:
        from certificate_inventory_fixtures import self_test
        count = self_test(documents, inventory, duration, profile_inventories)
        print(f"Certificate inventory self-test: {count} negative fixtures rejected; positive fixtures passed.",
              file=sys.stderr)
        rendered = {}
        for profile, (openmetadata, trino_worker) in PROFILES.items():
            resources = []
            for chart in CHARTS:
                command = ["helm", "template", str(REPO_ROOT / "gitops/charts" / chart)]
                if chart == "beluga-data":
                    command.extend(["--set", f"openmetadata.enabled={openmetadata}",
                                    "--set", f"trino.workerEnabled={trino_worker}"])
                output = subprocess.run(
                    command, capture_output=True, text=True, check=True,
                    env={**os.environ, "KUBECONFIG": os.devnull},
                )
                resources.extend(documents(output.stdout))
            rendered[profile] = resources
        profiles = profile_inventories(rendered)
        result = {"schemaVersion": 1, "scope": "static declarations, not live expiry",
                  "charts": list(CHARTS), "profiles": profiles,
                  "uniqueCertificates": dedupe_certificates(profiles)}
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError) as exc:
        print(f"FAIL: certificate inventory: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
