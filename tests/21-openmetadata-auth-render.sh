#!/usr/bin/env bash
# Beluga Test 21: OpenMetadata confidential OIDC auth 및 truststore render 검증.
#
# OpenMetadata가 Keycloak confidential 클라이언트(Authorization Code 플로우, implicit 미사용)로
# 동작하도록 설정되었는지, JVM 트러스트스토어(내부 CA) 빌드 및 마운트가 구성되었는지,
# internal-ca-distribution에 governance 네임스페이스가 포함되었는지 정적 렌더로 단언한다.
set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

helm template gitops/charts/beluga-platform > "$TMP/platform.yaml"
helm template gitops/charts/beluga-data --set openmetadata.enabled=true > "$TMP/data.yaml"

python3 - "$TMP/platform.yaml" "$TMP/data.yaml" <<'PY'
import copy
import json
import sys
from pathlib import Path

import yaml

platform_path, data_path = map(Path, sys.argv[1:3])
platform_docs = [d for d in yaml.safe_load_all(platform_path.read_text()) if d]
data_docs = [d for d in yaml.safe_load_all(data_path.read_text()) if d]

def check(condition, message):
    if not condition:
        raise AssertionError(message)

def find_doc(docs, kind, name, namespace=None):
    for d in docs:
        if d.get("kind") == kind and d.get("metadata", {}).get("name") == name:
            if namespace is None or d.get("metadata", {}).get("namespace") == namespace:
                return d
    return None

