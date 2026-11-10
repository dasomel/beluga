"""Offline identity contract and replay of the rendered service identity mapper reconciliation."""
import argparse
import ast
import copy
import contextlib
import io
import urllib.error
import urllib.request
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]


def document(docs, kind, name):
    return next(d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name)


def container(docs, name):
    return document(docs, "Job", name)["spec"]["template"]["spec"]["containers"][0]


def assignments(source, names):
    env = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in names for t in node.targets
        ):
            exec(compile(ast.Module(body=[node], type_ignores=[]), "rendered", "exec"), env)
    return env


def replay(source, targets, client_id):
    """Replay server defaults, drift repair, idempotency, and fail-closed checks."""
    block = source[source.index('# D-DBT-12:'):source.index('# 6. Task 16')]
    state = {"mappers": [], "default-client-scopes": [{"id": "profile"}],
             "optional-client-scopes": [{"id": "roles"}]}
    writes = []
    discard = False

    def stored_mapper(data):
        mapper = copy.deepcopy(data)
        mapper["config"].setdefault("introspection.token.claim", "true")
        if mapper["name"] == f"{client_id}-trino-audience":
            mapper["config"].setdefault("userinfo.token.claim", "false")
        return mapper

    def request(url, data=None, headers=None, method=None):
        path = url.split(f'/{client_id}-id/')[1]
        if method is None:
            value = state["mappers"] if path == "protocol-mappers/models" else state[path]
            return 200, json.dumps(value)
        writes.append((method, path))
        if discard:
            return 201 if method == "POST" else 204, ""
        if method == "DELETE":
            kind, scope_id = path.split('/')
            state[kind] = [s for s in state[kind] if s["id"] != scope_id]
        elif method == "POST":
            state["mappers"].append({**stored_mapper(data), "id": str(len(state["mappers"]))})
        elif method == "PUT":
            state["mappers"] = [stored_mapper(data) if m["id"] == data["id"] else m
                                for m in state["mappers"]]
        return 201 if method == "POST" else 204, ""

    env = {"clients_url": "http://keycloak/admin/realms/beluga/clients",
           "client_map": {client_id: f"{client_id}-id"}, "SERVICE_MAPPERS": {client_id: targets},
           "make_req": request, "get_admin_token": lambda: "synthetic", "json": json, "sys": sys}
    exec(block, env)
    assert not state["default-client-scopes"] and not state["optional-client-scopes"]
    assert all(m["config"]["introspection.token.claim"] == "true" for m in state["mappers"])
    assert state["mappers"][1]["config"]["userinfo.token.claim"] == "false"
    writes.clear()
    exec(block, env)
    assert writes == [], writes
    state["mappers"][0]["config"]["claim.value"] = "wrong-user"
    state["mappers"][0]["config"]["userinfo.token.claim"] = "false"
    exec(block, env)
    assert state["mappers"][0]["config"]["claim.value"] == f"svc-{client_id}"
    assert state["mappers"][0]["config"]["userinfo.token.claim"] == "true"
    writes.clear()
    exec(block, env)
    assert writes == [], writes
    valid_mappers = copy.deepcopy(state["mappers"])
    discard = True
    for missing in (False, True):
        state["mappers"] = copy.deepcopy(valid_mappers)
        if missing:
            del state["mappers"][0]["config"]["claim.value"]
        else:
            state["mappers"][0]["config"]["claim.value"] = "tampered"
        try:
            exec(block, env)
        except SystemExit as error:
            assert error.code != 0
        else:
            raise AssertionError(f"mapper verification accepted invalid target key: missing={missing}")
    state["mappers"] = []
    try:
        exec(block, env)
    except SystemExit as error:
        assert error.code != 0
        pass
    else:
        raise AssertionError("mapper verification accepted lost writes")

    for scope_kind in ("default-client-scopes", "optional-client-scopes"):
        state["mappers"] = copy.deepcopy(valid_mappers)
        state[scope_kind] = [{"id": "stuck"}]
        try:
            exec(block, env)
        except SystemExit as error:
            assert error.code != 0
        else:
            raise AssertionError("scope verification accepted lost deletion")
        state[scope_kind] = []


