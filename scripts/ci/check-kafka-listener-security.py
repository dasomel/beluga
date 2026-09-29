#!/usr/bin/env python3
"""Ratchet gate for TLS and authentication on rendered Strimzi Kafka listeners."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
AUTH_TYPES = {"scram-sha-512", "tls", "oauth", "custom"}
# Issue #6: exact listener contracts freeze the known debt. Remove an entry once
# secured; changed listener attributes must be reviewed and explicitly rebased.
BASELINE = {
    "Kafka/streaming/beluga-kafka/listener/plain": {
        "attributes": {"name": "plain", "port": 9092, "type": "internal", "tls": False, "authentication": None},
        "reason": "internal plain listener has tls:false and no authentication (deferred to protect in-cluster Flink/Debezium consumers)",
        "issue": "#6",
    },
    "Kafka/streaming/beluga-kafka/listener/external": {
        "attributes": {"name": "external", "port": 9094, "type": "nodeport", "tls": False, "authentication": None},
        "reason": "opt-in external nodeport listener (strimzi.externalListenerEnabled: true) has tls:false and no authentication (allows anonymous access even when oauthListener: true is enabled)",
        "issue": "#6",
    },
}


def identity(resource: dict) -> str:
    metadata = resource.get("metadata") or {}
    return f"{resource.get('kind')}/{metadata.get('namespace', 'default')}/{metadata.get('name')}"


def compliant(listener: dict) -> bool:
    auth = listener.get("authentication")
    return (
        listener.get("tls") is True
        and isinstance(auth, dict)
        and auth.get("type") in AUTH_TYPES
        and listener.get("type") != "nodeport"
    )


def baseline_state(key: str, listener: dict | None) -> str | None:
    """Return changed/stale when frozen listener debt no longer matches."""
    if listener is None:
        return "changed"
    if compliant(listener):
        return "stale"
    expected = BASELINE[key]["attributes"]
    actual = {field: listener.get(field) for field in expected}
    if actual != expected:
        return "changed"
    return None


def violations(resources: list[dict]) -> dict[str, str]:
    errors: dict[str, str] = {}
    # Deployment references are reported separately so known in-chart clients
    # remain visible without masking the listener ratchet's exit status.
    observations: dict[str, str] = {}
    kafkas = [r for r in resources if r.get("apiVersion", "").startswith("kafka.strimzi.io/") and r.get("kind") == "Kafka"]
    users = [r for r in resources if r.get("apiVersion", "").startswith("kafka.strimzi.io/") and r.get("kind") == "KafkaUser"]
    clients = [r for r in resources if r.get("apiVersion", "").startswith("kafka.strimzi.io/")
               and r.get("kind") in {"KafkaConnect", "KafkaMirrorMaker2", "KafkaBridge"}]
    if not kafkas and not users and not clients:
        raise ValueError("rendered input contains zero relevant Kafka resources")

    enabled_auth: dict[tuple[str, str], set[str]] = {}
    oauth_enabled: set[tuple[str, str]] = set()
    for kafka in kafkas:
        k_id = identity(kafka)
        spec = kafka.get("spec") or {}
        listeners = (spec.get("kafka") or {}).get("listeners")
        if not isinstance(listeners, list) or not listeners:
            errors[f"{k_id}/listener/<missing>"] = "Kafka has no listeners"
            continue
        metadata = kafka.get("metadata") or {}
        cluster = (metadata.get("namespace", "default"), metadata.get("name", ""))
        auth_types = set()
        for listener in listeners:
            if not isinstance(listener, dict):
                errors[f"{k_id}/listener/<invalid>"] = "listener must be a mapping"
                continue
            lid = f"{k_id}/listener/{listener.get('name', '<missing>')}"
            auth = listener.get("authentication")
            if listener.get("tls") is not True:
                errors[lid] = "listener tls must be true"
            if not isinstance(auth, dict) or auth.get("type") not in AUTH_TYPES:
                errors[lid] = errors.get(lid, "") + ("; " if lid in errors else "") + "listener requires supported authentication"
            else:
                auth_types.add(auth["type"])
                if auth["type"] == "oauth":
                    oauth_enabled.add(cluster)
                    certs = auth.get("tlsTrustedCertificates")
                    if not isinstance(certs, list) or not certs:
                        errors[lid] = errors.get(lid, "") + ("; " if lid in errors else "") + "OAuth listener requires tlsTrustedCertificates"
                    else:
                        for cert in certs:
                            if not isinstance(cert, dict) or not cert.get("secretName"):
                                errors[lid] = errors.get(lid, "") + ("; " if lid in errors else "") + "OAuth tlsTrustedCertificates requires secretName"
            if listener.get("type") == "nodeport":
                errors[lid] = errors.get(lid, "") + ("; " if lid in errors else "") + "nodeport listener requires opt-in externalListenerEnabled"
        enabled_auth[cluster] = auth_types

    for user in users:
        spec = user.get("spec") or {}
        metadata = user.get("metadata") or {}
        uid = identity(user)
        cluster = (metadata.get("namespace", "default"), (metadata.get("labels") or {}).get("strimzi.io/cluster", ""))
        auth = spec.get("authentication")
        auth_type = auth.get("type") if isinstance(auth, dict) else None
        # Strimzi OAuth KafkaUsers have no spec.authentication: OAuth identity
        # is supplied by the client token and broker listener, not user credentials.
        oauth_only = auth is None and cluster in oauth_enabled
        if oauth_only:
            continue
        if auth_type not in enabled_auth.get(cluster, set()):
            errors[f"{uid}/authentication"] = (
                f"KafkaUser authentication must be present and match an enabled listener; "
                f"only OAuth-only users with omitted authentication and an enabled OAuth listener are exempt "
                f"(found: {auth_type!r})"
            )

    for client in clients:
        metadata = client.get("metadata") or {}
        cid = identity(client)
        spec = client.get("spec") or {}
        if client.get("kind") == "KafkaConnect":
            config = spec.get("config") or {}
            bootstrap = config.get("bootstrap.servers", "")
            if "9092" in str(bootstrap):
                errors[f"{cid}/bootstrap"] = "KafkaConnect bootstrap points to plaintext port 9092"
            if spec.get("tls") is None or spec.get("authentication") is None:
                errors[f"{cid}/security"] = "KafkaConnect requires tls and authentication"
        else:
            errors[f"{cid}/review"] = "Kafka client CR requires security review (tls and authentication)"

    for resource in resources:
        if resource.get("kind") != "Deployment":
            continue
        text = yaml.safe_dump(resource, sort_keys=False)
        if "beluga-kafka-kafka-bootstrap:9092" in text or "bootstrap.servers:9092" in text:
            observations[f"{identity(resource)}/bootstrap"] = "Deployment references plaintext Kafka bootstrap port 9092"
    violations.last_observations = observations
    return errors


def self_test() -> int:
    def parse(text: str) -> list[dict]:
        return [doc for doc in yaml.safe_load_all(text) if doc is not None]

    kafka = """apiVersion: kafka.strimzi.io/v1