def assert_openmetadata_deployment(docs):
    deploy = find_doc(docs, "Deployment", "openmetadata", "governance")
    check(deploy is not None, "Deployment openmetadata in governance not found")

    # 0. deployment strategy: Recreate (race-free single-replica rollout)
    strategy_type = deploy.get("spec", {}).get("strategy", {}).get("type")
    check(strategy_type == "Recreate",
          f"Deployment openmetadata strategy.type must be 'Recreate', got '{strategy_type}'")

    pod_spec = deploy["spec"]["template"]["spec"]

    # 1. initContainers: reseed-security-config and build-truststore
    init_containers = pod_spec.get("initContainers", [])

    # 1a. reseed-security-config
    reseed_c = next((c for c in init_containers if c.get("name") == "reseed-security-config"), None)
    check(reseed_c is not None, "initContainer reseed-security-config missing")
    check(reseed_c.get("image") == "openmetadata/server:1.13.3",
          "reseed-security-config image must be openmetadata/server:1.13.3")
    reseed_cmd = " ".join(reseed_c.get("command", []))
    check("openmetadata-ops.sh remove-security-config --force" in reseed_cmd,
          "reseed-security-config command must execute 'openmetadata-ops.sh remove-security-config --force'")
    reseed_env = {e["name"]: e.get("value") for e in reseed_c.get("env", []) if "name" in e}
    check(reseed_env.get("DB_HOST") == "postgres-main-rw.database.svc.cluster.local",
          "reseed-security-config must contain DB_HOST env")
    check(reseed_env.get("OM_DATABASE") == "openmetadata",
          "reseed-security-config must contain OM_DATABASE env")

    # 1b. build-truststore
    build_ts = next((c for c in init_containers if c.get("name") == "build-truststore"), None)
    check(build_ts is not None, "initContainer build-truststore missing")
    ts_cmd = " ".join(build_ts.get("command", []))
    check("keytool -importcert" in ts_cmd and "beluga-internal-ca" in ts_cmd,
          "build-truststore command must import beluga-internal-ca via keytool")
    check("truststore.p12" in ts_cmd, "build-truststore must output PKCS12 truststore.p12")

    # 2. main container env
    containers = pod_spec.get("containers", [])
    om_container = next((c for c in containers if c.get("name") == "openmetadata"), None)
    check(om_container is not None, "container openmetadata missing")

    env_map = {}
    for e in om_container.get("env", []):
        env_map[e["name"]] = e

    def get_val(name):
        return env_map.get(name, {}).get("value")

    # Client Type must be confidential (never public)
    client_type = get_val("AUTHENTICATION_CLIENT_TYPE")
    check(client_type == "confidential",
          f"AUTHENTICATION_CLIENT_TYPE must be 'confidential', got '{client_type}'")

    # Response Type must be code (never id_token — implicit flow disabled)
    auth_resp_type = get_val("AUTHENTICATION_RESPONSE_TYPE")
    check(auth_resp_type == "code",
          f"AUTHENTICATION_RESPONSE_TYPE must be 'code' (implicit flow id_token disabled), got '{auth_resp_type}'")

    oidc_resp_type = get_val("OIDC_RESPONSE_TYPE")
    check(oidc_resp_type == "code",
          f"OIDC_RESPONSE_TYPE must be 'code', got '{oidc_resp_type}'")

    # OIDC Configuration
    check(get_val("AUTHENTICATION_PROVIDER") == "custom-oidc", "AUTHENTICATION_PROVIDER must be custom-oidc")
    check(get_val("CUSTOM_OIDC_AUTHENTICATION_PROVIDER_NAME") == "keycloak", "Provider name must be keycloak")
    check(get_val("OIDC_CLIENT_ID") == "openmetadata", "OIDC_CLIENT_ID must be openmetadata")
    check(get_val("OIDC_TYPE") == "keycloak", "OIDC_TYPE must be keycloak")

    # Secret reference
    secret_ref = env_map.get("OIDC_CLIENT_SECRET", {}).get("valueFrom", {}).get("secretKeyRef", {})
    check(secret_ref.get("name") == "keycloak-client-secrets" and secret_ref.get("key") == "openmetadata",
          "OIDC_CLIENT_SECRET must reference keycloak-client-secrets/openmetadata")

    # URLs and Endpoints
    check(get_val("OIDC_SERVER_URL") == "https://metadata.local.beluga.internal",
          "OIDC_SERVER_URL must match baseDomain")
    check(get_val("OIDC_CALLBACK") == "https://metadata.local.beluga.internal/callback",
          "OIDC_CALLBACK must match baseDomain/callback")
    check(get_val("AUTHENTICATION_CALLBACK_URL") == "https://metadata.local.beluga.internal/callback",
          "AUTHENTICATION_CALLBACK_URL must match baseDomain/callback")
    check(get_val("OIDC_DISCOVERY_URI") == "https://sso.local.beluga.internal/realms/beluga/.well-known/openid-configuration",
          "OIDC_DISCOVERY_URI must point to Keycloak discovery")
    check(get_val("OIDC_SCOPE") == "openid email profile", "OIDC_SCOPE must include openid email profile")
    check(get_val("OIDC_PREFERRED_JWS") == "RS256", "OIDC_PREFERRED_JWS must be RS256")
    check(get_val("OIDC_PROMPT_TYPE") == "consent", "OIDC_PROMPT_TYPE must be consent")
    check(get_val("OIDC_OM_REFRESH_TOKEN_VALIDITY") == "3600", "OIDC_OM_REFRESH_TOKEN_VALIDITY must be 3600")

    # Authorizer configuration: beluga-admin and beluga.local (not open-metadata.org or admin)
    check(get_val("AUTHORIZER_ADMIN_PRINCIPALS") == "[beluga-admin]",
          "AUTHORIZER_ADMIN_PRINCIPALS must be '[beluga-admin]'")
    check(get_val("AUTHORIZER_PRINCIPAL_DOMAIN") == "beluga.local",
          "AUTHORIZER_PRINCIPAL_DOMAIN must be 'beluga.local'")

    # JVM truststore option in OPENMETADATA_OPTS
    om_opts = get_val("OPENMETADATA_OPTS") or ""
    check("-Djavax.net.ssl.trustStore=/etc/openmetadata/truststore/truststore.p12" in om_opts,
          "OPENMETADATA_OPTS must set javax.net.ssl.trustStore")

    # Volume mounts
    mounts = {m["name"]: m["mountPath"] for m in om_container.get("volumeMounts", [])}
    check(mounts.get("truststore-volume") == "/etc/openmetadata/truststore",
          "truststore-volume must be mounted to /etc/openmetadata/truststore")

    # Pod volumes
    volumes = {v["name"]: v for v in pod_spec.get("volumes", [])}
    check("truststore-volume" in volumes and "emptyDir" in volumes["truststore-volume"],
          "truststore-volume emptyDir missing")
    check("internal-ca" in volumes and volumes["internal-ca"].get("configMap", {}).get("name") == "beluga-internal-ca",
          "internal-ca configMap volume missing")

def assert_openmetadata_egress_netpol(docs):
    netpol = find_doc(docs, "NetworkPolicy", "openmetadata-egress", "governance")
    check(netpol is not None, "NetworkPolicy openmetadata-egress missing")
    egress_rules = netpol["spec"].get("egress", [])

    apisix_egress = False
    for rule in egress_rules:
        for to in rule.get("to", []):
            ns_match = to.get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name")
            pod_match = to.get("podSelector", {}).get("matchLabels", {}).get("app")
            if ns_match == "platform-system" and pod_match == "apisix":
                ports = [p.get("port") for p in rule.get("ports", [])]
                if 443 in ports:
                    apisix_egress = True
    check(apisix_egress, "openmetadata-egress must permit egress to platform-system/apisix on port 443")

