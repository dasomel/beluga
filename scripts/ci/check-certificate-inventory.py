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
from urllib.parse import urlsplit

import yaml

from certificate_endpoints import names, references, sequence, text

REPO_ROOT = Path(__file__).resolve().parents[2]
CHARTS = ("beluga-platform", "beluga-data")
# Mirrors scripts/common/env.sh: 32GB and below disable both optional data
# components; 48GB+ enables both. Keep 48 and 64 separate because up.sh selects
# them independently, even though their Helm values currently match.
PROFILES = {
    "32": ("false", "false", {}),
    "32-oauth": ("false", "false", {"oauthListener": "true"}),
    "32-listener-tls": ("false", "false", {"listenerTls": "true"}),
    "32-external": ("false", "false", {"externalListenerEnabled": "true"}),
    "32-acl": ("false", "false", {"aclAuthorizer": "true"}),
    "48": ("true", "true", {}),
    "48-oauth": ("true", "true", {"oauthListener": "true"}),
    "64": ("true", "true", {}),
    "64-oauth": ("true", "true", {"oauthListener": "true"}),
}
DURATION = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:h|m|s)")
OIDC_FIELDS = ("validIssuerUri", "jwksEndpointUri", "introspectionEndpointUri", "userInfoEndpointUri")


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


def kafka_inventory(resource, certificates, errors):
    label = "/".join(identity(resource))
    namespace = identity(resource)[1]
    spec = resource["spec"]
    kafka = spec["kafka"]
    if not isinstance(kafka, dict):
        raise ValueError("Kafka spec.kafka must be a mapping")
    authorities = []
    for name in ("clusterCa", "clientsCa"):
        ca = spec.get(name, {})
        if not isinstance(ca, dict):
            raise ValueError(f"Kafka spec.{name} must be a mapping")
        generated = ca.get("generateCertificateAuthority", True)
        if not isinstance(generated, bool):
            raise ValueError(f"Kafka spec.{name}.generateCertificateAuthority must be boolean")
        authorities.append({"kafka": label, "ca": name,
                            "authority": "Strimzi generated" if generated else "Externally supplied",
                            "lifecycle": "Strimzi managed" if generated else "Externally managed"})
    cluster_ca_generated = authorities[0]["authority"] == "Strimzi generated"
    listeners = sequence(kafka.get("listeners", []))
    listener_certificates, listener_inventory = [], []
    for listener in listeners:
        listener_name = text(listener["name"])
        field = f"listener/{listener_name}"
        tls = listener.get("tls", False)
        if not isinstance(tls, bool):
            raise ValueError(f"{field}: tls must be boolean")
        configuration = listener.get("configuration", {})
        if not isinstance(configuration, dict):
            raise ValueError(f"{field}: configuration must be a mapping")
        custom = configuration.get("brokerCertChainAndKey")
        if custom is not None and not tls:
            raise ValueError(f"{field}: brokerCertChainAndKey requires TLS")
        if tls:
            if custom is not None:
                if not isinstance(custom, dict):
                    raise ValueError(f"{field}: brokerCertChainAndKey must be a mapping")
                source = text(custom["secretName"])
                text(custom["certificate"])
                text(custom["key"])
                authority = "Externally supplied listener certificate"
                lifecycle = "Externally managed Secret"
            else:
                source = None
                authority = "Strimzi cluster CA" if cluster_ca_generated else "Externally supplied cluster CA"
                lifecycle = ("Strimzi managed broker certificate" if cluster_ca_generated
                             else "Externally managed CA; Strimzi managed broker certificate")
            listener_certificates.append({"authority": authority, "lifecycle": lifecycle,
                                          "kafka": label, "listener": listener_name,
                                          "secret": f"{namespace}/{source}" if source else None})
        auth = listener.get("authentication", {})
        if not isinstance(auth, dict):
            raise ValueError(f"{field}: authentication must be a mapping")
        listener_inventory.append({"kafka": label, "listener": listener_name, "tls": tls,
                                   "authentication": auth.get("type", "none")})
        endpoint_fields = [name for name in OIDC_FIELDS if name in auth]
        if auth.get("disableTlsHostnameVerification") is True:
            raise ValueError(f"{field}: disableTlsHostnameVerification: true is forbidden")
        trusted = sequence(auth.get("tlsTrustedCertificates", []))
        if endpoint_fields and not tls:
            raise ValueError(f"{field}: OAuth endpoints require a TLS listener")
        if endpoint_fields and not trusted:
            raise ValueError(f"{field}: HTTPS OAuth endpoints require tlsTrustedCertificates")
        trusted_issuers = set()
        for index, trust in enumerate(trusted):
            if not isinstance(trust, dict):
                raise ValueError(f"{field}/tlsTrustedCertificates[{index}]: expected a mapping")
            if trust.get("certificate") != "ca.crt":
                raise ValueError(f"{field}/tlsTrustedCertificates[{index}]: certificate must be ca.crt")
            secret = text(trust["secretName"])
            certificate = certificates.get((namespace, secret))
            if certificate is None:
                errors.append(f"{label} {field}/tlsTrustedCertificates[{index}]: Secret/{namespace}/{secret} has no valid Certificate")
                continue
            trusted_issuers.add(certificate["issuer"])
            consumer = {"resource": label, "field": f"{field}/tlsTrustedCertificates[{index}]", "hosts": []}
            if consumer not in certificate["consumers"]:
                certificate["consumers"].append(consumer)
        if not endpoint_fields:
            continue
        for name in endpoint_fields:
            uri = text(auth[name])
            parsed = urlsplit(uri)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
                raise ValueError(f"{field}/{name}: expected an HTTPS URL with a hostname and no credentials")
            host = parsed.hostname
            # D4: Compare issuerRef identity across the trust Secret and host
            # Certificate. Cost: this is declarative evidence only; escape hatch
            # for other trust models requires explicit chain-aware validation.
            matches = [cert for cert in certificates.values()
                       if cert["issuer"] in trusted_issuers
                       and any(covers(pattern, host) for pattern in (cert["dnsNames"] or [cert["commonName"]]))]
            if not matches:
                errors.append(f"{label} {field}/{name}: no Certificate from a trusted issuer covers HTTPS host {host}")
                continue
            certificate = matches[0]
            consumer = {"resource": label, "field": f"{field}/{name}", "hosts": [host]}
            if consumer not in certificate["consumers"]:
                certificate["consumers"].append(consumer)
    return listener_certificates, authorities, listener_inventory


