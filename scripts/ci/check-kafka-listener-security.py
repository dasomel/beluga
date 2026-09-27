#!/usr/bin/env python3
"""Ratchet gate for TLS and authentication on rendered Strimzi Kafka listeners."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CHARTS = ("beluga-platform", "beluga-data")
AUTH_TYPES = {"scram-sha-512", "tls", "oauth", "custom"}
# Issue #6: these known plaintext listeners are frozen debt. Remove entries when
# the chart is intentionally secured; any new or changed violation fails closed.
BASELINE = {
    "Kafka/streaming/beluga-kafka/listener/plain": {
        "reason": "internal plain listener has tls:false and no authentication",
        "issue": "#6",
    },
    "Kafka/streaming/beluga-kafka/listener/external": {
        "reason": "external nodeport listener has tls:false and no authentication",
        "issue": "#6",
    },
}


def identity(resource: dict) -> str:
    metadata = resource.get("metadata") or {}
    return f"{resource.get('kind')}/{metadata.get('namespace', 'default')}/{metadata.get('name')}"


def violations(resources: list[dict]) -> dict[str, str]:
    errors: dict[str, str] = {}
    kafkas = [r for r in resources if r.get("apiVersion", "").startswith("kafka.strimzi.io/")
              and r.get("kind") == "Kafka"]
    users = [r for r in resources if r.get("apiVersion", "").startswith("kafka.strimzi.io/")
             and r.get("kind") == "KafkaUser"]
    if not kafkas and not users:
        raise ValueError("rendered input contains zero relevant Kafka/KafkaUser objects")

    enabled_auth: dict[tuple[str, str], set[str]] = {}
    for kafka in kafkas:
        k_id = identity(kafka)
        listeners = (kafka.get("spec") or {}).get("kafka", {}).get("listeners")
        if not isinstance(listeners, list) or not listeners:
            errors[f"{k_id}/listener/<missing>"] = "Kafka has no listeners"
            continue
        namespace = (kafka.get("metadata") or {}).get("namespace", "default")
        auth_types = set()
        for listener in listeners:
            name = listener.get("name", "<missing>")
            lid = f"{k_id}/listener/{name}"
            auth = listener.get("authentication")
            if listener.get("tls") is not True:
                errors[lid] = "listener tls must be true"
            if not isinstance(auth, dict) or auth.get("type") not in AUTH_TYPES:
                errors[lid] = errors.get(lid, "") + ("; " if lid in errors else "") + "listener requires supported authentication"
            else:
                auth_types.add(auth["type"])
        enabled_auth[(namespace, kafka["metadata"]["name"])] = auth_types

    for user in users:
        spec = user.get("spec") or {}
        authorization = spec.get("authorization") or {}
        if authorization.get("type") != "simple":
            continue
        metadata = user.get("metadata") or {}
        uid = identity(user)
        auth = spec.get("authentication") or {}
        auth_type = auth.get("type") if isinstance(auth, dict) else None
        listeners = enabled_auth.get((metadata.get("namespace", "default"),
                                      (metadata.get("labels") or {}).get("strimzi.io/cluster", "")), set())
        if auth_type not in listeners:
            errors[f"{uid}/authentication"] = (
                f"KafkaUser authentication {auth_type!r} must match an enabled listener "
                f"for simple authorization (enabled: {sorted(listeners)})"
            )
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
      - {name: secure, port: 9092, tls: true, authentication: {type: scram-sha-512}}
"""
    if violations(parse(kafka)):
        raise AssertionError("secure listener fixture rejected")
    fixtures = [
        ("zero relevant resources", "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n", "zero relevant"),
        ("TLS disabled", kafka.replace("tls: true", "tls: false"), "tls must be true"),
        ("missing authentication", kafka.replace(", authentication: {type: scram-sha-512}", ""), "requires supported authentication"),
        ("unsupported authentication", kafka.replace("scram-sha-512", "basic"), "requires supported authentication"),
        ("missing listeners", kafka.replace("    listeners:\n      - {name: secure, port: 9092, tls: true, authentication: {type: scram-sha-512}}\n", "    listeners: []\n"), "no listeners"),
    ]
    for label, fixture, expected in fixtures:
        try:
            found = violations(parse(fixture))
        except ValueError as exc:
            found = {"error": str(exc)}
        if not any(expected in message for message in found.values()):
            raise AssertionError(f"self-test {label} did not fail as expected: {found}")
    user = """apiVersion: kafka.strimzi.io/v1
kind: KafkaUser
metadata: {name: user, namespace: streaming, labels: {strimzi.io/cluster: test}}
spec: {authorization: {type: simple}, authentication: {type: tls}}
"""
    if not any("must match" in message for message in violations(parse(kafka + "---\n" + user)).values()):
        raise AssertionError("KafkaUser authentication mismatch fixture was not rejected")
    user_ok = user.replace("type: tls", "type: scram-sha-512")
    if violations(parse(kafka + "---\n" + user_ok)):
        raise AssertionError("matching KafkaUser authentication fixture rejected")
    return len(fixtures) + 2


def render(chart: str, worker: bool, metadata: bool) -> str:
    command = ["helm", "template", str(REPO_ROOT / "gitops/charts" / chart)]
    if chart == "beluga-data":
        command += ["--set", f"trino.workerEnabled={str(worker).lower()}",
                    "--set", f"openmetadata.enabled={str(metadata).lower()}"]
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
        # env.sh and the bootstrap script expose only the paired default/profile toggles.
        # oauthListener is not enabled by either script, so no OAuth profile is deployed.
        for worker, metadata in ((False, False), (True, True)):
            rendered = []
            for chart in CHARTS:
                rendered.extend(parse_resources(render(chart, worker, metadata)))
            current = violations(rendered)
            for key, reason in current.items():
                rendered_violations.setdefault(key, reason)
        unexpected = set(rendered_violations) - set(BASELINE)
        stale = set(BASELINE) - set(rendered_violations)
        for key in sorted(unexpected):
            print(f"FAIL: new violation {key}: {rendered_violations[key]}", file=sys.stderr)
        for key in sorted(stale):
            print(f"FAIL: stale baseline entry must be removed: {key}", file=sys.stderr)
        if unexpected or stale:
            return 1
        print("Kafka listener security ratchet passed; frozen violations:")
        for key in sorted(BASELINE):
            print(f"- {key}: {BASELINE[key]['reason']} ({BASELINE[key]['issue']})")
        return 0
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError, AssertionError) as exc:
        print(f"FAIL: Kafka listener security: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