def replay_private_secret(source):
    """A new maintenance secret must never reach legacy prefix or HTTP-body logs."""
    start = source.index('for client_id_name, target_secret in CLIENT_SECRETS.items():')
    block = source[start:source.index('# 5. Task 16', start)]
    secret = "synthetic-maintenance-secret"
    state = {"value": "old-synthetic-secret"}
    writes = []
    discard = False
    def request(url, data=None, headers=None, method=None, sensitive=False):
        assert sensitive, "maintenance used a logging transport"
        if method == "PUT":
            writes.append(data)
            if not discard:
                state["value"] = data["secret"]
            return 204, ""
        return 200, json.dumps(state)
    env = {"CLIENT_SECRETS": {"maintenance": secret}, "client_map": {"maintenance": "id"},
           "KC_BASE": "http://keycloak", "REALM": "beluga", "get_admin_token": lambda: "synthetic-token",
           "json": json, "sys": sys, "make_req": request}
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(block, env)
        assert state["value"] == secret and len(writes) == 1
        exec(block, env)
        assert len(writes) == 1
        discard = True
        state["value"] = "wrong"
        try:
            exec(block, env)
        except SystemExit as error:
            assert error.code != 0
        else:
            raise AssertionError("credential verification accepted lost write")
    assert output.getvalue() == "", output.getvalue()
    # Exercise the real rendered HTTP helper with a malicious body/exception string.
    helper = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "make_req")
    env = {"json": json, "urllib": __import__("urllib")}
    exec(compile(ast.Module(body=[helper], type_ignores=[]), "rendered", "exec"), env)
    for error in (urllib.error.HTTPError("http://keycloak", 400, "bad", {}, io.BytesIO(secret.encode())),
                  RuntimeError(secret)):
        output = io.StringIO()
        with patch('urllib.request.urlopen', side_effect=error), contextlib.redirect_stdout(output):
            try:
                env["make_req"]("http://keycloak", data={"secret": secret}, sensitive=True)
            except RuntimeError as failure:
                assert secret not in str(failure)
            else:
                raise AssertionError("private transport accepted failure")
        assert output.getvalue() == ""


def verify(platform, data, domain, evidence):
    replay_private_secret(container(platform, "keycloak-clients")["command"][-1])
    realm = json.loads(document(platform, "ConfigMap", "keycloak-realm")["data"]["beluga-realm.json"])
    for client_id, group_name in (("dbt", "transformers"), ("maintenance", "maintainers")):
        identity = next(c for c in realm["clients"] if c["clientId"] == client_id)
        assert "secret" not in identity
        assert identity["serviceAccountsEnabled"] and not identity["publicClient"]
        for field in ("standardFlowEnabled", "implicitFlowEnabled", "directAccessGrantsEnabled", "fullScopeAllowed"):
            assert identity[field] is False, field
        assert identity["defaultClientScopes"] == identity["optionalClientScopes"] == []
        principal, audience = identity["protocolMappers"]
        assert principal["protocolMapper"] == "oidc-hardcoded-claim-mapper"
        assert principal["config"]["claim.name"] == "preferred_username"
        assert principal["config"]["claim.value"] == f"svc-{client_id}"
        assert principal["config"]["userinfo.token.claim"] == "true"
        assert audience["protocolMapper"] == "oidc-audience-mapper"
        assert audience["config"]["included.client.audience"] == "trino"
        assert all(m["config"]["access.token.claim"] == "true" for m in identity["protocolMappers"])
        job = container(platform, "keycloak-clients")
        ref = next(e for e in job["env"] if e["name"] == f"CLIENT_SECRET_{client_id.upper()}")["valueFrom"]["secretKeyRef"]
        assert ref == {"name": f"keycloak-{client_id}-client-secret", "key": client_id}
        source = job["command"][-1]
        env = assignments(source, {"CLIENT_REDIRECT_URIS", "CLIENT_ATTRIBUTES", "SERVICE_IDENTITIES", "SERVICE_MAPPERS", "CLIENT_SETTINGS", "CLIENT_SPECS"})
        assert env["SERVICE_MAPPERS"][client_id] == identity["protocolMappers"]
        for k, v in env["CLIENT_SETTINGS"][client_id].items():
            assert identity[k] == v, k
        assert env["CLIENT_SPECS"][client_id] == identity
        replay(source, env["SERVICE_MAPPERS"][client_id], client_id)
    for doc in platform:
        if doc["kind"] == "Job":
            for c in doc["spec"]["template"]["spec"]["containers"]:
                if c.get("command", [])[:2] == ["python3", "-c"]:
                    compile(c["command"][2], doc["metadata"]["name"], "exec")
    seed = document(platform, "ConfigMap", "openldap-seed-ldifs")["data"]["10-beluga-structure.ldif"]
    entries = seed.strip().split('\n\n')
    for client_id, group_name in (("dbt", "transformers"), ("maintenance", "maintainers")):
        user = next(e for e in entries if e.startswith(f"dn: uid=svc-{client_id},"))
        group = next(e for e in entries if e.startswith(f"dn: cn={group_name},"))
        assert "userPassword" not in user
        assert f"member: uid=svc-{client_id},ou=users,dc=beluga,dc=internal" in group
        ldap_source = container(platform, "openldap-init")["command"][-1]
        assert f'add_member_if_missing "cn={group_name},ou=groups,$BASE_DN" "uid=svc-{client_id},ou=users,$BASE_DN"' in ldap_source
        (evidence / f"{client_id}-client.json").write_text(json.dumps(
            next(c for c in realm["clients"] if c["clientId"] == client_id), indent=2) + '\n')
    subprocess.run(["sh", "-n"], input=ldap_source, text=True, check=True)
    kc = document(platform, "Deployment", "keycloak")["spec"]["template"]["spec"]["containers"][0]
    assert f"--hostname=https://sso.{domain}" in kc.get("args", []) + kc.get("command", [])
    trino = '\n'.join(str(d.get("data", {})) + str(d.get("stringData", {})) for d in data)
    assert f"oauth2.issuer=https://sso.{domain}/realms/beluga" in trino
    assert "oauth2.oidc.use-userinfo-endpoint=" not in trino
    assert "oauth2.principal-field=preferred_username" in trino
    assert "oauth2.client-id=trino" in trino
    (evidence / "identity-jobs.yaml").write_text(yaml.safe_dump_all([
        document(platform, "Job", n) for n in ("keycloak-clients", "openldap-init")]))