kind: Kafka
metadata: {name: test, namespace: streaming}
spec:
  kafka:
    listeners:
      - {name: secure, port: 9092, type: internal, tls: true, authentication: {type: scram-sha-512}}
"""
    if violations(parse(kafka)):
        raise AssertionError("secure listener fixture rejected")
    fixtures = [
        ("zero resources", "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n", "zero relevant"),
        ("TLS disabled", kafka.replace("tls: true", "tls: false"), "tls must be true"),
        ("missing authentication", kafka.replace(", authentication: {type: scram-sha-512}", ""), "requires supported authentication"),
        ("empty authentication", kafka.replace("{type: scram-sha-512}", "{}"), "requires supported authentication"),
        ("missing auth type", kafka.replace("{type: scram-sha-512}", "{foo: bar}"), "requires supported authentication"),
        ("unsupported authentication", kafka.replace("scram-sha-512", "basic"), "requires supported authentication"),
        ("missing listeners", kafka.replace("    listeners:\n      - {name: secure, port: 9092, type: internal, tls: true, authentication: {type: scram-sha-512}}\n", "    listeners: []\n"), "no listeners"),
        ("OAuth missing tlsTrustedCertificates", kafka.replace("type: scram-sha-512", "type: oauth"), "OAuth listener requires tlsTrustedCertificates"),
        ("OAuth empty tlsTrustedCertificates", kafka.replace("{type: scram-sha-512}", "{type: oauth, tlsTrustedCertificates: []}"), "OAuth listener requires tlsTrustedCertificates"),
        ("OAuth invalid secretName", kafka.replace("{type: scram-sha-512}", "{type: oauth, tlsTrustedCertificates: [{certificate: ca.crt}]}"), "OAuth tlsTrustedCertificates requires secretName"),
        ("external listener without opt-in flag", kafka.replace("type: internal", "type: nodeport"), "nodeport listener requires opt-in externalListenerEnabled"),
    ]
    for label, fixture, expected in fixtures:
        try:
            found = violations(parse(fixture))
        except ValueError as exc:
            found = {"error": str(exc)}
        if not any(expected in message for message in found.values()):
            raise AssertionError(f"self-test {label} did not fail as expected: {found}")

    baseline_resource = {"apiVersion": "kafka.strimzi.io/v1", "kind": "Kafka", "metadata": {"name": "beluga-kafka", "namespace": "streaming"},
                         "spec": {"kafka": {"listeners": [dict(entry["attributes"]) for key, entry in BASELINE.items() if key.endswith("/plain") or key.endswith("/external")]}}}
    frozen = violations([baseline_resource])
    for key, entry in BASELINE.items():
        if key.endswith("/oauth"):
            continue
        if key not in frozen:
            raise AssertionError(f"baseline fixture missing violation {key}: {frozen}")
        changed = dict(entry["attributes"], port=entry["attributes"]["port"] + 1)
        if baseline_state(key, changed) != "changed":
            raise AssertionError(f"baseline attribute change did not fail for {key}")
        compliant_listener = dict(entry["attributes"], tls=True, authentication={"type": "scram-sha-512"}, type="internal")
        if baseline_state(key, compliant_listener) != "stale":
            raise AssertionError(f"compliant listener did not become stale for {key}")

    user = """apiVersion: kafka.strimzi.io/v1