def assert_keycloak_client(docs):
    cm = find_doc(docs, "ConfigMap", "keycloak-realm", "iam")
    check(cm is not None, "ConfigMap keycloak-realm in iam missing")
    realm = json.loads(cm["data"]["beluga-realm.json"])
    om_client = next((c for c in realm.get("clients", []) if c.get("clientId") == "openmetadata"), None)
    check(om_client is not None, "openmetadata client in keycloak realm missing")

    check(om_client.get("publicClient") is False, "Keycloak openmetadata client must not be publicClient")
    check(om_client.get("standardFlowEnabled") is True, "Keycloak openmetadata client must have standardFlowEnabled=True")
    check(om_client.get("directAccessGrantsEnabled") is False,
          "Keycloak openmetadata client must have directAccessGrantsEnabled=False (ROPC disabled)")
    uris = om_client.get("redirectUris", [])
    check(any("metadata.local.beluga.internal" in u for u in uris),
          "redirectUris must contain metadata.local.beluga.internal")

def assert_ca_distribution(docs):
    job = find_doc(docs, "Job", "internal-ca-distribution", "platform-system")
    check(job is not None, "Job internal-ca-distribution in platform-system missing")
    cmd = job["spec"]["template"]["spec"]["containers"][0]["command"][2]
    check('"governance"' in cmd, "internal-ca-distribution loop must include 'governance'")

    role = find_doc(docs, "Role", "internal-ca-distribution-writer", "governance")
    check(role is not None, "Role internal-ca-distribution-writer in governance missing")
    rb = find_doc(docs, "RoleBinding", "internal-ca-distribution-writer", "governance")
    check(rb is not None, "RoleBinding internal-ca-distribution-writer in governance missing")

# Positive assertion
assert_openmetadata_deployment(data_docs)
assert_openmetadata_egress_netpol(data_docs)
assert_keycloak_client(platform_docs)
assert_ca_distribution(platform_docs)
print("PASS: OpenMetadata confidential OIDC auth render contract verified.")

# Negative self-tests: verify that regressions are caught
bad_docs = copy.deepcopy(data_docs)
deploy = find_doc(bad_docs, "Deployment", "openmetadata", "governance")
env_list = deploy["spec"]["template"]["spec"]["containers"][0]["env"]
for e in env_list:
    if e["name"] == "AUTHENTICATION_CLIENT_TYPE":
        e["value"] = "public"

try:
    assert_openmetadata_deployment(bad_docs)
    raise AssertionError("negative self-check failed: public clientType was accepted")
except AssertionError as err:
    if "AUTHENTICATION_CLIENT_TYPE must be 'confidential'" not in str(err):
        raise
print("PASS: Negative self-check 1 (public clientType rejected) verified.")

bad_docs2 = copy.deepcopy(data_docs)
deploy2 = find_doc(bad_docs2, "Deployment", "openmetadata", "governance")
env_list2 = deploy2["spec"]["template"]["spec"]["containers"][0]["env"]
for e in env_list2:
    if e["name"] == "AUTHENTICATION_RESPONSE_TYPE":
        e["value"] = "id_token"

try:
    assert_openmetadata_deployment(bad_docs2)
    raise AssertionError("negative self-check failed: id_token responseType was accepted")
except AssertionError as err:
    if "implicit flow id_token disabled" not in str(err):
        raise
print("PASS: Negative self-check 2 (id_token rejected) verified.")

bad_platform = copy.deepcopy(platform_docs)
cm = find_doc(bad_platform, "ConfigMap", "keycloak-realm", "iam")
realm = json.loads(cm["data"]["beluga-realm.json"])
for c in realm["clients"]:
    if c.get("clientId") == "openmetadata":
        c["directAccessGrantsEnabled"] = True
cm["data"]["beluga-realm.json"] = json.dumps(realm)

try:
    assert_keycloak_client(bad_platform)
    raise AssertionError("negative self-check failed: directAccessGrantsEnabled=true was accepted")
except AssertionError as err:
    if "directAccessGrantsEnabled=False" not in str(err):
        raise
print("PASS: Negative self-check 3 (directAccessGrantsEnabled=true rejected) verified.")

bad_docs3 = copy.deepcopy(data_docs)
deploy3 = find_doc(bad_docs3, "Deployment", "openmetadata", "governance")
deploy3["spec"]["strategy"]["type"] = "RollingUpdate"

try:
    assert_openmetadata_deployment(bad_docs3)
    raise AssertionError("negative self-check failed: RollingUpdate strategy was accepted")
except AssertionError as err:
    if "strategy.type must be 'Recreate'" not in str(err):
        raise
print("PASS: Negative self-check 4 (RollingUpdate strategy rejected) verified.")

bad_docs4 = copy.deepcopy(data_docs)
deploy4 = find_doc(bad_docs4, "Deployment", "openmetadata", "governance")
inits4 = deploy4["spec"]["template"]["spec"]["initContainers"]
deploy4["spec"]["template"]["spec"]["initContainers"] = [c for c in inits4 if c.get("name") != "reseed-security-config"]

try:
    assert_openmetadata_deployment(bad_docs4)
    raise AssertionError("negative self-check failed: missing reseed-security-config was accepted")
except AssertionError as err:
    if "initContainer reseed-security-config missing" not in str(err):
        raise
print("PASS: Negative self-check 5 (missing reseed-security-config rejected) verified.")

PY
