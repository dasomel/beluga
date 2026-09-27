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
        "reason": "internal plain listener has tls:false and no authentication",
        "issue": "#6",
    },
    "Kafka/streaming/beluga-kafka/listener/external": {
        "attributes": {"name": "external", "port": 9094, "type": "nodeport", "tls": False, "authentication": None},
        "reason": "external nodeport listener has tls:false and no authentication",
        "issue": "#6",
    },
    "Kafka/streaming/beluga-kafka/listener/oauth": {
        "attributes": {"name": "oauth", "port": 9093, "type": "internal", "tls": False, "authentication": {"type": "oauth", "validIssuerUri": "https://sso.local.beluga.internal/realms/beluga", "jwksEndpointUri": "https://sso.local.beluga.internal/realms/beluga/protocol/openid-connect/certs", "userNameClaim": "preferred_username"}},
        "reason": "toggle not enabled by bootstrap; OAuth listener has tls:false (#6)",
        "issue": "#6",
    },
}


def identity(resource: dict) -> str:
    metadata = resource.get("metadata") or {}
    return f"{resource.get('kind')}/{metadata.get('namespace', 'default')}/{metadata.get('name')}"


def compliant(listener: dict) -> bool:
    auth = listener.get("authentication")
    return listener.get("tls") is True and isinstance(auth, dict) and auth.get("type") in AUTH_TYPES


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
        compliant_listener = dict(entry["attributes"], tls=True, authentication={"type": "scram-sha-512"})
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
    oauth_kafka = kafka.replace("type: scram-sha-512", "type: oauth")
    if violations(parse(oauth_kafka + "---\n" + oauth_user)):
        raise AssertionError("OAuth-only KafkaUser omission should be accepted")
    return len(fixtures) + 5


def render(chart: str, worker: bool, metadata: bool, oauth: bool = False, acl: bool = False) -> str:
    command = ["helm", "template", str(REPO_ROOT / "gitops/charts" / chart)]
    if chart == "beluga-data":
        command += ["--set", f"trino.workerEnabled={str(worker).lower()}",
                    "--set", f"openmetadata.enabled={str(metadata).lower()}",
                    "--set", f"strimzi.oauthListener={str(oauth).lower()}",
                    "--set", f"strimzi.aclAuthorizer={str(acl).lower()}"]
    result = subprocess.run(command, capture_output=True, text=True, check=True,
                            env={**os.environ, "KUBECONFIG": os.devnull})
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
        for worker, metadata, oauth, acl in ((False, False, False, False), (True, True, False, False), (True, True, True, True)):
            rendered = []
            for chart in ("beluga-platform", "beluga-data"):
                rendered.extend(parse_resources(render(chart, worker, metadata, oauth, acl)))
            current = violations(rendered)
            rendered_violations.update(current)
            client_observations.update(violations.last_observations)

        unexpected = set(rendered_violations) - set(BASELINE)
        stale = set(BASELINE) - set(rendered_violations)
        for key in sorted(set(rendered_violations) & set(BASELINE)):
            actual = rendered_violations[key]
            entry = BASELINE[key]
            # Find current attributes by their stable listener identity.
            listener_name = key.rsplit("/", 1)[-1]
            current_listener = next((listener for resource in rendered for listener in ((resource.get("spec") or {}).get("kafka") or {}).get("listeners", [])
                                     if resource.get("kind") == "Kafka" and listener.get("name") == listener_name), None)
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