kind: KafkaUser
metadata: {name: user, namespace: streaming, labels: {strimzi.io/cluster: test}}
spec: {authorization: {type: simple}, authentication: {type: tls}}
"""
    if not any("must be present" in message for message in violations(parse(kafka + "---\n" + user)).values()):
        raise AssertionError("KafkaUser authentication mismatch fixture was not rejected")
    if violations(parse(kafka + "---\n" + user.replace("type: tls", "type: scram-sha-512"))):
        raise AssertionError("matching KafkaUser authentication fixture rejected")
    oauth_user = user.replace("test}", "test}").replace("authentication: {type: tls}", "")
    oauth_kafka = kafka.replace("type: scram-sha-512", "type: oauth, tlsTrustedCertificates: [{secretName: ca-secret}]")
    if violations(parse(oauth_kafka + "---\n" + oauth_user)):
        raise AssertionError("OAuth-only KafkaUser omission should be accepted")

    valid_oauth_kafka = """apiVersion: kafka.strimzi.io/v1
kind: Kafka
metadata: {name: test, namespace: streaming}
spec:
  kafka:
    listeners:
      - name: oauth
        port: 9093
        type: internal
        tls: true
        authentication:
          type: oauth
          validIssuerUri: https://sso.local.beluga.internal/realms/beluga
          jwksEndpointUri: https://sso.local.beluga.internal/realms/beluga/protocol/openid-connect/certs
          userNameClaim: preferred_username
          tlsTrustedCertificates:
            - secretName: beluga-kafka-oauth-ca
              certificate: ca.crt
