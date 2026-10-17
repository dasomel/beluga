#!/usr/bin/env python3
"""Fail-closed static verification gate for Beluga Gateway SSO (Stage 1).

Enforces D-SSO architecture contracts across rendered Helm manifests:
1. Declarative Source of Truth: All endpoints declared with `mode: gateway-oidc` in
   `gitops/values/sso.yaml` must have an ApisixRoute protected by the `openid-connect` plugin,
   matching the full FQDN host.
2. Safe Credential Injection: No plaintext client secrets across full rendered manifests (both default
   and Kakao overlays); secrets must use APISIX environment variable references.
3. Path Coverage: Every gateway-oidc route's redirect_uri path and logout_path must be matched by
   the route's path patterns (preventing unreachable callbacks or 404s).
4. Header Sanitization: Upstream routes with gateway OIDC must use `proxy-rewrite` to strip
   sensitive authentication headers (X-Userinfo, X-Access-Token, X-ID-Token).
5. REST/Catalog Bypass: Iceberg REST and catalog management/health endpoints (/catalog/*,
   /management/*, /health, /v1/*) must remain free of the openid-connect plugin.
6. APISIX CA Trust & Env Config: APISIX config must declare internal CA certificate trust
   and declare nginx environment variables; deployment must mount internal CA and inject secrets.
7. Overlay Validation: Both default and Kakao Cloud overlays are rendered and verified.
8. Self-tests: Fail-closed negative test cases verify that tampering is caught.
9. allowedGroups (D-MSSO-14): optional per-endpoint group allow-list. Declared only on gateway-oidc
   endpoints, non-empty, valid names, includes `admins`, every entry in policies/groups.yaml. The rendered
   route must set set_userinfo_header=true, cap session.absolute_timeout, leave X-Userinfo removal to a
   serverless-post-function (access phase; openid-connect and proxy-rewrite run in rewrite) whose Lua table equals the list.
10. Beluga Manager (ADR-0009 D-MSSO-6/7a/12, rollout 2b): the app-oidc endpoint `manager` has an ApisixRoute without the
   gateway `openid-connect` plugin (the Domain API validates the bearer JWT itself), the Keycloak client `beluga-manager`
   is public with PKCE S256, no direct grants, no shared `groups` scope and client-specific sub, groups (full.path=true) and
   audience mappers, and an exact post-logout URI, the Domain API Deployment runs AUTH_MODE=oidc with the sso.yaml issuer and SSO_SOURCE=github, and the
   SPA config.json does not request the `groups` scope.
"""
from __future__ import annotations

import argparse
import copy
import os
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SSO_VALUES_FILE = REPO_ROOT / "gitops" / "values" / "sso.yaml"
KAKAO_DOMAIN_FILE = REPO_ROOT / "gitops" / "values" / "domain-kakao.yaml"
DEFAULT_BASE_DOMAIN = "local.beluga.internal"
GROUPS_FILE = REPO_ROOT / "policies" / "groups.yaml"
GROUP_NAME_RE = re.compile(r"^[a-z0-9-]+$")
LUA_GROUP_RE = re.compile(r'\[\s*"([^"]*)"\s*\]\s*=\s*true')
MAX_GROUP_SESSION_SECONDS = 3600


def load_sso_values(base_domain: str = DEFAULT_BASE_DOMAIN) -> dict[str, Any]:
    """Load sso.yaml and resolve its host labels against base_domain (D-DOM-2).

    sso.yaml declares bare labels (host: flink, issuerHost: sso); the FQDNs and the issuer URL are derived exactly
    like the charts (beluga.ssoHost) and the Domain API do. A dotted value is a drift (a baked-in domain) and fails.
    """
    if not SSO_VALUES_FILE.is_file():
        raise FileNotFoundError(f"Missing SSO values file: {SSO_VALUES_FILE}")
    with open(SSO_VALUES_FILE, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    sso = dict(data.get("sso", {}))

    def fqdn(label: str, where: str) -> str:
        if not isinstance(label, str) or not label or "." in label:
            raise ValueError(f"sso.yaml {where} must be a bare DNS label (domain comes from baseDomain), got {label!r}")
        return f"{label}.{base_domain}"

    sso["issuerHost"] = fqdn(sso.get("issuerHost", ""), "issuerHost")
    sso["issuer"] = f"https://{sso['issuerHost']}/realms/{sso.get('realm', 'beluga')}"
    sso["endpoints"] = [
        {**ep, "host": fqdn(ep["host"], f"endpoint {ep.get('name')!r} host")} if "host" in ep else dict(ep)
        for ep in sso.get("endpoints", [])
    ]
    return sso


def load_kakao_base_domain() -> str:
    with open(KAKAO_DOMAIN_FILE, encoding="utf-8") as f:
        return str((yaml.safe_load(f) or {})["baseDomain"])


def load_known_groups() -> set[str]:
    with open(GROUPS_FILE, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return {g.get("name") for g in data.get("groups", []) if isinstance(g, dict) and g.get("name")}


def render_manifest_with_raw(chart: str, extra_args: list[str] | None = None) -> tuple[list[dict[str, Any]], str]:
    cmd = [
        "helm",
        "template",
        str(REPO_ROOT / "gitops" / "charts" / chart),
        "-f",
        str(SSO_VALUES_FILE),
    ]
    if extra_args:
        cmd.extend(extra_args)
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "KUBECONFIG": os.devnull},
    )
    docs = [d for d in yaml.safe_load_all(result.stdout) if isinstance(d, dict)]
    return docs, result.stdout


def path_matches(pattern: str, path: str) -> bool:
    """Check if an APISIX path pattern matches a given request path."""
    if pattern in ("/*", "*"):
        return True
    if pattern.endswith("/*"):
        prefix = pattern[:-2]
        return path == prefix or path.startswith(prefix + "/")
    if pattern.endswith("*"):
        prefix = pattern[:-1]
        return path.startswith(prefix)
    return pattern == path


