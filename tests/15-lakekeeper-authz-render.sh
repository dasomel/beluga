#!/usr/bin/env bash
set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

helm template gitops/charts/beluga-platform > "$TMP/platform.yaml"
helm template gitops/charts/beluga-data --set lakekeeper.openfga.enabled=true > "$TMP/on.yaml"
helm template gitops/charts/beluga-data --set lakekeeper.openfga.enabled=false > "$TMP/off.yaml"
python3 - "$TMP/platform.yaml" "$TMP/on.yaml" "$TMP/off.yaml" <<'PY'
import json
import re
import sys
from pathlib import Path

import yaml

platform_path, on_path, off_path = map(Path, sys.argv[1:])
platform = list(yaml.safe_load_all(platform_path.read_text()))
enabled = list(yaml.safe_load_all(on_path.read_text()))
disabled = list(yaml.safe_load_all(off_path.read_text()))

def check(condition, message):
    if not condition:
        raise AssertionError(message)

def find(docs, kind, name, namespace=None):
    return next(d for d in docs if d and d.get("kind") == kind
                and d.get("metadata", {}).get("name") == name
                and (namespace is None or d["metadata"].get("namespace") == namespace))

def check_env_order(docs):
    for doc in docs:
        if not doc:
            continue
        spec = doc.get("spec", {}).get("template", {}).get("spec", {})
        for container in spec.get("initContainers", []) + spec.get("containers", []):
            seen = set()
            for env in container.get("env", []):
                value = env.get("value", "")
                for var in re.findall(r"\$\(([^)]+)\)", value):
                    check(var in seen, f"{doc['metadata']['name']}/{container['name']}: {var} referenced before declaration")
                seen.add(env.get("name"))

def assert_contract(on, platform_docs):
    deployment = find(platform_docs, "Deployment", "openfga", "iam")
    pod = deployment["spec"]["template"]["spec"]
    container = pod["containers"][0]
    ports = [p.get("containerPort") for p in container.get("ports", [])]
    check(3000 not in ports and container["env"] and
          {e["name"]: e.get("value") for e in container["env"]}.get("OPENFGA_PLAYGROUND_ENABLED") == "false",
          "OpenFGA playground must be disabled and port 3000 absent")
    env = container["env"]
    vals = {e["name"]: e for e in env}
    check(vals["OPENFGA_AUTHN_METHOD"]["value"] == "preshared" and
          vals["OPENFGA_AUTHN_PRESHARED_KEYS"]["valueFrom"]["secretKeyRef"]["name"] == "openfga-authn-credential",
          "OpenFGA preshared authentication missing")
    policy = find(platform_docs, "NetworkPolicy", "openfga-ingress", "iam")
    check(policy["spec"]["podSelector"].get("matchLabels", {}).get("app") == "openfga", "OpenFGA ingress policy missing")
    from_apps = policy["spec"]["ingress"][0]["from"][0]["podSelector"]["matchExpressions"][0]["values"]
    check(set(from_apps) == {"lakekeeper", "lakekeeper-migrate", "lakekeeper-bootstrap"}, "OpenFGA ingress sources mismatch")
    keycloak = find(platform_docs, "Job", "keycloak-clients", "iam")
    # Scope definitions are in JSON embedded in the reconcile command.
    source = json.dumps(keycloak.get("spec", {}))
    clients = [line for line in source.splitlines()]
    rendered = platform_path.read_text()
    check('"clientId": "flink"' in rendered and '"clientId": "lakekeeper-admin"' in rendered,
          "service clients missing")
    for client in ("flink", "lakekeeper-admin"):
        start = rendered.index(f'"clientId": "{client}"')
        section = rendered[start:start + 450]
        check('"profile"' in section and '"defaultClientScopes"' in section,
              f"{client} default profile scope missing")
    lk = find(on, "Deployment", "lakekeeper", "lakehouse")
    lk_container = lk["spec"]["template"]["spec"]["containers"][0]
    lk_env = {e["name"]: e for e in lk_container["env"]}
    check(lk_env["LAKEKEEPER__OPENFGA__API_KEY"]["valueFrom"]["secretKeyRef"]["name"] == "openfga-authn-credential", "Lakekeeper OpenFGA API key missing")
    check(lk_env.get("SSL_CERT_FILE", {}).get("value") == "/etc/beluga-ca/ca.crt", "Lakekeeper CA trust missing")
    check("beluga-internal-ca" in json.dumps(lk["spec"]["template"]["spec"].get("volumes", [])), "Lakekeeper CA volume missing")
    check('"oidc~admin"' not in json.dumps(lk_env.get("LAKEKEEPER__INSTANCE_ADMINS")), "human instance admin still configured")
    check_env_order(on)
    check_env_order(platform_docs)

assert_contract(enabled, platform)
check(not any(d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == "lakekeeper"
              and any(e.get("name") == "LAKEKEEPER__OPENID_PROVIDER_URI" for e in d["spec"]["template"]["spec"]["containers"][0].get("env", [])) for d in disabled),
      "disabled rendering unexpectedly has authz configuration")
values = yaml.safe_load(Path("gitops/charts/beluga-data/values.yaml").read_text())
check(values["lakekeeper"]["openfga"]["enabled"] is True, "values.yaml must keep Lakekeeper OpenFGA enabled")
check(find(enabled, "Job", "lakekeeper-migrate")["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "-2", "migration wave missing")
check(find(enabled, "Job", "lakekeeper-bootstrap")["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "0", "bootstrap wave missing")
check(find(enabled, "Job", "flink-sql-submit")["metadata"]["annotations"]["argocd.argoproj.io/sync-wave"] == "1", "Flink submit wave missing")

# Negative self-checks: weakened copies must be rejected by the same assertions.
bad = list(platform)
openfga = find(bad, "Deployment", "openfga", "iam")
openfga["spec"]["template"]["spec"]["containers"][0]["ports"].append({"containerPort": 3000})
try:
    assert_contract(enabled, bad)
except AssertionError:
    pass
else:
    raise AssertionError("negative self-check accepted an exposed OpenFGA playground")
print("Lakekeeper authorization YAML contract passed (enabled/disabled, env ordering, and negative self-check).")
PY