"""
    if violations(parse(valid_oauth_kafka)):
        raise AssertionError(f"valid OAuth listener fixture rejected: {violations(parse(valid_oauth_kafka))}")

    # Acceptance criteria #3 & #4: default render (no overrides) must not contain external nodeport listener
    default_manifest = render("beluga-data", False, False)
    for doc in parse_resources(default_manifest):
        if doc.get("kind") == "Kafka":
            for listener in ((doc.get("spec") or {}).get("kafka") or {}).get("listeners", []):
                if listener.get("type") == "nodeport" or listener.get("name") == "external":
                    raise AssertionError("external nodeport listener present in default render without opt-in flag")

    # Opt-in render must contain external nodeport listener
    optin_manifest = render("beluga-data", False, False, external=True)
    has_nodeport = any(
        listener.get("type") == "nodeport"
        for doc in parse_resources(optin_manifest)
        if doc.get("kind") == "Kafka"
        for listener in ((doc.get("spec") or {}).get("kafka") or {}).get("listeners", [])
    )
    if not has_nodeport:
        raise AssertionError("external nodeport listener missing when opt-in flag is enabled")

    # Follow-up Fix 1: Certificate beluga-kafka-oauth-ca must use internal CA-trust dummy hostname,
    # never claiming SSO or any served domain to prevent leaf key impersonation.
    oauth_alone_manifest = render("beluga-data", False, False, oauth=True, acl=True, external=False)
    oauth_alone_docs = parse_resources(oauth_alone_manifest)
    ca_certs = [
        doc for doc in oauth_alone_docs
        if doc.get("kind") == "Certificate" and (doc.get("metadata") or {}).get("name") == "beluga-kafka-oauth-ca"
    ]
    if not ca_certs:
        raise AssertionError("Certificate beluga-kafka-oauth-ca missing when oauthListener=true")
    for cert in ca_certs:
        spec = cert.get("spec") or {}
        dns_names = spec.get("dnsNames") or []
        common_name = spec.get("commonName", "")
        for name in dns_names + ([common_name] if common_name else []):
            if name.startswith("sso.") or "local.beluga.internal" in name:
                raise AssertionError(f"Certificate beluga-kafka-oauth-ca must not claim SSO served hostnames: {name}")
        if "beluga-kafka-oauth-trust.streaming.svc.cluster.local" not in dns_names:
            raise AssertionError(f"Certificate beluga-kafka-oauth-ca missing expected dummy trust hostname: {dns_names}")

    # Follow-up Fix 2: oauthListener=true alone removes plain 9092 listener, and static check
    # must report client-bootstrap-port-9092 observations for debezium-connect and clickstream-gen.
    oauth_listeners = [
        listener
        for doc in oauth_alone_docs
        if doc.get("kind") == "Kafka"
        for listener in ((doc.get("spec") or {}).get("kafka") or {}).get("listeners", [])
    ]
    if any(l.get("name") == "plain" for l in oauth_listeners):
        raise AssertionError("plain 9092 listener must be removed when oauthListener=true")
    if not any(l.get("name") == "oauth" and l.get("tls") is True for l in oauth_listeners):
        raise AssertionError("oauth 9093 listener missing or not tls:true when oauthListener=true")
    violations(oauth_alone_docs)
    oauth_observations = violations.last_observations
    required_incompatible_clients = {
        "Deployment/streaming/debezium-connect/bootstrap",
        "Deployment/streaming/clickstream-gen/bootstrap",
    }
    missing_clients = required_incompatible_clients - set(oauth_observations)
    if missing_clients:
        raise AssertionError(f"oauthListener=true render did not surface incompatible 9092 clients: {missing_clients}")

    # Follow-up Fix 3: oauthListener=true + externalListenerEnabled=true combination must render
    # both oauth and external nodeport listeners (plain absent), and violations must detect the
    # unauthenticated external listener security gap.
    combo_manifest = render("beluga-data", False, False, oauth=True, acl=True, external=True)
    combo_docs = parse_resources(combo_manifest)
    combo_listeners = [
        listener
        for doc in combo_docs
        if doc.get("kind") == "Kafka"
        for listener in ((doc.get("spec") or {}).get("kafka") or {}).get("listeners", [])
    ]
    combo_names = {l.get("name") for l in combo_listeners}
    if "plain" in combo_names:
        raise AssertionError("plain 9092 listener must be removed in oauth+external combination")
    if "oauth" not in combo_names:
        raise AssertionError("oauth listener missing in oauth+external combination")
    if "external" not in combo_names:
        raise AssertionError("external nodeport listener missing in oauth+external combination")
    combo_violations = violations(combo_docs)
    if "Kafka/streaming/beluga-kafka/listener/external" not in combo_violations:
        raise AssertionError("external nodeport listener gap not detected in oauth+external combination")

    return len(fixtures) + 10


def render(
    chart: str,
    worker: bool,
    metadata: bool,
    oauth: bool = False,
    acl: bool = False,
    external: bool | None = None,
) -> str:
    command = ["helm", "template", str(REPO_ROOT / "gitops/charts" / chart)]
    if chart == "beluga-data":
        command += [
            "--set", f"trino.workerEnabled={str(worker).lower()}",
            "--set", f"openmetadata.enabled={str(metadata).lower()}",
            "--set", f"strimzi.oauthListener={str(oauth).lower()}",
            "--set", f"strimzi.aclAuthorizer={str(acl).lower()}",
        ]
        if external is not None:
            command += ["--set", f"strimzi.externalListenerEnabled={str(external).lower()}"]
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    return result.stdout


def parse_resources(manifest: str) -> list[dict]:
    resources = []
    for doc in yaml.safe_load_all(manifest):
        if doc is None:
            continue
        if not isinstance(doc, dict):
            raise ValueError("rendered YAML document must be a mapping")
        if doc.get("kind") == "List":
            resources.extend(item for item in doc.get("items", []) if isinstance(item, dict))
        else:
            resources.append(doc)
    return resources


def main() -> int:
    try:
        count = self_test()
        print(f"Kafka listener security self-test: {count} rule fixtures passed.", file=sys.stderr)
        rendered_violations: dict[str, str] = {}
        client_observations: dict[str, str] = {}
        all_listeners: dict[str, dict] = {}
        matrix = (
            (False, False, False, False, None),
            (True, True, False, False, None),
            (True, True, True, True, False),
            (False, False, False, False, True),
            (False, False, True, True, True),
        )
        for worker, metadata, oauth, acl, external in matrix:
            rendered = []
            for chart in ("beluga-platform", "beluga-data"):
                rendered.extend(parse_resources(render(chart, worker, metadata, oauth, acl, external)))
            for resource in rendered:
                if resource.get("kind") == "Kafka":
                    for listener in ((resource.get("spec") or {}).get("kafka") or {}).get("listeners", []):
                        if isinstance(listener, dict) and "name" in listener:
                            all_listeners[listener["name"]] = listener
            current = violations(rendered)
            rendered_violations.update(current)
            client_observations.update(violations.last_observations)

        # Assert incompatible 9092 clients are observed across the matrix profiles
        required_incompatible_clients = {
            "Deployment/streaming/debezium-connect/bootstrap",
            "Deployment/streaming/clickstream-gen/bootstrap",
        }
        if not required_incompatible_clients.issubset(set(client_observations)):
            raise AssertionError(
                f"CI matrix failed to observe incompatible 9092 clients: "
                f"{required_incompatible_clients - set(client_observations)}"
            )

        unexpected = set(rendered_violations) - set(BASELINE)
        stale = set(BASELINE) - set(rendered_violations)
        for key in sorted(set(rendered_violations) & set(BASELINE)):
            actual = rendered_violations[key]
            entry = BASELINE[key]
            # Find current attributes by their stable listener identity across all rendered profiles.
            listener_name = key.rsplit("/", 1)[-1]
            current_listener = all_listeners.get(listener_name)
            state = baseline_state(key, current_listener)
            if state == "changed":
                expected = entry["attributes"]
                found = None if current_listener is None else {field: current_listener.get(field) for field in expected}
                print(f"FAIL: baseline attributes changed for {key}: expected {expected}, found {found}", file=sys.stderr)
                unexpected.add(key)
            elif state == "stale":
                stale.add(key)
        for key in sorted(unexpected - set(BASELINE)):
            print(f"FAIL: new violation {key}: {rendered_violations[key]}", file=sys.stderr)
        for key in sorted(stale):
            print(f"FAIL: stale baseline entry must be removed: {key}", file=sys.stderr)
        if unexpected or stale:
            return 1
        print("Kafka listener security ratchet passed; frozen violations:")
        for key in sorted(BASELINE):
            print(f"- {key}: {BASELINE[key]['reason']} ({BASELINE[key]['issue']})")
        for key, message in sorted(client_observations.items()):
            print(f"- observed client: {key}: {message}")
        return 0
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError, AssertionError) as exc:
        print(f"FAIL: Kafka listener security: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