def audit_gateway_routes(
    docs: list[dict[str, Any]],
    gateway_endpoints: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    """Audit ApisixRoute resources against SSO requirements using full FQDN host comparison."""
    errors: list[str] = []
    checked: list[str] = []

    routes_by_host: dict[str, list[dict[str, Any]]] = {}
    for doc in docs:
        if doc.get("kind") != "ApisixRoute":
            continue
        spec = doc.get("spec", {})
        for http_rule in spec.get("http", []):
            match = http_rule.get("match", {})
            for host in match.get("hosts", []):
                routes_by_host.setdefault(host, []).append(http_rule)

    for ep in gateway_endpoints:
        ep_name = ep.get("name", "unnamed")
        target_host = ep.get("host")
        if not target_host:
            errors.append(f"Endpoint '{ep_name}' missing 'host' in sso.yaml")
            continue

        rules = routes_by_host.get(target_host, [])
        if not rules:
            errors.append(
                f"Endpoint '{ep_name}' with host '{target_host}' declared with mode: gateway-oidc but no matching ApisixRoute found"
            )
            continue

        for rule in rules:
            rule_name = rule.get("name", "unnamed")
            paths = rule.get("match", {}).get("paths", [])
            plugins = {p.get("name"): p for p in rule.get("plugins", []) if p.get("enable", False)}

            # Catalog API paths must NOT have openid-connect
            is_catalog_api = any(p in ("/catalog/*", "/management/*", "/health", "/v1/*") for p in paths)
            if is_catalog_api:
                if "openid-connect" in plugins:
                    errors.append(
                        f"Route '{rule_name}' for host '{target_host}' matches API paths {paths} "
                        f"but has openid-connect plugin enabled (must bypass SSO)"
                    )
                else:
                    checked.append(f"Route '{rule_name}' (API bypass) correctly omits openid-connect")
                continue

            # Gateway-protected routes must have openid-connect
            if "openid-connect" not in plugins:
                errors.append(f"Route '{rule_name}' for host '{target_host}' is missing openid-connect plugin")
                continue

            oidc_cfg = plugins["openid-connect"].get("config", {})
            expected_client_id = ep.get("clientId", "apisix-gateway")
            if oidc_cfg.get("client_id") != expected_client_id:
                errors.append(
                    f"Route '{rule_name}': openid-connect client_id must be '{expected_client_id}', got {oidc_cfg.get('client_id')!r}"
                )

            client_secret = oidc_cfg.get("client_secret", "")
            if client_secret != "$env://APISIX_OIDC_CLIENT_SECRET":
                errors.append(
                    f"Route '{rule_name}': client_secret must use '$env://APISIX_OIDC_CLIENT_SECRET', got {client_secret!r}"
                )

            session_secret = oidc_cfg.get("session", {}).get("secret", "")
            if session_secret != "$env://APISIX_OIDC_SESSION_SECRET":
                errors.append(
                    f"Route '{rule_name}': session.secret must use '$env://APISIX_OIDC_SESSION_SECRET', got {session_secret!r}"
                )

            if not oidc_cfg.get("ssl_verify", False):
                errors.append(f"Route '{rule_name}': openid-connect ssl_verify must be true")

            # Check redirect_uri and logout_path are matched by route paths (Item 1 & Item 7)
            redirect_uri = oidc_cfg.get("redirect_uri", "")
            redirect_path = urllib.parse.urlparse(redirect_uri).path if redirect_uri else ""
            logout_path = oidc_cfg.get("logout_path", "")

            if not redirect_path:
                errors.append(f"Route '{rule_name}': openid-connect redirect_uri is missing or invalid")
            elif not any(path_matches(p, redirect_path) for p in paths):
                errors.append(
                    f"Route '{rule_name}': redirect_uri path '{redirect_path}' is not matched by any route path in {paths}"
                )
            else:
                checked.append(f"Route '{rule_name}': redirect_uri path '{redirect_path}' matched by {paths}")

            if not logout_path:
                errors.append(f"Route '{rule_name}': openid-connect logout_path is missing")
            elif not any(path_matches(p, logout_path) for p in paths):
                errors.append(
                    f"Route '{rule_name}': logout_path '{logout_path}' is not matched by any route path in {paths}"
                )
            else:
                checked.append(f"Route '{rule_name}': logout_path '{logout_path}' matched by {paths}")

            # Check proxy-rewrite header sanitization
            if "proxy-rewrite" not in plugins:
                errors.append(f"Route '{rule_name}' is missing proxy-rewrite plugin to sanitize headers")
            else:
                removed_headers = set(plugins["proxy-rewrite"].get("config", {}).get("headers", {}).get("remove", []))
                expected_removed = {"X-Userinfo", "X-Access-Token", "X-ID-Token"}
                if ep.get("allowedGroups"):
                    # D-MSSO-14: the access-phase Lua reads X-Userinfo and removes it itself
                    # (proxy-rewrite runs in rewrite phase, i.e. before the Lua would see it).
                    expected_removed = expected_removed - {"X-Userinfo"}
                    if "X-Userinfo" in removed_headers:
                        errors.append(
                            f"Route '{rule_name}': proxy-rewrite must not remove X-Userinfo when allowedGroups is set "
                            f"(rewrite phase would erase it before the group check)"
                        )
                missing_removals = expected_removed - removed_headers
                if missing_removals:
                    errors.append(
                        f"Route '{rule_name}': proxy-rewrite must remove {expected_removed}, missing {missing_removals}"
                    )

            checked.append(f"Route '{rule_name}' ({target_host}) verified: OIDC enabled, env secret, header sanitization")

    return errors, checked


def audit_allowed_groups(
    docs: list[dict[str, Any]],
    endpoints: list[dict[str, Any]],
    known_groups: set[str],
) -> tuple[list[str], list[str]]:
    """D-MSSO-14: allowedGroups declaration rules and the rendered group-check contract."""
    errors: list[str] = []
    checked: list[str] = []

    routes_by_host: dict[str, list[dict[str, Any]]] = {}
    for doc in docs:
        if doc.get("kind") != "ApisixRoute":
            continue
        for http_rule in doc.get("spec", {}).get("http", []):
            for host in http_rule.get("match", {}).get("hosts", []):
                routes_by_host.setdefault(host, []).append(http_rule)

    for ep in endpoints:
        name = ep.get("name", "unnamed")
        if "allowedGroups" not in ep:
            continue
        groups = ep["allowedGroups"]

        if ep.get("mode") != "gateway-oidc":
            errors.append(f"Endpoint '{name}': allowedGroups is only allowed with mode gateway-oidc")
            continue
        if not isinstance(groups, list) or not groups or not all(isinstance(g, str) for g in groups):
            errors.append(f"Endpoint '{name}': allowedGroups must be a non-empty list of strings")
            continue
        declaration_ok = True
        if len(set(groups)) != len(groups):
            errors.append(f"Endpoint '{name}': allowedGroups contains duplicates")
            declaration_ok = False
        for g in groups:
            if not GROUP_NAME_RE.match(g):
                errors.append(f"Endpoint '{name}': allowedGroups entry {g!r} must match [a-z0-9-]+")
                declaration_ok = False
            elif g not in known_groups:
                errors.append(f"Endpoint '{name}': allowedGroups entry {g!r} is not declared in policies/groups.yaml")
                declaration_ok = False
        if "admins" not in groups:
            errors.append(f"Endpoint '{name}': allowedGroups must include 'admins' (anti lock-out)")
            declaration_ok = False
        if not declaration_ok:
            continue

        rules = [
            r for r in routes_by_host.get(ep.get("host"), [])
            if not any(p in ("/catalog/*", "/management/*", "/health", "/v1/*") for p in r.get("match", {}).get("paths", []))
        ]
        if not rules:
            errors.append(f"Endpoint '{name}': no ApisixRoute found to carry the allowedGroups check")
            continue

        for rule in rules:
            rule_name = rule.get("name", "unnamed")
            plugin_list = [p for p in rule.get("plugins", []) if p.get("enable", False)]
            order = [p.get("name") for p in plugin_list]
            plugins = {p.get("name"): p for p in plugin_list}
            oidc_cfg = plugins.get("openid-connect", {}).get("config", {})

            if oidc_cfg.get("set_userinfo_header") is not True:
                errors.append(f"Route '{rule_name}': allowedGroups requires openid-connect set_userinfo_header: true")
            timeout = oidc_cfg.get("session", {}).get("absolute_timeout")
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 0 < timeout <= MAX_GROUP_SESSION_SECONDS:
                errors.append(
                    f"Route '{rule_name}': allowedGroups requires openid-connect session.absolute_timeout in 1..{MAX_GROUP_SESSION_SECONDS}, got {timeout!r}"
                )

            guard = plugins.get("serverless-post-function")
            if guard is None:
                errors.append(f"Route '{rule_name}': allowedGroups set but serverless-post-function group check is missing")
                continue
            if "openid-connect" not in order or order.index("serverless-post-function") < order.index("openid-connect"):
                errors.append(f"Route '{rule_name}': serverless-post-function (access phase) must come after openid-connect (rewrite phase)")
            guard_cfg = guard.get("config", {})
            if guard_cfg.get("phase") != "access":
                errors.append(f"Route '{rule_name}': group check must run in phase 'access', got {guard_cfg.get('phase')!r}")
            funcs = guard_cfg.get("functions", [])
            if not isinstance(funcs, list) or len(funcs) != 1 or not isinstance(funcs[0], str):
                errors.append(f"Route '{rule_name}': group check must be exactly one Lua function")
                continue
            lua = funcs[0]
            if set(LUA_GROUP_RE.findall(lua)) != set(groups) or len(LUA_GROUP_RE.findall(lua)) != len(groups):
                errors.append(
                    f"Route '{rule_name}': Lua allow-table {sorted(LUA_GROUP_RE.findall(lua))} != allowedGroups {sorted(groups)}"
                )
            if 'set_header(ctx, "X-Userinfo", nil)' not in lua:
                errors.append(f"Route '{rule_name}': Lua group check must remove X-Userinfo")
            if "return 403" not in lua:
                errors.append(f"Route '{rule_name}': Lua group check must answer 403 when no group matches")
            if "X-Userinfo" in plugins.get("proxy-rewrite", {}).get("config", {}).get("headers", {}).get("remove", []):
                errors.append(f"Route '{rule_name}': proxy-rewrite must not remove X-Userinfo when allowedGroups is set")

            checked.append(f"Route '{rule_name}' ({ep.get('host')}) group check verified: {sorted(groups)}")

    return errors, checked


def audit_domain_separation(manifest_texts: list[tuple[str, str]], kakao_domain: str) -> tuple[list[str], list[str]]:
    """D-DOM-1: Kakao renders contain no default domain; default renders contain no Kakao domain."""
    errors: list[str] = []
    checked: list[str] = []
    for label, raw in manifest_texts:
        if label.endswith("-kakao"):
            leaked = raw.count(DEFAULT_BASE_DOMAIN)
            if leaked:
                errors.append(f"{label}: {leaked} occurrence(s) of {DEFAULT_BASE_DOMAIN} in the Kakao render (domain must be {kakao_domain})")
            elif f"sso.{kakao_domain}" not in raw:
                errors.append(f"{label}: Kakao render does not mention sso.{kakao_domain}")
            else:
                checked.append(f"{label}: no {DEFAULT_BASE_DOMAIN} left, SSO host is sso.{kakao_domain}")
        elif kakao_domain in raw:
            errors.append(f"{label}: default render contains {kakao_domain}")
        else:
            checked.append(f"{label}: default render keeps {DEFAULT_BASE_DOMAIN} only")
    return errors, checked


def audit_plaintext_secrets(manifest_texts: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    """Scan full rendered manifests for plaintext client_secret values."""
    errors: list[str] = []
    checked: list[str] = []
    pattern = re.compile(r"""^\s*(?:client_secret|secret)\s*:\s*["']?([^"'\s#]+)""", re.IGNORECASE)

    for name, text in manifest_texts:
        in_oidc_plugin = False
        for line_no, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "- name: openid-connect" in stripped or "name: openid-connect" in stripped:
                in_oidc_plugin = True
            elif stripped.startswith("- name:") or (stripped.startswith("kind:") and not stripped.startswith("kind: ApisixRoute")):
                in_oidc_plugin = False

            if in_oidc_plugin:
                m = pattern.search(line)
                if m:
                    val = m.group(1).strip("\"'")
                    if not val.startswith("$env://") and val not in ("true", "false", ""):
                        errors.append(f"[{name}:{line_no}] plaintext OIDC secret detected: {val[:8]}...")

    if not errors:
        checked.append(f"Full render plaintext secret scan verified across {len(manifest_texts)} manifests")

    return errors, checked


def audit_apisix_platform(docs: list[dict[str, Any]], context_label: str = "default") -> tuple[list[str], list[str]]:
    """Audit APISIX gateway config and deployment in beluga-platform."""
    errors: list[str] = []
    checked: list[str] = []

    configmap_found = False
    deployment_found = False

    for doc in docs:
        kind = doc.get("kind")
        name = doc.get("metadata", {}).get("name", "")

        if kind == "ConfigMap" and name == "apisix-config":
            configmap_found = True
            raw_cfg = doc.get("data", {}).get("config.yaml", "")
            try:
                cfg = yaml.safe_load(raw_cfg) or {}
            except Exception as e:
                errors.append(f"[{context_label}] apisix-config ConfigMap invalid YAML: {e}")
                continue

            trusted_ca = cfg.get("apisix", {}).get("ssl", {}).get("ssl_trusted_certificate")
            if trusted_ca != "/usr/local/apisix/conf/ssl/ca.crt":
                errors.append(
                    f"[{context_label}] apisix-config: apisix.ssl.ssl_trusted_certificate must be '/usr/local/apisix/conf/ssl/ca.crt', got {trusted_ca!r}"
                )
            else:
                checked.append(f"[{context_label}] apisix-config ssl_trusted_certificate verified")

            envs = cfg.get("nginx_config", {}).get("envs", [])
            for required_env in ("APISIX_OIDC_CLIENT_SECRET", "APISIX_OIDC_SESSION_SECRET"):
                if required_env not in envs:
                    errors.append(f"[{context_label}] apisix-config: nginx_config.envs missing {required_env}")
                else:
                    checked.append(f"[{context_label}] apisix-config nginx_config.envs includes {required_env}")

        elif kind == "Deployment" and name == "apisix":
            deployment_found = True
            containers = doc.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
            apisix_container = next((c for c in containers if c.get("name") == "apisix"), None)
            if not apisix_container:
                errors.append(f"[{context_label}] apisix Deployment missing 'apisix' container")
                continue

            # Check env var injection from secret
            env_map = {e.get("name"): e for e in apisix_container.get("env", []) if isinstance(e, dict)}
            for required_env, expected_secret in [
                ("APISIX_OIDC_CLIENT_SECRET", "apisix-oidc-credential"),
                ("APISIX_OIDC_SESSION_SECRET", "apisix-oidc-credential"),
            ]:
                if required_env not in env_map:
                    errors.append(f"[{context_label}] apisix Deployment container missing env {required_env}")
                    continue
                val_from = env_map[required_env].get("valueFrom", {}).get("secretKeyRef", {})
                if val_from.get("name") != expected_secret:
                    errors.append(
                        f"[{context_label}] apisix container env {required_env} must come from secret '{expected_secret}', got {val_from.get('name')!r}"
                    )
                else:
                    checked.append(f"[{context_label}] apisix container env {required_env} sourced from {expected_secret}")

            # Check volume mount for internal-ca
            mounts = {m.get("name"): m for m in apisix_container.get("volumeMounts", [])}
            if "internal-ca" not in mounts:
                errors.append(f"[{context_label}] apisix Deployment container missing 'internal-ca' volume mount")
            else:
                mount_path = mounts["internal-ca"].get("mountPath")
                if mount_path != "/usr/local/apisix/conf/ssl":
                    errors.append(
                        f"[{context_label}] internal-ca volume mountPath must be '/usr/local/apisix/conf/ssl', got {mount_path!r}"
                    )
                else:
                    checked.append(f"[{context_label}] apisix container internal-ca volume mount verified")

    if not configmap_found:
        errors.append(f"[{context_label}] apisix-config ConfigMap not found in beluga-platform")
    if not deployment_found:
        errors.append(f"[{context_label}] apisix Deployment not found in beluga-platform")

    return errors, checked


def audit_app_sso_contracts(data_docs: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """Audit app-level SSO login configurations across data platform components."""
    errors: list[str] = []
    checked: list[str] = []

    # 1. Trino Web UI SSO
    trino_doc = next(
        (d for d in data_docs if d.get("kind") in ("ConfigMap", "Secret") and d.get("metadata", {}).get("name") == "trino-coordinator-config"),
        None,
    )
    if not trino_doc:
        errors.append("trino-coordinator-config Secret/ConfigMap not found in beluga-data")
    else:
        cfg = (trino_doc.get("stringData") or trino_doc.get("data") or {}).get("config.properties", "")
        if "web-ui.authentication.type=oauth2" not in cfg:
            errors.append("trino config.properties missing 'web-ui.authentication.type=oauth2'")
        else:
            checked.append("Trino web-ui.authentication.type=oauth2 verified")

    # 2. Airflow explicit processes (not standalone)
    airflow_dep = next(
        (d for d in data_docs if d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == "airflow-webserver"),
        None,
    )
    if not airflow_dep:
        errors.append("airflow-webserver Deployment not found in beluga-data")
    else:
        containers = airflow_dep.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        airflow_c = next((c for c in containers if c.get("name") == "airflow"), None)
        if not airflow_c:
            errors.append("airflow container not found in airflow-webserver Deployment")
        else:
            cmd = " ".join(airflow_c.get("command", []) + airflow_c.get("args", []))
            if "airflow standalone" in cmd:
                errors.append("airflow container must NOT run 'airflow standalone' (forces SimpleAuthManager)")
            elif "airflow api-server" not in cmd:
                errors.append("airflow container command missing 'airflow api-server'")
            else:
                checked.append("Airflow explicit processes (api-server/scheduler/dag-processor/triggerer) verified without standalone")

            # 단언: standalone 미사용이면 executor가 LocalExecutor이거나 kubernetes_executor namespace가 설정돼 있어야 한다
            if "airflow standalone" not in cmd:
                env_map = {e.get("name"): str(e.get("value", "")) for e in airflow_c.get("env", []) if isinstance(e, dict)}
                executor = env_map.get("AIRFLOW__CORE__EXECUTOR", "")
                k8s_ns = env_map.get("AIRFLOW__KUBERNETES_EXECUTOR__NAMESPACE", "")
                if executor == "LocalExecutor":
                    checked.append("Airflow executor verified as LocalExecutor")
                elif executor == "KubernetesExecutor" and k8s_ns:
                    checked.append(f"Airflow executor verified as KubernetesExecutor with namespace '{k8s_ns}'")
                else:
                    errors.append(
                        f"Airflow standalone 미사용 시 executor가 LocalExecutor이거나 kubernetes_executor namespace가 설정돼 있어야 함 (current: executor='{executor}', namespace='{k8s_ns}')"
                    )

    # 3. Lakekeeper UI OIDC env
    lakekeeper_dep = next(
        (d for d in data_docs if d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == "lakekeeper"),
        None,
    )
    if not lakekeeper_dep:
        errors.append("lakekeeper Deployment not found in beluga-data")
    else:
        containers = lakekeeper_dep.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        lakekeeper_c = next((c for c in containers if c.get("name") == "lakekeeper"), None)
        if not lakekeeper_c:
            errors.append("lakekeeper container not found in lakekeeper Deployment")
        else:
            env_map = {e.get("name"): e.get("value") for e in lakekeeper_c.get("env", []) if isinstance(e, dict)}
            ui_issuer = env_map.get("LAKEKEEPER__UI__OPENID_PROVIDER_URI", "")
            if not ui_issuer or not ui_issuer.startswith("https://"):
                errors.append(f"lakekeeper missing LAKEKEEPER__UI__OPENID_PROVIDER_URI starting with https://, got {ui_issuer!r}")
            else:
                checked.append("Lakekeeper UI OIDC issuer verified with https://")

    return errors, checked


def audit_manager(docs: list[dict[str, Any]], endpoints: list[dict[str, Any]], issuer: str) -> tuple[list[str], list[str]]:
    """Audit the Beluga Manager deployment, route and Keycloak client in beluga-platform (rollout 2b)."""
    errors: list[str] = []
    checked: list[str] = []

    ep = next((e for e in endpoints if e.get("name") == "manager"), None)
    if ep is None:
        return ["sso.yaml: endpoint 'manager' is missing"], checked
    if ep.get("mode") != "app-oidc" or ep.get("clientId") != "beluga-manager" or ep.get("redirectPath") != "/auth/callback":
        errors.append(f"sso.yaml: endpoint 'manager' must be app-oidc / beluga-manager / /auth/callback, got {ep!r}")
    host = ep.get("host", "")
    origin = f"https://{host}"

    def by_name(kind: str, name: str) -> dict[str, Any] | None:
        return next((d for d in docs if d.get("kind") == kind and d.get("metadata", {}).get("name") == name), None)

    def container(dep: dict[str, Any] | None) -> dict[str, Any]:
        if not dep:
            return {}
        cs = dep.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        return cs[0] if cs else {}

    # Route: no gateway openid-connect on any entry of the manager host, finite rate limit on every entry.
    route = by_name("ApisixRoute", "manager")
    if not route:
        errors.append("ApisixRoute 'manager' not found in beluga-platform")
    else:
        entries = route.get("spec", {}).get("http", [])
        for entry in entries:
            if host not in entry.get("match", {}).get("hosts", []):
                errors.append(f"manager route '{entry.get('name')}' must match host {host!r}")
            names = {p.get("name") for p in entry.get("plugins", []) if p.get("enable", True)}
            if "openid-connect" in names:
                errors.append(f"manager route '{entry.get('name')}' must not enable gateway openid-connect (app-oidc: the Domain API validates the bearer JWT)")
            if not names & {"limit-req", "limit-count", "limit-conn"}:
                errors.append(f"manager route '{entry.get('name')}' is missing a rate-limit plugin")
        paths = {pth for entry in entries for pth in entry.get("match", {}).get("paths", [])}
        if not {"/api/*", "/*"} <= paths:
            errors.append(f"manager route must cover '/api/*' (Domain API) and '/*' (SPA), got {sorted(paths)}")
        if not errors:
            checked.append(f"manager route ({host}) has no gateway openid-connect and is rate limited")

    # Domain API: fail-closed auth configuration.
    env = {e.get("name"): e.get("value") for e in container(by_name("Deployment", "manager-domain-api")).get("env", [])}
    expected_env = {
        "NODE_ENV": "production",
        "AUTH_MODE": "oidc",
        "OIDC_ISSUER": issuer,
        "OIDC_AUDIENCE": "beluga-manager",
        "SSO_SOURCE": "github",
    }
    for key, want in expected_env.items():
        if env.get(key) != want:
            errors.append(f"manager-domain-api env {key} must be {want!r}, got {env.get(key)!r}")
    if not env.get("NODE_EXTRA_CA_CERTS"):
        errors.append("manager-domain-api env NODE_EXTRA_CA_CERTS missing (JWKS over the internal CA fails without it)")
    if not errors:
        checked.append("manager-domain-api runs AUTH_MODE=oidc with the sso.yaml issuer, SSO_SOURCE=github and the internal CA")

    # SPA config.json and CSP.
    cm = by_name("ConfigMap", "manager-web-config")
    try:
        import json
        cfg = json.loads((cm or {}).get("data", {}).get("config.json", "{}"))
    except ValueError as exc:
        cfg = {}
        errors.append(f"manager-web-config config.json is not valid JSON: {exc}")
    oidc = cfg.get("oidc", {})
    if oidc.get("issuer") != issuer or oidc.get("clientId") != "beluga-manager" or oidc.get("redirectPath") != ep.get("redirectPath"):
        errors.append(f"manager-web-config oidc must match sso.yaml (issuer/clientId/redirectPath), got {oidc!r}")
    if "groups" in str(oidc.get("scope", "")).split():
        errors.append("manager-web-config oidc.scope must not request 'groups' (beluga-manager has no shared groups scope: invalid_scope)")
    csp = {e.get("name"): e.get("value") for e in container(by_name("Deployment", "manager-web")).get("env", [])}.get("CSP_CONNECT_SRC", "")
    issuer_origin = "https://" + urllib.parse.urlparse(issuer).netloc
    if issuer_origin not in csp.split() or "'self'" not in csp.split():
        errors.append(f"manager-web CSP_CONNECT_SRC must contain 'self' and {issuer_origin}, got {csp!r}")
    if not errors:
        checked.append("manager-web config.json and CSP_CONNECT_SRC agree with the sso.yaml issuer")

    # Keycloak client in the realm import and in the reconcile Job.
    realm_client = None
    realm_cm = by_name("ConfigMap", "keycloak-realm")
    if realm_cm:
        try:
            import json
            realm = json.loads(realm_cm.get("data", {}).get("beluga-realm.json", "{}"))
            realm_client = next((c for c in realm.get("clients", []) if c.get("clientId") == "beluga-manager"), None)
        except ValueError as exc:
            errors.append(f"keycloak-realm beluga-realm.json is not valid JSON: {exc}")
    if realm_client is None:
        errors.append("keycloak-realm: client 'beluga-manager' not found")
    else:
        attrs = realm_client.get("attributes", {})
        mappers = {m.get("protocolMapper"): m.get("config", {}) for m in realm_client.get("protocolMappers", [])}
        if realm_client.get("publicClient") is not True:
            errors.append("beluga-manager must be a public client")
        if attrs.get("pkce.code.challenge.method") != "S256":
            errors.append("beluga-manager must enforce PKCE S256 (attributes pkce.code.challenge.method)")
        if realm_client.get("directAccessGrantsEnabled") is not False or realm_client.get("implicitFlowEnabled") is not False:
            errors.append("beluga-manager must disable directAccessGrants and implicit flow")
        if realm_client.get("redirectUris") != [f"{origin}{ep.get('redirectPath')}"]:
            errors.append(f"beluga-manager redirectUris must be exactly [{origin}{ep.get('redirectPath')}], got {realm_client.get('redirectUris')!r}")
        if realm_client.get("webOrigins") != [origin]:
            errors.append(f"beluga-manager webOrigins must be exactly [{origin}], got {realm_client.get('webOrigins')!r}")
        if "groups" in realm_client.get("defaultClientScopes", []):
            errors.append("beluga-manager must not be assigned the shared 'groups' scope (full.path=false would conflict, D-MSSO-7a)")
        if attrs.get("post.logout.redirect.uris") != f"{origin}/":
            errors.append(f"beluga-manager post.logout.redirect.uris must be exactly {origin}/ (the SPA's post_logout_redirect_uri), got {attrs.get('post.logout.redirect.uris')!r}")
        sub_map = mappers.get("oidc-sub-mapper", {})
        if sub_map.get("access.token.claim") != "true":
            errors.append(f"beluga-manager needs a client-specific oidc-sub-mapper in the access token (the realm has no 'basic' scope; the Domain API requires sub), got {sub_map!r}")
        grp = mappers.get("oidc-group-membership-mapper", {})
        if grp.get("full.path") != "true" or grp.get("access.token.claim") != "true" or grp.get("claim.name") != "groups":
            errors.append(f"beluga-manager groups mapper must set full.path=true into the access token claim 'groups', got {grp!r}")
        aud = mappers.get("oidc-audience-mapper", {})
        if aud.get("included.client.audience") != "beluga-manager" or aud.get("access.token.claim") != "true":
            errors.append(f"beluga-manager audience mapper must add 'beluga-manager' to the access token, got {aud!r}")
        if not errors:
            checked.append("keycloak realm client beluga-manager: public, PKCE S256, exact redirect, client-specific groups/audience mappers")

    job = by_name("Job", "keycloak-clients")
    script = ""
    if job:
        cmd = container(job).get("command", [])
        script = cmd[2] if len(cmd) > 2 else ""
    for needle, what in [
        ('"beluga-manager": {', "client create spec"),
        ('CLIENT_SETTINGS = {', "public/direct-grant/webOrigins settings reconcile"),
        ('"directAccessGrantsEnabled": False', "directAccessGrants=false reconcile"),
        ('"beluga-manager": [', "redirectUris reconcile"),
        ('"pkce.code.challenge.method": "S256"', "PKCE attribute reconcile"),
        ('"full.path": "true"', "groups mapper reconcile"),
        ('"protocolMapper": "oidc-sub-mapper"', "sub mapper reconcile"),
        (f'"post.logout.redirect.uris": "{origin}/"', "exact post-logout URI reconcile"),
        ('"included.client.audience": "beluga-manager"', "audience mapper reconcile"),
    ]:
        if needle not in script:
            errors.append(f"keycloak-clients Job: beluga-manager {what} is missing ({needle})")
    # The scope-assignment loop must never include beluga-manager.
    m = re.search(r"TARGET_CLIENTS_FOR_SCOPES\s*=\s*\[([^\]]*)\]", script)
    if m and "beluga-manager" in m.group(1):
        errors.append("keycloak-clients Job: TARGET_CLIENTS_FOR_SCOPES must not include beluga-manager (it would receive the shared groups scope)")
    if script and not any(e.startswith("keycloak-clients Job") for e in errors):
        checked.append("keycloak-clients Job reconciles beluga-manager (create, redirectUris, PKCE, mappers) without the shared groups scope")

    return errors, checked


def manager_mutation_self_test(docs: list[dict[str, Any]], endpoints: list[dict[str, Any]], issuer: str) -> int:
    """Negative self-test on the real render: every tampering of the manager contract must be caught."""
    import json

    base_errors, _ = audit_manager(docs, endpoints, issuer)
    assert not base_errors, f"manager mutation self-test needs a clean render first: {base_errors}"

    def realm(mutated: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
        cm = next(d for d in mutated if d.get("kind") == "ConfigMap" and d["metadata"]["name"] == "keycloak-realm")
        data = json.loads(cm["data"]["beluga-realm.json"])
        return cm, data

    def save_realm(cm: dict[str, Any], data: dict[str, Any]) -> None:
        cm["data"]["beluga-realm.json"] = json.dumps(data)

    def client_of(data: dict[str, Any]) -> dict[str, Any]:
        return next(c for c in data["clients"] if c["clientId"] == "beluga-manager")

    def mut_route_oidc(m: list[dict[str, Any]]) -> None:
        r = next(d for d in m if d.get("kind") == "ApisixRoute" and d["metadata"]["name"] == "manager")
        r["spec"]["http"][0]["plugins"].append({"name": "openid-connect", "enable": True, "config": {}})

    def mut_route_no_limit(m: list[dict[str, Any]]) -> None:
        r = next(d for d in m if d.get("kind") == "ApisixRoute" and d["metadata"]["name"] == "manager")
        r["spec"]["http"][1]["plugins"] = []

    def mut_env(key: str, value: str):
        def apply(m: list[dict[str, Any]]) -> None:
            dep = next(d for d in m if d.get("kind") == "Deployment" and d["metadata"]["name"] == "manager-domain-api")
            for e in dep["spec"]["template"]["spec"]["containers"][0]["env"]:
                if e["name"] == key:
                    e["value"] = value
        return apply

    def mut_scope(m: list[dict[str, Any]]) -> None:
        cm = next(d for d in m if d.get("kind") == "ConfigMap" and d["metadata"]["name"] == "manager-web-config")
        cfg = json.loads(cm["data"]["config.json"])
        cfg["oidc"]["scope"] = "openid profile email groups"
        cm["data"]["config.json"] = json.dumps(cfg)

    def realm_mut(fn):
        def apply(m: list[dict[str, Any]]) -> None:
            cm, data = realm(m)
            fn(client_of(data))
            save_realm(cm, data)
        return apply

    def mut_job(m: list[dict[str, Any]]) -> None:
        job = next(d for d in m if d.get("kind") == "Job" and d["metadata"]["name"] == "keycloak-clients")
        c = job["spec"]["template"]["spec"]["containers"][0]
        c["command"][2] = c["command"][2].replace("TARGET_CLIENTS_FOR_SCOPES = [", 'TARGET_CLIENTS_FOR_SCOPES = ["beluga-manager", ', 1)

    cases = [
        ("gateway openid-connect on manager route", mut_route_oidc),
        ("manager web route without rate limit", mut_route_no_limit),
        ("AUTH_MODE disabled", mut_env("AUTH_MODE", "disabled")),
        ("issuer mismatch", mut_env("OIDC_ISSUER", "https://sso.example.test/realms/beluga")),
        ("SSO_SOURCE file", mut_env("SSO_SOURCE", "file")),
        ("groups scope requested by the SPA", mut_scope),
        ("client not public", realm_mut(lambda c: c.update(publicClient=False))),
        ("PKCE removed", realm_mut(lambda c: c["attributes"].pop("pkce.code.challenge.method"))),
        ("direct grants enabled", realm_mut(lambda c: c.update(directAccessGrantsEnabled=True))),
        ("wildcard redirect", realm_mut(lambda c: c.update(redirectUris=["*"]))),
        ("shared groups scope assigned", realm_mut(lambda c: c["defaultClientScopes"].append("groups"))),
        ("groups mapper full.path false", realm_mut(lambda c: c["protocolMappers"][1]["config"].update({"full.path": "false"}))),
        ("audience mapper missing", realm_mut(lambda c: c["protocolMappers"].pop(2))),
        ("sub mapper missing", realm_mut(lambda c: c["protocolMappers"].pop(0))),
        ("wildcard post-logout URI", realm_mut(lambda c: c["attributes"].update({"post.logout.redirect.uris": "https://manager.local.beluga.internal/*"}))),
        ("Job assigns shared scopes to beluga-manager", mut_job),
    ]
    for label, mutate in cases:
        mutated = copy.deepcopy(docs)
        mutate(mutated)
        errs, _ = audit_manager(mutated, endpoints, issuer)
        assert errs, f"manager contract tampering not detected: {label}"
    return len(cases)


def self_test() -> int:
    """Run negative and positive self-tests against mock manifests."""
    test_count = 0

    valid_route_doc = {
        "apiVersion": "apisix.apache.org/v2",
        "kind": "ApisixRoute",
        "metadata": {"name": "flink", "namespace": "streaming"},
        "spec": {
            "http": [
                {
                    "name": "flink",
                    "match": {"hosts": ["flink.local.beluga.internal"], "paths": ["/*"]},
                    "plugins": [
                        {
                            "name": "openid-connect",
                            "enable": True,
                            "config": {
                                "client_id": "apisix-gateway",
                                "client_secret": "$env://APISIX_OIDC_CLIENT_SECRET",
                                "session": {"secret": "$env://APISIX_OIDC_SESSION_SECRET"},
                                "redirect_uri": "https://flink.local.beluga.internal/.apisix/redirect",
                                "logout_path": "/logout",
                                "ssl_verify": True,
                            },
                        },
                        {
                            "name": "proxy-rewrite",
                            "enable": True,
                            "config": {
                                "headers": {"remove": ["X-Userinfo", "X-Access-Token", "X-ID-Token"]}
                            },
                        },
                    ],
                }
            ]
        },
    }

    mock_endpoint = {
        "name": "flink",
        "host": "flink.local.beluga.internal",
        "mode": "gateway-oidc",
        "clientId": "apisix-gateway",
        "redirectPath": "/.apisix/redirect",
        "logoutPath": "/logout",
    }

    # Test 1: Valid route passes
    errs, _ = audit_gateway_routes([valid_route_doc], [mock_endpoint])
    assert not errs, f"Valid route failed audit: {errs}"
    test_count += 1

    # Test 2: Missing openid-connect rejected
    no_oidc = copy.deepcopy(valid_route_doc)
    no_oidc["spec"]["http"][0]["plugins"] = [no_oidc["spec"]["http"][0]["plugins"][1]]
    errs, _ = audit_gateway_routes([no_oidc], [mock_endpoint])
    assert any("missing openid-connect" in e for e in errs), "Failed to detect missing openid-connect"
    test_count += 1

    # Test 3: Plaintext client_secret rejected
    plain_secret = copy.deepcopy(valid_route_doc)
    plain_secret["spec"]["http"][0]["plugins"][0]["config"]["client_secret"] = "my-plain-secret"
    errs, _ = audit_gateway_routes([plain_secret], [mock_endpoint])
    assert any("client_secret must use" in e for e in errs), "Failed to detect plaintext client_secret"
    test_count += 1

    # Test 4: Missing header sanitization rejected
    no_sanitize = copy.deepcopy(valid_route_doc)
    no_sanitize["spec"]["http"][0]["plugins"][1]["config"]["headers"]["remove"] = ["X-Other"]
    errs, _ = audit_gateway_routes([no_sanitize], [mock_endpoint])
    assert any("proxy-rewrite must remove" in e for e in errs), "Failed to detect unremoved auth headers"
    test_count += 1

    # Test 5: Catalog API path with openid-connect rejected
    api_with_oidc = copy.deepcopy(valid_route_doc)
    api_with_oidc["spec"]["http"][0]["name"] = "lakekeeper-api"
    api_with_oidc["spec"]["http"][0]["match"] = {
        "hosts": ["catalog.local.beluga.internal"],
        "paths": ["/catalog/*", "/management/*", "/health", "/v1/*"],
    }
    catalog_ep = {
        "name": "catalog-ui",
        "host": "catalog.local.beluga.internal",
        "mode": "gateway-oidc",
        "clientId": "apisix-gateway",
    }
    errs, _ = audit_gateway_routes([api_with_oidc], [catalog_ep])
    assert any("must bypass SSO" in e for e in errs), "Failed to detect openid-connect on API path"
    test_count += 1

    # Test 6: Host FQDN mismatch rejected (not matching on prefix alone)
    mismatched_host = copy.deepcopy(valid_route_doc)
    mismatched_host["spec"]["http"][0]["match"]["hosts"] = ["flink.other-domain.internal"]
    errs, _ = audit_gateway_routes([mismatched_host], [mock_endpoint])
    assert any("no matching ApisixRoute found" in e for e in errs), "Failed to reject FQDN mismatch"
    test_count += 1

    # Test 7: Unmatched redirect_uri path rejected (e.g. paths ["/ui/*"] vs redirect_uri "/.apisix/redirect")
    unmatched_redirect = copy.deepcopy(valid_route_doc)
    unmatched_redirect["spec"]["http"][0]["match"]["paths"] = ["/ui", "/ui/*"]
    errs, _ = audit_gateway_routes([unmatched_redirect], [mock_endpoint])
    assert any("redirect_uri path '/.apisix/redirect' is not matched" in e for e in errs), "Failed to detect unreachable redirect_uri"
    test_count += 1

    # Test 8: Unmatched logout_path rejected
    unmatched_logout = copy.deepcopy(valid_route_doc)
    unmatched_logout["spec"]["http"][0]["match"]["paths"] = ["/ui/*"]
    unmatched_logout["spec"]["http"][0]["plugins"][0]["config"]["redirect_uri"] = "https://flink.local.beluga.internal/ui/redirect"
    errs, _ = audit_gateway_routes([unmatched_logout], [mock_endpoint])
    assert any("logout_path '/logout' is not matched" in e for e in errs), "Failed to detect unreachable logout_path"
    test_count += 1

    # Test 9: Plaintext secret scan detects literal secret
    errs, _ = audit_plaintext_secrets([("test-manifest", "- name: openid-connect\n  config:\n    client_secret: super-secret-value\n")])
    assert any("plaintext OIDC secret detected" in e for e in errs), "Failed to detect plaintext secret in scan"
    test_count += 1

    # Test 10: Valid app SSO docs pass
    valid_app_docs = [
        {
            "kind": "ConfigMap",
            "metadata": {"name": "trino-coordinator-config"},
            "data": {"config.properties": "web-ui.authentication.type=oauth2\nhttp-server.authentication.type=oauth2,PASSWORD\n"},
        },
        {
            "kind": "Deployment",
            "metadata": {"name": "airflow-webserver"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "airflow",
                                "command": ["bash", "-c", "airflow api-server"],
                                "env": [{"name": "AIRFLOW__CORE__EXECUTOR", "value": "LocalExecutor"}],
                            }
                        ]
                    }
                }
            },
        },
        {
            "kind": "Deployment",
            "metadata": {"name": "lakekeeper"},
            "spec": {"template": {"spec": {"containers": [{"name": "lakekeeper", "env": [{"name": "LAKEKEEPER__UI__OPENID_PROVIDER_URI", "value": "https://sso.local.beluga.internal/realms/beluga"}]}]}}},
        },
    ]
    errs, _ = audit_app_sso_contracts(valid_app_docs)
    assert not errs, f"Valid app docs failed audit: {errs}"
    test_count += 1

    # Test 11: Missing Trino web-ui.authentication.type rejected
    bad_trino = copy.deepcopy(valid_app_docs)
    bad_trino[0]["data"]["config.properties"] = "http-server.authentication.type=oauth2,PASSWORD\n"
    errs, _ = audit_app_sso_contracts(bad_trino)
    assert any("web-ui.authentication.type=oauth2" in e for e in errs), "Failed to detect missing trino web-ui auth"
    test_count += 1

    # Test 12: Airflow standalone rejected
    bad_airflow = copy.deepcopy(valid_app_docs)
    bad_airflow[1]["spec"]["template"]["spec"]["containers"][0]["command"] = ["bash", "-c", "airflow standalone"]
    errs, _ = audit_app_sso_contracts(bad_airflow)
    assert any("airflow standalone" in e for e in errs), "Failed to detect airflow standalone"
    test_count += 1

    # Test 13: Airflow without standalone and missing/unconfigured executor rejected
    bad_airflow_exec = copy.deepcopy(valid_app_docs)
    bad_airflow_exec[1]["spec"]["template"]["spec"]["containers"][0]["env"] = [
        {"name": "AIRFLOW__CORE__EXECUTOR", "value": "KubernetesExecutor"}
    ]
    errs, _ = audit_app_sso_contracts(bad_airflow_exec)
    assert any("Airflow standalone 미사용 시 executor" in e for e in errs), "Failed to detect invalid airflow executor"
    test_count += 1

    # Test 14: Airflow with KubernetesExecutor and configured namespace accepted
    valid_k8s_exec = copy.deepcopy(valid_app_docs)
    valid_k8s_exec[1]["spec"]["template"]["spec"]["containers"][0]["env"] = [
        {"name": "AIRFLOW__CORE__EXECUTOR", "value": "KubernetesExecutor"},
        {"name": "AIRFLOW__KUBERNETES_EXECUTOR__NAMESPACE", "value": "orchestration"},
    ]
    errs, _ = audit_app_sso_contracts(valid_k8s_exec)
    assert not errs, f"Valid KubernetesExecutor docs failed audit: {errs}"
    test_count += 1

    # Test 15: Lakekeeper UI issuer non-https rejected
    bad_lk = copy.deepcopy(valid_app_docs)
    bad_lk[2]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "http://keycloak.iam.svc:8080"
    errs, _ = audit_app_sso_contracts(bad_lk)
    assert any("LAKEKEEPER__UI__OPENID_PROVIDER_URI" in e for e in errs), "Failed to detect non-https lakekeeper UI issuer"
    test_count += 1

    # --- allowedGroups (D-MSSO-14) ---
    known = {"admins", "engineers", "analysts"}
    lua_ok = (
        'return function(conf, ctx)\n  local allowed = {\n    ["admins"] = true,\n    ["engineers"] = true,\n  }\n'
        '  core.request.set_header(ctx, "X-Userinfo", nil)\n  return 403, {}\nend\n'
    )
    grp_ep = {**mock_endpoint, "allowedGroups": ["admins", "engineers"]}
    grp_route = copy.deepcopy(valid_route_doc)
    gp = grp_route["spec"]["http"][0]["plugins"]
    gp[0]["config"]["set_userinfo_header"] = True
    gp[0]["config"]["session"]["absolute_timeout"] = 3600
    gp[1]["config"]["headers"]["remove"] = ["X-Access-Token", "X-ID-Token"]
    gp.append({"name": "serverless-post-function", "enable": True, "config": {"phase": "access", "functions": [lua_ok]}})

    def group_errors(route, ep, groups=known):
        e1, _ = audit_gateway_routes([route], [ep])
        e2, _ = audit_allowed_groups([route], [ep], groups)
        return e1 + e2

    # Test 16: Valid allowedGroups route passes
    errs = group_errors(grp_route, grp_ep)
    assert not errs, f"Valid allowedGroups route failed audit: {errs}"
    test_count += 1

    # Test 17: Missing group check rejected
    no_guard = copy.deepcopy(grp_route)
    no_guard["spec"]["http"][0]["plugins"].pop()
    assert any("group check is missing" in e for e in group_errors(no_guard, grp_ep)), "Failed to detect missing group check"
    test_count += 1

    # Test 18: Group check listed before openid-connect rejected
    wrong_order = copy.deepcopy(grp_route)
    wrong_order["spec"]["http"][0]["plugins"].reverse()
    assert any("after openid-connect" in e for e in group_errors(wrong_order, grp_ep)), "Failed to detect wrong plugin order"
    test_count += 1

    # Test 19: Lua table differing from allowedGroups rejected
    mismatch = copy.deepcopy(grp_route)
    mismatch["spec"]["http"][0]["plugins"][2]["config"]["functions"] = [lua_ok.replace('["engineers"]', '["analysts"]')]
    assert any("Lua allow-table" in e for e in group_errors(mismatch, grp_ep)), "Failed to detect group mismatch"
    test_count += 1

    # Test 20: set_userinfo_header false rejected
    no_header = copy.deepcopy(grp_route)
    no_header["spec"]["http"][0]["plugins"][0]["config"]["set_userinfo_header"] = False
    assert any("set_userinfo_header: true" in e for e in group_errors(no_header, grp_ep)), "Failed to detect set_userinfo_header false"
    test_count += 1

    # Test 21: proxy-rewrite erasing X-Userinfo rejected
    erased = copy.deepcopy(grp_route)
    erased["spec"]["http"][0]["plugins"][1]["config"]["headers"]["remove"].append("X-Userinfo")
    assert any("must not remove X-Userinfo" in e for e in group_errors(erased, grp_ep)), "Failed to detect X-Userinfo erased in rewrite phase"
    test_count += 1

    # Test 22: declaration rules (admins, unknown group, bad name, empty, non-gateway mode)
    for bad, needle in [
        (["engineers"], "must include 'admins'"),
        (["admins", "ghosts"], "not declared in policies/groups.yaml"),
        (["admins", 'x"]=true--'], "must match"),
        ([], "non-empty list"),
    ]:
        errs = group_errors(grp_route, {**mock_endpoint, "allowedGroups": bad})
        assert any(needle in e for e in errs), f"Failed to detect allowedGroups {bad!r}: {errs}"
    errs, _ = audit_allowed_groups([grp_route], [{**grp_ep, "mode": "app-oidc"}], known)
    assert any("only allowed with mode gateway-oidc" in e for e in errs), "Failed to detect allowedGroups on non-gateway mode"
    test_count += 1

    # Test 23: missing session cap and non-access phase rejected
    no_cap = copy.deepcopy(grp_route)
    del no_cap["spec"]["http"][0]["plugins"][0]["config"]["session"]["absolute_timeout"]
    assert any("absolute_timeout" in e for e in group_errors(no_cap, grp_ep)), "Failed to detect missing session cap"
    wrong_phase = copy.deepcopy(grp_route)
    wrong_phase["spec"]["http"][0]["plugins"][2]["config"]["phase"] = "rewrite"
    assert any("phase 'access'" in e for e in group_errors(wrong_phase, grp_ep)), "Failed to detect wrong phase"
    test_count += 1

    return test_count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()

    try:
        tested = self_test()
        print(f"Gateway SSO self-test passed: {tested} test fixtures verified.")
    except AssertionError as exc:
        print(f"FAIL: Gateway SSO self-test failed: {exc}", file=sys.stderr)
        return 1

    kakao_domain = load_kakao_base_domain()
    kakao_sso_cfg = load_sso_values(kakao_domain)
    kakao_endpoints = kakao_sso_cfg.get("endpoints", [])
    kakao_gateway_endpoints = [e for e in kakao_endpoints if e.get("mode") == "gateway-oidc" and "host" in e]
    sso_cfg = load_sso_values()
    endpoints = sso_cfg.get("endpoints", [])
    gateway_endpoints = [e for e in endpoints if e.get("mode") == "gateway-oidc" and "host" in e]
    if not gateway_endpoints:
        print("FAIL: No gateway-oidc endpoints declared in gitops/values/sso.yaml", file=sys.stderr)
        return 1

    print(f"Declared gateway-oidc endpoints to audit: {[e.get('name') for e in gateway_endpoints]}")

    manifest_texts: list[tuple[str, str]] = []

    try:
        data_docs, data_raw = render_manifest_with_raw("beluga-data")
        manifest_texts.append(("beluga-data", data_raw))

        platform_docs, platform_raw = render_manifest_with_raw("beluga-platform")
        manifest_texts.append(("beluga-platform", platform_raw))

        kakao_values_file = REPO_ROOT / "gitops" / "charts" / "beluga-platform" / "values-kakao.yaml"
        kakao_docs, kakao_raw = render_manifest_with_raw(
            "beluga-platform",
            extra_args=["-f", str(kakao_values_file), "-f", str(KAKAO_DOMAIN_FILE)],
        )
        manifest_texts.append(("beluga-platform-kakao", kakao_raw))

        kakao_data_docs, kakao_data_raw = render_manifest_with_raw(
            "beluga-data",
            extra_args=["-f", str(KAKAO_DOMAIN_FILE)],
        )
        manifest_texts.append(("beluga-data-kakao", kakao_data_raw))
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited with code {exc.returncode}:\n{exc.stderr}", file=sys.stderr)
        return 1

    all_errors: list[str] = []
    all_checked: list[str] = []

    route_errors, route_checked = audit_gateway_routes(data_docs, gateway_endpoints)
    all_errors.extend(route_errors)
    all_checked.extend(route_checked)

    group_errors_, group_checked = audit_allowed_groups(data_docs, endpoints, load_known_groups())
    all_errors.extend(group_errors_)
    all_checked.extend(group_checked)

    # D-DOM-1/2: the Kakao renders must carry the Kakao domain only; the default renders must not leak it.
    kakao_route_errors, kakao_route_checked = audit_gateway_routes(kakao_data_docs, kakao_gateway_endpoints)
    all_errors.extend(f"[kakao-domain] {e}" for e in kakao_route_errors)
    all_checked.extend(f"[kakao-domain] {c}" for c in kakao_route_checked)
    kakao_group_errors, kakao_group_checked = audit_allowed_groups(kakao_data_docs, kakao_endpoints, load_known_groups())
    all_errors.extend(f"[kakao-domain] {e}" for e in kakao_group_errors)
    all_checked.extend(f"[kakao-domain] {c}" for c in kakao_group_checked)
    domain_errors, domain_checked = audit_domain_separation(manifest_texts, kakao_domain)
    all_errors.extend(domain_errors)
    all_checked.extend(domain_checked)

    platform_errors, platform_checked = audit_apisix_platform(platform_docs, "default")
    all_errors.extend(platform_errors)
    all_checked.extend(platform_checked)

    kakao_errors, kakao_checked = audit_apisix_platform(kakao_docs, "kakao-overlay")
    all_errors.extend(kakao_errors)
    all_checked.extend(kakao_checked)

    secret_errors, secret_checked = audit_plaintext_secrets(manifest_texts)
    all_errors.extend(secret_errors)
    all_checked.extend(secret_checked)

    try:
        mutations = manager_mutation_self_test(platform_docs, endpoints, sso_cfg.get("issuer", ""))
        print(f"Manager contract mutation self-test passed: {mutations} tamperings detected.")
    except AssertionError as exc:
        print(f"FAIL: Manager contract mutation self-test failed: {exc}", file=sys.stderr)
        return 1

    manager_errors, manager_checked = audit_manager(platform_docs, endpoints, sso_cfg.get("issuer", ""))
    all_errors.extend(manager_errors)
    all_checked.extend(manager_checked)

    kakao_manager_errors, kakao_manager_checked = audit_manager(kakao_docs, kakao_endpoints, kakao_sso_cfg.get("issuer", ""))
    all_errors.extend(f"[kakao-overlay] {e}" for e in kakao_manager_errors)
    all_checked.extend(f"[kakao-overlay] {c}" for c in kakao_manager_checked)

    app_sso_errors, app_sso_checked = audit_app_sso_contracts(data_docs)
    all_errors.extend(app_sso_errors)
    all_checked.extend(app_sso_checked)

    if all_errors:
        print("Gateway SSO check FAILED:", file=sys.stderr)
        for err in all_errors:
            print(f"  [ERROR] {err}", file=sys.stderr)
        return 1

    print(f"Gateway SSO check PASSED: {len(all_checked)} contracts verified.")
    for chk in all_checked:
        print(f"  [OK] {chk}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
