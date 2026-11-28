"""Offline Manager Trino query-history identity, wiring and bootstrap contract (ADR-0012)."""
import json
from pathlib import Path
import subprocess

import yaml
from test_dbt_identity_render import assignments, container, document, replay, replay_private_secret

ROOT = Path(__file__).resolve().parents[1]
CLIENT = "manager-query-history"
SECRET = {"name": "keycloak-manager-query-history-secret", "key": CLIENT}
TOKEN_ENDPOINT = "http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token"


def verify(platform, enabled):
    job = container(platform, "keycloak-clients")
    source = job["command"][-1]
    realm = json.loads(document(platform, "ConfigMap", "keycloak-realm")["data"]["beluga-realm.json"])
    identity = next((c for c in realm["clients"] if c["clientId"] == CLIENT), None)
    refs = [e for e in job["env"] if e["name"] == "CLIENT_SECRET_MANAGER_QUERY_HISTORY"]
    deploy = document(platform, "Deployment", "manager-domain-api")
    env = {e["name"]: e for e in deploy["spec"]["template"]["spec"]["containers"][0]["env"]}
    if not enabled:
        # Disabled: no client, no Secret reference anywhere (an absent Secret must not break the Job),
        # and no Trino wiring, so the deployed image keeps returning 503.
        assert identity is None
        assert refs == []
        names = assignments(source, {"SERVICE_IDENTITIES"})
        assert CLIENT not in names["SERVICE_IDENTITIES"]
        assert "CLIENT_SECRET_MANAGER_QUERY_HISTORY" not in source
        assert not any(name.startswith("BELUGA_TRINO_") for name in env)
        return
    assert "secret" not in identity
    for key in ("publicClient", "bearerOnly", "standardFlowEnabled", "implicitFlowEnabled", "directAccessGrantsEnabled", "fullScopeAllowed"):
        assert identity[key] is False, key
    assert identity["serviceAccountsEnabled"] is True
    assert identity["defaultClientScopes"] == identity["optionalClientScopes"] == identity["redirectUris"] == identity["webOrigins"] == []
    assert identity["protocolMappers"][0]["config"]["claim.value"] == "svc-manager-query-history"
    assert identity["protocolMappers"][1]["config"]["included.client.audience"] == "trino"
    names = assignments(source, {"CLIENT_REDIRECT_URIS", "CLIENT_ATTRIBUTES", "SERVICE_IDENTITIES", "SERVICE_MAPPERS", "CLIENT_SETTINGS", "CLIENT_SPECS"})
    # Realm import and the reconcile Job declare the same client.
    assert names["CLIENT_SPECS"][CLIENT] == identity
    assert names["SERVICE_IDENTITIES"][CLIENT] == ("svc-manager-query-history", "trino")
    replay_private_secret(source, CLIENT)
    replay(source, names["SERVICE_MAPPERS"][CLIENT], CLIENT)
    assert [r["valueFrom"]["secretKeyRef"] for r in refs] == [SECRET]
    # No LDAP entry: Trino lists only the caller's own queries without an OPA grant.
    seed = document(platform, "ConfigMap", "openldap-seed-ldifs")["data"]["10-beluga-structure.ldif"]
    assert CLIENT not in seed and "svc-manager-query-history" not in seed
    expected = {"BELUGA_TRINO_ENABLED": "true", "BELUGA_TRINO_BASE_URL": "https://trino.analytics.svc.cluster.local:8443",
                "BELUGA_TRINO_TOKEN_ENDPOINT": TOKEN_ENDPOINT, "BELUGA_TRINO_CLIENT_ID": CLIENT,
                "BELUGA_TRINO_HISTORY_ACK": "shared-service-credential", "BELUGA_UPSTREAM_ALLOW_INSECURE_BEARER": "true"}
    for name, value in expected.items():
        assert env[name]["value"] == value, name
    assert env["BELUGA_TRINO_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"] == SECRET
    # Static token sources would conflict with client_credentials (fail-fast in domain-api).
    assert "BELUGA_TRINO_TOKEN" not in env and "BELUGA_TRINO_TOKEN_FILE" not in env
    assert env["NODE_EXTRA_CA_CERTS"]["value"] == "/etc/internal-ca/ca.crt"


def main():
    index = {suffix: (ROOT / f"docs/adr/README{suffix}.md").read_text() for suffix in ("", "-ko")}
    for text in index.values():
        assert text.count("[ADR-0012]") == 1
    bootstrap = (ROOT / "scripts/gitops/01-argocd-bootstrap.sh").read_text()
    assert "ensure_cred client-secret-manager-query-history" in bootstrap
    assert 'CLIENT_SECRET_MANAGER_QUERY_HISTORY="$(get_cred client-secret-manager-query-history)"' in bootstrap
    loop = next(b for b in bootstrap.split("for ns in ") if "create secret generic keycloak-manager-query-history-secret " in b)
    assert loop.startswith("iam platform-system; do\n")
    assert '--from-literal=manager-query-history="${CLIENT_SECRET_MANAGER_QUERY_HISTORY}"' in loop.split("done", 1)[0]
    shared = next(b for b in bootstrap.split("for ns in ") if b.startswith("iam analytics orchestration governance platform-system; do"))
    assert CLIENT not in shared.split("done", 1)[0]
    print("PASS: ADR-0012 indexed; bootstrap creates a dedicated Secret only in iam and platform-system")
    for profile in ("default", "full", "kakao"):
        for enabled in (False, True):
            cmd = ["helm", "template", str(ROOT / "gitops/charts/beluga-platform")]
            if profile in ("full", "kakao"):
                cmd += ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
            if profile == "kakao":
                cmd += ["-f", str(ROOT / "gitops/charts/beluga-platform/values-kakao.yaml"), "-f", str(ROOT / "gitops/values/domain-kakao.yaml")]
            cmd += ["--set", f"managerQueryHistory.enabled={str(enabled).lower()}"]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            verify([d for d in yaml.safe_load_all(result.stdout) if d], enabled)
            print(f"PASS: {profile} enabled={enabled}: identity/secret/reconcile/wiring")


if __name__ == "__main__":
    main()
