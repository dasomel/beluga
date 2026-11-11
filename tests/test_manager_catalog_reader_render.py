"""Offline reader identity, profile wiring and bootstrap idempotency contract (#372)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

import yaml
from test_dbt_identity_render import assignments, container, document, replay_private_secret

ROOT = Path(__file__).resolve().parents[1]
CLIENT = "manager-catalog-reader"


def verify(platform, data, enabled=True):
    job = container(platform, "keycloak-clients")
    source = job["command"][-1]
    realm = json.loads(document(platform, "ConfigMap", "keycloak-realm")["data"]["beluga-realm.json"])
    identity = next(c for c in realm["clients"] if c["clientId"] == CLIENT)
    assert "secret" not in identity
    for key in ("publicClient", "bearerOnly", "standardFlowEnabled", "implicitFlowEnabled", "directAccessGrantsEnabled", "fullScopeAllowed"):
        assert identity[key] is False, key
    assert identity["serviceAccountsEnabled"] is True
    assert identity["defaultClientScopes"] == identity["optionalClientScopes"] == identity["redirectUris"] == identity["webOrigins"] == []
    env = assignments(source, {"CLIENT_REDIRECT_URIS", "CLIENT_ATTRIBUTES", "SERVICE_IDENTITIES", "SERVICE_MAPPERS", "CLIENT_SETTINGS", "CLIENT_SPECS"})
    assert env["CLIENT_SPECS"][CLIENT] == identity
    assert identity["protocolMappers"][0]["config"]["claim.value"] == "svc-manager-catalog-reader"
    assert identity["protocolMappers"][1]["config"]["included.client.audience"] == "lakekeeper"
    replay_private_secret(source, CLIENT)
    # Reuse server-default/drift/lost-write replay while retaining the reader's actual target values.
    from test_dbt_identity_render import replay
    replay(source, env["SERVICE_MAPPERS"][CLIENT], CLIENT)
    seed = document(platform, "ConfigMap", "openldap-seed-ldifs")["data"]["10-beluga-structure.ldif"]
    assert CLIENT not in seed
    ref = next(e for e in job["env"] if e["name"] == "CLIENT_SECRET_MANAGER_CATALOG_READER")["valueFrom"]["secretKeyRef"]
    assert ref == {"name": "keycloak-manager-catalog-reader-secret", "key": CLIENT}
    deploy = document(platform, "Deployment", "manager-domain-api")
    env = {e["name"]: e for e in deploy["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert ("BELUGA_LAKEKEEPER_ENABLED" in env) == enabled
    ingress = document(data, "NetworkPolicy", "lakekeeper-ingress")["spec"]["ingress"][0]
    peers = [p for p in ingress["from"] if p.get("podSelector", {}).get("matchLabels", {}).get("app") == "manager-domain-api"]
    assert len(peers) == int(enabled)
    if enabled:
        assert peers[0]["namespaceSelector"]["matchLabels"] == {"kubernetes.io/metadata.name": "platform-system"}
        assert ingress["ports"] == [{"protocol": "TCP", "port": 8181}]
        for key, value in {"BASE_URL": "http://lakekeeper.lakehouse.svc.cluster.local:8181", "WAREHOUSES": "iceberg=lake",
                           "TOKEN_ENDPOINT": "http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token",
                           "CLIENT_ID": CLIENT, "NAMES_ONLY": "true"}.items():
            assert env[f"BELUGA_LAKEKEEPER_{key}"]["value"] == value
        assert env["BELUGA_LAKEKEEPER_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"] == ref
    bootstrap = container(data, "lakekeeper-bootstrap")["args"][0]
    subprocess.run(["sh", "-n"], input=bootstrap, text=True, check=True)
    assert ('"oidc~svc-manager-catalog-reader"' in bootstrap) == enabled
    if enabled:
        replay_grant(bootstrap)


def replay_grant(source):
    """Run rendered grant logic against a synthetic curl, never a cluster."""
    start = source.index('ASSIGN_URL=')
    end = source.index('echo "Lakekeeper bootstrap completed', start)
    block = source[start:end]
    with tempfile.TemporaryDirectory(prefix="beluga-reader-grant-") as tmp:
        path = Path(tmp)
        mock = path / "curl"
        mock.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p=Path(os.environ['STATE'])
state=json.loads(p.read_text())
a=sys.argv[1:]
if '-X' not in a:
    if os.environ.get('FAIL_GET'): sys.exit(22)
    print(json.dumps({'assignments':state},separators=(',',':')))
else:
    data=json.loads(Path(a[a.index('--data-binary')+1][1:]).read_text())
    assert data['deletes']==[]
    for entry in data['writes']:
        if entry['user']=='oidc~svc-manager-catalog-reader': assert entry['type']=='describe'
        assert entry not in state
    if os.environ.get('FAIL_POST'): print('error\\n500'); sys.exit(0)
    state+=data['writes'];p.write_text(json.dumps(state));print('\\n204')
''')
        mock.chmod(0o755)
        state = path / "state.json"
        env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}", "STATE": str(state), "TMPDIR_L": tmp,
               "LAKEKEEPER_URL": "http://synthetic.invalid", "WAREHOUSE_ID": "synthetic", "AUTH_HEADER": "synthetic"}
        state.write_text('[]')
        for _ in range(2):
            subprocess.run(["sh", "-eu", "-c", block], env=env, check=True, capture_output=True)
        rows = json.loads(state.read_text())
        assert len(rows) == 9
        assert [r for r in rows if r['user'] == 'oidc~svc-manager-catalog-reader'] == [
            {"user": "oidc~svc-manager-catalog-reader", "type": "describe"}]
        state.write_text(json.dumps(rows[:-1]))
        subprocess.run(["sh", "-eu", "-c", block], env=env, check=True, capture_output=True)
        assert len(json.loads(state.read_text())) == 9
        for failure in ("FAIL_GET", "FAIL_POST"):
            state.write_text('[]')
            result = subprocess.run(["sh", "-eu", "-c", block], env={**env, failure: "1"}, capture_output=True)
            assert result.returncode != 0, failure


def main():
    for suffix in ("", "-ko"):
        index = (ROOT / f"docs/adr/README{suffix}.md").read_text()
        for page in (ROOT / "docs/adr").glob(f"*{suffix}.md"):
            if page.name.startswith("README") or (not suffix and page.stem.endswith("-ko")):
                continue
            assert f"]({page.name})" in index, page.name
        assert index.count("[ADR-0010]") == 1
    print("PASS: ADR bilingual indexes; ADR-0009 remains reserved by Manager SSO references")
    bootstrap = (ROOT / "scripts/gitops/01-argocd-bootstrap.sh").read_text()
    assert 'ensure_cred client-secret-manager-catalog-reader' in bootstrap
    assert 'CLIENT_SECRET_MANAGER_CATALOG_READER="$(get_cred client-secret-manager-catalog-reader)"' in bootstrap
    loop = next(b for b in bootstrap.split('for ns in ') if 'create secret generic keycloak-manager-catalog-reader-secret ' in b)
    assert loop.startswith('iam platform-system; do\n')
    assert '--from-literal=manager-catalog-reader="${CLIENT_SECRET_MANAGER_CATALOG_READER}"' in loop.split('done', 1)[0]
    shared = next(b for b in bootstrap.split('for ns in ') if b.startswith('iam analytics orchestration governance platform-system; do'))
    assert CLIENT not in shared.split('done', 1)[0]
    for profile in ("default", "full", "kakao", "disabled"):
        rendered = []
        for chart in ("beluga-platform", "beluga-data"):
            cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart)]
            if profile in ("full", "kakao"):
                cmd += ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]
            if profile == "kakao":
                if chart == "beluga-platform":
                    cmd += ["-f", str(ROOT / "gitops/charts/beluga-platform/values-kakao.yaml")]
                cmd += ["-f", str(ROOT / "gitops/values/domain-kakao.yaml")]
            # D-MCAT-7: set explicitly; the platform default is false until the image pin is bumped.
            cmd += ["--set", f"managerCatalogReader.enabled={str(profile != 'disabled').lower()}"]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            rendered.append([d for d in yaml.safe_load_all(result.stdout) if d])
            print("PASS:", " ".join(cmd))
        verify(*rendered, enabled=profile != "disabled")
        print(f"PASS: {profile}: reader identity/secret/privacy/reconcile, wiring/network, idempotent describe-only grant")


if __name__ == "__main__":
    main()
