"""Offline contract for Trino bearer-token audience enforcement (D-TAUD-1).

1. Trino validates JWT access tokens locally (use-userinfo-endpoint=false) instead of only
   asking the userinfo endpoint, which never checks `aud`.
2. Trino 483 still accepts JWTs with NO `aud` (NimbusOAuth2Client adds null to the accepted
   set), so every realm client that issues tokens must put an audience in them. Otherwise a
   token another service received at SSO login could be replayed to Trino.
3. The same audience mappers are reconciled idempotently on already-bootstrapped realms.
"""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import textwrap

import yaml
from test_dbt_identity_render import assignments, container, document

ROOT = Path(__file__).resolve().parents[1]
SETTING = "http-server.authentication.oauth2.oidc.use-userinfo-endpoint=false"
# client -> audience its own mapper must emit (trino keeps human logins to Trino working).
AUDIENCE_CLIENTS = {c: c for c in ("superset", "airflow", "openmetadata", "grafana", "apisix-gateway", "argocd")}
AUDIENCE_CLIENTS["trino"] = "trino"


def target(audience):
    return {"included.client.audience": audience, "id.token.claim": "false", "access.token.claim": "true"}


def render(chart, *extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


def emitted_audiences(client, scopes):
    """Audiences an access token of this client carries, from its own and its default scopes' mappers."""
    mappers = list(client.get("protocolMappers", []))
    for name in client.get("defaultClientScopes", []):
        mappers += scopes.get(name, {}).get("protocolMappers", [])
    return {m["config"]["included.client.audience"] for m in mappers
            if m["protocolMapper"] == "oidc-audience-mapper" and m["config"].get("access.token.claim") == "true"}


def verify_realm(realm, name):
    scopes = {s["name"]: s for s in realm.get("clientScopes", [])}
    for client in realm["clients"]:
        issues = client.get("standardFlowEnabled", True) or client.get("directAccessGrantsEnabled") or client.get("serviceAccountsEnabled")
        if not issues:
            continue
        audiences = emitted_audiences(client, scopes)
        # Every token-issuing client must emit an audience; only the trino client may emit `trino`
        # among the user-facing clients (service identities with aud=trino are deliberate).
        assert audiences, f"{name}: client {client['clientId']} issues tokens without aud (replayable to Trino)"
    for client_id, audience in AUDIENCE_CLIENTS.items():
        client = next(c for c in realm["clients"] if c["clientId"] == client_id)
        mappers = [m for m in client.get("protocolMappers", []) if m["name"] == f"{client_id} audience"]
        assert len(mappers) == 1 and mappers[0]["protocolMapper"] == "oidc-audience-mapper", (name, client_id)
        assert mappers[0]["config"] == target(audience), (name, client_id)
    for client in realm["clients"]:
        if client["clientId"] in ("superset", "airflow", "openmetadata", "grafana", "apisix-gateway", "argocd", "beluga-manager"):
            assert "trino" not in emitted_audiences(client, scopes), (name, client["clientId"])


def verify_job_created_clients(source, realm, name):
    """Clients the reconcile Job may create (CLIENT_SPECS) must also end up emitting an aud.

    Independent review of #454 (LOW-1): verify_realm only saw the realm import, so a user-facing client
    added only to CLIENT_SPECS without an audience would have stayed replayable to Trino unnoticed.
    """
    names = assignments(source, {"CLIENT_REDIRECT_URIS", "CLIENT_ATTRIBUTES", "SERVICE_IDENTITIES", "SERVICE_MAPPERS",
                                 "CLIENT_SETTINGS", "CLIENT_SPECS", "AUDIENCE_CLIENTS", "MANAGER_MAPPERS"})
    scopes = {s["name"]: s for s in realm.get("clientScopes", [])}
    reconciled = set(names["AUDIENCE_CLIENTS"])
    manager_aud = any(m["protocolMapper"] == "oidc-audience-mapper" for m in names["MANAGER_MAPPERS"])
    for client_id, spec in names["CLIENT_SPECS"].items():
        if not (spec.get("standardFlowEnabled", True) or spec.get("directAccessGrantsEnabled") or spec.get("serviceAccountsEnabled")):
            continue
        has_aud = bool(emitted_audiences(spec, scopes)) or client_id in reconciled or (client_id == "beluga-manager" and manager_aud)
        assert has_aud, f"{name}: Job-created client {client_id} would issue tokens without aud (replayable to Trino)"


def replay(source):
    """Run the rendered 6c block against a synthetic Keycloak admin API, never a cluster."""
    start = source.index("# 6c. D-TAUD-1")
    block = source[start:source.index("# 7. D-KCTHEME-3", start)]
    block = textwrap.dedent(block)
    client_map = {client_id: f"{client_id}-id" for client_id in AUDIENCE_CLIENTS}
    for state, expected in (("missing", "POST"), ("drifted", "PUT"), ("current", None)):
        calls = []

        def request(url, data=None, headers=None, method=None, sensitive=False):
            calls.append((method, url, data))
            if method == "POST":
                return 201, ""
            if method == "PUT":
                return 204, ""
            client_id = url.split("/clients/")[1].split("-id/")[0]
            mapper = {"id": "m1", "name": f"{client_id} audience", "protocolMapper": "oidc-audience-mapper",
                      "config": dict(target(AUDIENCE_CLIENTS[client_id]))}
            if state == "missing":
                return 200, json.dumps([])
            if state == "drifted":
                mapper["config"].update({"included.client.audience": "lakekeeper", "extra": "kept"})
            return 200, json.dumps([mapper])

        env = {"KC_BASE": "http://keycloak", "REALM": "beluga", "client_map": client_map,
               "get_admin_token": lambda: "synthetic", "make_req": request, "json": json, "sys": sys}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(block, env)
        writes = [c for c in calls if c[0] in ("POST", "PUT")]
        if expected is None:
            assert writes == [], writes
            continue
        assert sorted(w[1].split("/clients/")[1].split("-id/")[0] for w in writes) == sorted(AUDIENCE_CLIENTS), writes
        for method, url, body in writes:
            assert method == expected
            client_id = url.split("/clients/")[1].split("-id/")[0]
            assert body["protocolMapper"] == "oidc-audience-mapper"
            for key, value in target(AUDIENCE_CLIENTS[client_id]).items():
                assert body["config"][key] == value, (client_id, key)
            if expected == "PUT":
                assert body["config"]["extra"] == "kept"  # only target keys are corrected


def main():
    full = ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
    profiles = {"default": [], "full": full, "kakao": full + ["-f", str(ROOT / "gitops/values/domain-kakao.yaml")]}
    for name, extra in profiles.items():
        data = render("beluga-data", *extra)
        config = document(data, "Secret", "trino-coordinator-config")["stringData"]["config.properties"]
        lines = [line.strip() for line in config.splitlines()]
        assert SETTING in lines, name
        assert "http-server.authentication.oauth2.client-id=trino" in lines, name
        assert not any(line.startswith("http-server.authentication.oauth2.additional-audiences") for line in lines), name
        platform_extra = extra + (["-f", str(ROOT / "gitops/charts/beluga-platform/values-kakao.yaml")] if name == "kakao" else [])
        for toggles in ([], ["--set", "managerQueryHistory.enabled=true"]):
            platform = render("beluga-platform", *platform_extra, *toggles)
            realm = json.loads(document(platform, "ConfigMap", "keycloak-realm")["data"]["beluga-realm.json"])
            verify_realm(realm, name)
            source = container(platform, "keycloak-clients")["command"][-1]
            verify_job_created_clients(source, realm, name)
            replay(source)
        print(f"PASS: {name}: Trino validates JWTs locally; every realm client emits aud (import + 6c replay)")


if __name__ == "__main__":
    main()