def verify_token_request():
    source = (ROOT / "gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py").read_text()
    bootstrap = assignments(source, {"BOOTSTRAP"})["BOOTSTRAP"]
    calls = []
    environment = {"DBT_CLIENT_SECRET": "synthetic-secret"}

    def post(url, data, timeout):
        assert url == "http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token"
        assert data == {"grant_type": "client_credentials", "client_id": "dbt",
                        "scope": "openid", "client_secret": "synthetic-secret"}
        assert timeout == 30
        return SimpleNamespace(raise_for_status=lambda: None,
                               json=lambda: {"access_token": "synthetic-token"})

    fake_os = SimpleNamespace(environ=environment, execvp=lambda *args: calls.append(args))
    with patch.dict(sys.modules, {"os": fake_os, "requests": SimpleNamespace(post=post)}):
        exec(bootstrap, {})
    assert "DBT_CLIENT_SECRET" not in environment
    assert environment["DBT_ENV_SECRET_TRINO_JWT"] == "synthetic-token"
    assert calls == [("dbt", ["dbt", "build", "--target", "trino", "--project-dir", "/opt/beluga/dbt"])]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.output_dir is None:
        args.output_dir = Path(tempfile.mkdtemp(prefix="beluga-dbt-identity-"))
    verify_token_request()
    bootstrap = (ROOT / "scripts/gitops/01-argocd-bootstrap.sh").read_text()
    for expected in ('ensure_cred client-secret-dbt', 'CLIENT_SECRET_DBT="$(get_cred client-secret-dbt)"',
                     '--from-literal=client-secret-dbt="$(openssl rand -hex 16)"',
                     '--from-literal=dbt="${CLIENT_SECRET_DBT}"',
                     'for ns in iam analytics orchestration governance platform-system; do'):
        assert expected in bootstrap, expected
    loops = bootstrap.split('for ns in ')
    shared = next(b for b in loops if b.startswith('iam analytics orchestration governance platform-system; do'))
    dedicated = next(b for b in loops if 'create secret generic keycloak-dbt-client-secret ' in b)
    assert '--from-literal=dbt=' not in shared.split('done', 1)[0]
    assert dedicated.startswith('iam analytics; do\n')
    assert '--from-literal=dbt="${CLIENT_SECRET_DBT}"' in dedicated.split('done', 1)[0]
    dag = (ROOT / "gitops/charts/beluga-data/files/dags/dbt_shop_medallion.py").read_text()
    assert 'V1SecretKeySelector(name="keycloak-dbt-client-secret", key="dbt")' in dag
    for profile in ("default", "full", "kakao"):
        evidence = args.output_dir / profile
        evidence.mkdir(parents=True, exist_ok=True)
        rendered = []
        for chart in ("beluga-platform", "beluga-data"):
            command = ["helm", "template", str(ROOT / "gitops/charts" / chart)]
            if profile != "default":
                command += ["-f", str(ROOT / "gitops/values/sso.yaml"),
                            "-f", str(ROOT / "gitops/values/profile-full.yaml")]
            if profile == "kakao":
                if chart == "beluga-platform":
                    command += ["-f", str(ROOT / "gitops/charts/beluga-platform/values-kakao.yaml")]
                command += ["-f", str(ROOT / "gitops/values/domain-kakao.yaml")]
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            (evidence / f"{chart}.yaml").write_text(result.stdout)
            rendered.append([d for d in yaml.safe_load_all(result.stdout) if d])
            print("PASS:", " ".join(command))
        verify(*rendered, "kakao.beluga.internal" if profile == "kakao" else "local.beluga.internal", evidence)
        print(f"PASS: {profile}: client/secret/LDAP/issuer/UserInfo render; mapper server defaults, drift repair, idempotency, differing/missing-key and lost-write rejection")


if __name__ == "__main__":
    main()