def inventory(resources):
    errors, issuers, certificates, secrets, seen = [], set(), {}, {}, set()
    strimzi_certificates, strimzi_authorities, strimzi_listeners = [], [], []
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
            if resource["kind"] == "Kafka":
                listener_items, ca_items, all_listeners = kafka_inventory(resource, certificates, errors)
                strimzi_certificates.extend(listener_items)
                strimzi_authorities.extend(ca_items)
                strimzi_listeners.extend(all_listeners)
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
            "charts": list(CHARTS), "certificates": [certificates[key] for key in sorted(certificates)],
            "strimziCertificates": sorted(strimzi_certificates,
                                            key=lambda item: (item["kafka"], item["listener"])),
            "strimziCertificateAuthorities": sorted(strimzi_authorities,
                                                     key=lambda item: (item["kafka"], item["ca"])),
            "strimziListeners": sorted(strimzi_listeners,
                                       key=lambda item: (item["kafka"], item["listener"]))}


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
        for profile, (openmetadata, trino_worker, strimzi_options) in PROFILES.items():
            resources = []
            for chart in CHARTS:
                command = ["helm", "template", str(REPO_ROOT / "gitops/charts" / chart)]
                if chart == "beluga-data":
                    command.extend(["--set", f"openmetadata.enabled={openmetadata}",
                                    "--set", f"trino.workerEnabled={trino_worker}"])
                    for option, value in strimzi_options.items():
                        command.extend(["--set", f"strimzi.{option}={value}"])
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
