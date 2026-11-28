"""Offline contract for Trino bearer-token audience enforcement (D-TAUD-1).

Trino must validate JWT access tokens locally (aud must contain client-id `trino`) instead of
only calling the userinfo endpoint, and the `trino` Keycloak client must put `trino` in the
audience of the tokens it issues, both in the realm import and on already-bootstrapped realms.
"""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys

import yaml
from test_dbt_identity_render import container, document

ROOT = Path(__file__).resolve().parents[1]
SETTING = "http-server.authentication.oauth2.oidc.use-userinfo-endpoint=false"
TARGET = {"included.client.audience": "trino", "id.token.claim": "false", "access.token.claim": "true"}


def render(chart, *extra):
    cmd = ["helm", "template", str(ROOT / "gitops/charts" / chart), *extra]
    return [d for d in yaml.safe_load_all(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout) if d]


def replay(source):
    """Run the rendered 6c block against a synthetic Keycloak admin API, never a cluster."""
    start = source.index("# 6c. D-TAUD-1")
    block = source[start:source.index("# 7. D-KCTHEME-3", start)]
    block = "\n".join(line[14:] if line.startswith(" " * 14) else line for line in block.splitlines())
    for initial, expected in (
        ([], "POST"),
        ([{"id": "m1", "name": "trino audience", "protocolMapper": "oidc-audience-mapper",
           "config": {**TARGET, "included.client.audience": "lakekeeper", "extra": "kept"}}], "PUT"),
        ([{"id": "m1", "name": "trino audience", "protocolMapper": "oidc-audience-mapper", "config": dict(TARGET)}], None),
    ):
        calls = []

        def request(url, data=None, headers=None, method=None, sensitive=False):
            calls.append((method, url, data))
            if method == "POST":
                return 201, ""
            if method == "PUT":
                return 204, ""
            return 200, json.dumps(initial)

        env = {"KC_BASE": "http://keycloak", "REALM": "beluga", "client_map": {"trino": "trino-id"},
               "get_admin_token": lambda: "synthetic", "make_req": request, "json": json, "sys": sys}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(block, env)
        writes = [c for c in calls if c[0] in ("POST", "PUT")]
        if expected is None:
            assert writes == [], writes
            continue
        assert [w[0] for w in writes] == [expected], writes
        assert "/clients/trino-id/protocol-mappers/models" in writes[0][1]
        body = writes[0][2]
        assert body["protocolMapper"] == "oidc-audience-mapper"
        for key, value in TARGET.items():
            assert body["config"][key] == value, key
        if expected == "PUT":
            assert body["config"]["extra"] == "kept"  # only target keys are corrected


def main():
    profiles = {"default": [], "full": ["-f", str(ROOT / "gitops/values/sso.yaml"), "-f", str(ROOT / "gitops/values/profile-full.yaml")]}
    profiles["kakao"] = profiles["full"] + ["-f", str(ROOT / "gitops/values/domain-kakao.yaml")]
    for name, extra in profiles.items():
        data = render("beluga-data", *extra)
        config = document(data, "Secret", "trino-coordinator-config")["stringData"]["config.properties"]
        lines = [line.strip() for line in config.splitlines()]
        assert SETTING in lines, name
        assert "http-server.authentication.oauth2.client-id=trino" in lines, name
        assert not any(line.startswith("http-server.authentication.oauth2.additional-audiences") for line in lines), name
        platform_extra = extra + (["-f", str(ROOT / "gitops/charts/beluga-platform/values-kakao.yaml")] if name == "kakao" else [])
        platform = render("beluga-platform", *platform_extra)
        realm = json.loads(document(platform, "ConfigMap", "keycloak-realm")["data"]["beluga-realm.json"])
        trino = next(c for c in realm["clients"] if c["clientId"] == "trino")
        mappers = [m for m in trino.get("protocolMappers", []) if m["name"] == "trino audience"]
        assert len(mappers) == 1 and mappers[0]["protocolMapper"] == "oidc-audience-mapper", name
        assert mappers[0]["config"] == TARGET, name
        replay(container(platform, "keycloak-clients")["command"][-1])
        print(f"PASS: {name}: Trino validates JWT audience; trino client emits aud=trino (import + reconcile replay)")


if __name__ == "__main__":
    main()
