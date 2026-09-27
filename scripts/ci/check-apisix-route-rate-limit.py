#!/usr/bin/env python3
"""Ratchet gate for APISIX route rate limiting (Issue #48, Round 2).

Enforces that every externally reachable APISIX route object in rendered Helm manifests
carries an enabled rate limiting plugin (limit-req, limit-count, or limit-conn) with
positive limits. Internal-only/admin routes restricted by an ip-restriction allowlist
(with valid, non-overly-broad CIDRs) are classified separately and exempted from external
rate-limit enforcement.

Existing violations are frozen in a baseline dictionary keyed per http entry:
  namespace/cr-name/http-entry-name
Violating attributes (hosts, paths, plugin set) are frozen in the baseline.
The gate fails closed on:
- Any violation not present in the baseline (new unprotected routes or new http entries)
- Any baseline entry that mutates its attributes without becoming compliant (baseline drift)
- Any baseline entry that no longer violates (ratchet only tightens: stale entry)
- Any baseline entry that no longer exists in rendered manifests (stale entry)
- Zero relevant route objects found in rendered charts (fail closed)
- Unresolvable forms (unknown ApisixPluginConfig, malformed YAML/plugins, invalid rules)
- Helm template execution failure
"""
from __future__ import annotations

import ipaddress
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

# Deployed chart value combinations from scripts/gitops/01-argocd-bootstrap.sh and scripts/common/env.sh:
# 1. beluga-platform (default values)
# 2. beluga-data (default values: 32GB RAM profile)
# 3. beluga-data (48GB+ RAM profile: trino.workerEnabled=true, openmetadata.enabled=true)
DEPLOYED_COMBOS: list[tuple[str, list[str]]] = [
    ("beluga-platform", []),
    ("beluga-data", []),
    ("beluga-data", ["--set", "trino.workerEnabled=true,openmetadata.enabled=true"]),
]

# FROZEN baseline of existing violations before Issue #48 remediation.
# Keyed per http entry: namespace/cr-name/http-entry-name.
# Violating attributes (hosts, paths, plugins) are frozen to reject any modification
# other than becoming compliant.
FROZEN_BASELINE: dict[str, dict[str, Any]] = {
    "analytics/superset/superset": {
        "issue": "#48",
        "reason": "Superset BI dashboard UI and REST API exposed on superset.local.beluga.internal without rate limiting; needs limit-req plugin to protect chart rendering and login routes.",
        "hosts": ["superset.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "analytics/trino/trino": {
        "issue": "#48",
        "reason": "Trino query coordinator UI and REST API exposed on trino.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to guard against query flooding.",
        "hosts": ["trino.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "governance/openmetadata/openmetadata": {
        "issue": "#48",
        "reason": "OpenMetadata governance server UI and API exposed on metadata.local.beluga.internal without rate limiting (profile 48GB+); needs limit-req plugin to guard metadata ingestion.",
        "hosts": ["metadata.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "iam/keycloak/keycloak": {
        "issue": "#48",
        "reason": "Keycloak SSO authentication realm and admin console exposed on sso.local.beluga.internal without rate limiting; needs limit-req plugin to mitigate credential stuffing and auth endpoint abuse.",
        "hosts": ["sso.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "lakehouse/lakekeeper/lakekeeper": {
        "issue": "#48",
        "reason": "Lakekeeper Iceberg REST catalog API exposed on catalog.local.beluga.internal without rate limiting; needs limit-req plugin to protect catalog metadata queries and commit endpoints.",
        "hosts": ["catalog.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "orchestration/airflow/airflow": {
        "issue": "#48",
        "reason": "Airflow webserver UI and API exposed on airflow.local.beluga.internal without rate limiting; needs limit-req plugin to prevent UI session exhaustion and API abuse.",
        "hosts": ["airflow.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "platform-system/argocd/argocd": {
        "issue": "#48",
        "reason": "ArgoCD Web UI/API exposed on argocd.local.beluga.internal without rate limiting; needs limit-req/limit-count plugin to prevent brute-force and DoS on login and API endpoints.",
        "hosts": ["argocd.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "storage/seaweedfs-filer/seaweedfs-filer": {
        "issue": "#48",
        "reason": "SeaweedFS Filer HTTP interface exposed on filer.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to protect file browsing and metadata lookups.",
        "hosts": ["filer.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "storage/seaweedfs-s3/seaweedfs-s3": {
        "issue": "#48",
        "reason": "SeaweedFS S3 object storage API exposed on s3.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to prevent S3 data-plane saturation.",
        "hosts": ["s3.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
    "streaming/flink/flink": {
        "issue": "#48",
        "reason": "Flink JobManager dashboard and REST API exposed on flink.local.beluga.internal without rate limiting; needs limit-req plugin to prevent JobManager API overload.",
        "hosts": ["flink.local.beluga.internal"],
        "paths": ["/*"],
        "plugins": ["response-rewrite"],
    },
}


def is_positive_number(val: Any) -> bool:
    """Return True if val is a positive int or float (excluding bool)."""
    return type(val) in (int, float) and val > 0


def is_non_negative_number(val: Any) -> bool:
    """Return True if val is a non-negative int or float (excluding bool)."""
    return type(val) in (int, float) and val >= 0


def is_plugin_enabled(p: dict[str, Any]) -> bool:
    """Return True if an APISIX plugin object is active/enabled."""
    if p.get("enable", True) is False:
        return False
    if p.get("disable") is True:
        return False
    meta = p.get("_meta")
    if isinstance(meta, dict) and meta.get("disable") is True:
        return False
    return True


def check_ip_restriction(plugins: list[dict[str, Any]]) -> tuple[bool, str]:
    """Check if an enabled ip-restriction plugin restricts route access via allowlist.

    D1: A denylist/blocklist leaves the route open to arbitrary clients on the internet.
    Only an explicit allowlist (allow or whitelist) restricts access to internal-only networks.

    D2: Overly broad CIDRs (0.0.0.0/0, ::/0, or prefix < /8 for IPv4, prefix < /7 for IPv6)
    must NOT count as internal:
    - IPv4 threshold /8: The largest standard private address space allocation defined by
      RFC 1918 is 10.0.0.0/8 (16,777,216 addresses, prefix length 8). Any prefix strictly
      shorter than /8 (/0 through /7) encompasses hundreds of millions of public internet
      addresses up to the full IPv4 space (0.0.0.0/0). Such broad CIDRs cannot represent an
      internal/admin boundary.
    - IPv6 threshold /7: The largest standard local allocation defined by RFC 4193 is Unique
      Local Address (ULA) fc00::/7 (prefix length 7). Any prefix strictly shorter than /7
      (/0 through /6) encompasses global unicast addresses (2000::/3) or the entire IPv6
      space (::/0). Such broad CIDRs cannot represent an internal/admin boundary.

    D3: ip-restriction plugin must be actively enabled (enable != False, not disabled).
    """
    for p in plugins:
        if not isinstance(p, dict):
            continue
        if p.get("name") != "ip-restriction":
            continue
        if not is_plugin_enabled(p):
            continue

        cfg = p.get("config")
        if not isinstance(cfg, dict):
            continue

        allow = cfg.get("allow") or cfg.get("whitelist")
        if not isinstance(allow, list) or len(allow) == 0:
            continue
        if not all(isinstance(x, str) and x.strip() for x in allow):
            continue

        # Validate each CIDR / IP in the allowlist
        broad_reason = None
        for raw_entry in allow:
            entry = raw_entry.strip()
            try:
                net = ipaddress.ip_network(entry, strict=False)
            except ValueError:
                broad_reason = f"invalid IP/CIDR '{entry}'"
                break

            if net.version == 4:
                if net.prefixlen < 8:
                    broad_reason = f"overly broad IPv4 CIDR '{entry}' (prefix /{net.prefixlen} < /8)"
                    break
            elif net.version == 6:
                if net.prefixlen < 7:
                    broad_reason = f"overly broad IPv6 CIDR '{entry}' (prefix /{net.prefixlen} < /7)"
                    break

        if broad_reason:
            return False, f"ip-restriction allowlist rejected: {broad_reason}"

        return True, f"ip-restriction allowlist active ({len(allow)} valid CIDRs/IPs)"

    return False, ""


def check_rate_limiting(plugins: list[dict[str, Any]]) -> tuple[bool, str]:
    """Check if any supported rate limiting plugin is enabled with positive limits."""
    rate_plugins = {"limit-req", "limit-count", "limit-conn"}
    diagnostic_reasons = []

    for p in plugins:
        if not isinstance(p, dict):
            continue
        name = p.get("name")
        if name not in rate_plugins:
            continue
        if not is_plugin_enabled(p):
            diagnostic_reasons.append(f"{name} is disabled (enable=false)")
            continue

        cfg = p.get("config")
        if not isinstance(cfg, dict):
            diagnostic_reasons.append(f"{name} config missing or invalid")
            continue

        if name == "limit-req":
            rate = cfg.get("rate")
            burst = cfg.get("burst", 0)
            if not is_positive_number(rate):
                diagnostic_reasons.append(f"limit-req rate must be positive number (got {rate!r})")
                continue
            if not is_non_negative_number(burst):
                diagnostic_reasons.append(f"limit-req burst must be non-negative number (got {burst!r})")
                continue
            return True, f"limit-req enabled (rate={rate}, burst={burst})"

        elif name == "limit-count":
            count = cfg.get("count")
            time_window = cfg.get("time_window")
            if not is_positive_number(count):
                diagnostic_reasons.append(f"limit-count count must be positive integer (got {count!r})")
                continue
            if not is_positive_number(time_window):
                diagnostic_reasons.append(f"limit-count time_window must be positive number (got {time_window!r})")
                continue
            return True, f"limit-count enabled (count={count}, time_window={time_window})"

        elif name == "limit-conn":
            conn = cfg.get("conn")
            burst = cfg.get("burst", 0)
            if not is_positive_number(conn):
                diagnostic_reasons.append(f"limit-conn conn must be positive integer (got {conn!r})")
                continue
            if not is_non_negative_number(burst):
                diagnostic_reasons.append(f"limit-conn burst must be non-negative number (got {burst!r})")
                continue
            return True, f"limit-conn enabled (conn={conn}, burst={burst})"

    if diagnostic_reasons:
        return False, "; ".join(diagnostic_reasons)
    return False, "missing rate limiting plugin (limit-req, limit-count, limit-conn)"


def merge_plugins(*plugin_sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge plugins from multiple sources (global -> plugin_config -> route).

    Later sources override earlier sources by plugin name.
    """
    merged: dict[str, dict[str, Any]] = {}
    for p_list in plugin_sources:
        for p in p_list:
            if isinstance(p, dict) and "name" in p:
                merged[p["name"]] = p
    return list(merged.values())


def normalize_plugin_list(raw_plugins: Any, context: str) -> list[dict[str, Any]]:
    """Normalize plugins from dict or list format into a list of plugin dicts.

    Fails loudly if raw_plugins is not a valid list or dict.
    """
    if raw_plugins is None:
        return []
    if isinstance(raw_plugins, list):
        for idx, item in enumerate(raw_plugins):
            if not isinstance(item, dict):
                raise ValueError(f"{context}: plugin item #{idx} is not a dict")
            if "name" not in item:
                raise ValueError(f"{context}: plugin item #{idx} missing required 'name' field")
        return raw_plugins
    if isinstance(raw_plugins, dict):
        result: list[dict[str, Any]] = []
        for p_name, p_val in raw_plugins.items():
            if isinstance(p_val, dict):
                cfg = dict(p_val)
                enable = cfg.pop("enable", True)
                result.append({"name": p_name, "enable": enable, "config": cfg})
            elif isinstance(p_val, bool):
                result.append({"name": p_name, "enable": p_val, "config": {}})
            else:
                raise ValueError(
                    f"{context}: plugin '{p_name}' value must be dict or bool (got {type(p_val).__name__})"
                )
        return result
    raise ValueError(f"{context}: plugins must be a list or dict (got {type(raw_plugins).__name__})")


def extract_globals(
    docs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str | tuple[str, str], list[dict[str, Any]]]]:
    """Extract ApisixGlobalRule and ApisixPluginConfig across manifest documents.

    Fails loudly if any global rule or plugin config is malformed.
    """
    global_plugins: list[dict[str, Any]] = []
    plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]] = {}

    for doc in docs:
        if not isinstance(doc, dict):
            continue
        kind = doc.get("kind")
        metadata = doc.get("metadata") or {}
        ns = metadata.get("namespace", "default")
        name = metadata.get("name", "")

        if kind == "ApisixGlobalRule":
            spec = doc.get("spec") or {}
            plugins_raw = spec.get("plugins")
            plugins = normalize_plugin_list(plugins_raw, f"ApisixGlobalRule '{ns}/{name}'")
            global_plugins.extend(plugins)

        elif kind == "ApisixPluginConfig":
            spec = doc.get("spec") or {}
            plugins_raw = spec.get("plugins")
            plugins = normalize_plugin_list(plugins_raw, f"ApisixPluginConfig '{ns}/{name}'")
            plugin_configs[(ns, name)] = plugins
            plugin_configs[name] = plugins

        elif kind == "ConfigMap":
            data = doc.get("data") or {}
            if isinstance(data, dict):
                for filename, raw_content in data.items():
                    if not isinstance(raw_content, str):
                        continue
                    if "global_rules" in raw_content or "plugin_configs" in raw_content:
                        try:
                            content = yaml.safe_load(raw_content)
                        except yaml.YAMLError as exc:
                            raise ValueError(f"ConfigMap '{ns}/{name}' key '{filename}' invalid YAML: {exc}")
                        if isinstance(content, dict):
                            raw_gr = content.get("global_rules")
                            if isinstance(raw_gr, list):
                                for idx, gr in enumerate(raw_gr):
                                    if not isinstance(gr, dict):
                                        raise ValueError(
                                            f"ConfigMap '{ns}/{name}' global_rules[{idx}] is not a dict"
                                        )
                                    gr_plugins = normalize_plugin_list(
                                        gr.get("plugins"), f"ConfigMap '{ns}/{name}' global_rules[{idx}]"
                                    )
                                    global_plugins.extend(gr_plugins)

                            raw_pc = content.get("plugin_configs")
                            if isinstance(raw_pc, list):
                                for idx, pc in enumerate(raw_pc):
                                    if not isinstance(pc, dict):
                                        raise ValueError(
                                            f"ConfigMap '{ns}/{name}' plugin_configs[{idx}] is not a dict"
                                        )
                                    pc_id = str(pc.get("id") or pc.get("name") or "")
                                    if not pc_id:
                                        raise ValueError(
                                            f"ConfigMap '{ns}/{name}' plugin_configs[{idx}] missing id/name"
                                        )
                                    pc_plugins = normalize_plugin_list(
                                        pc.get("plugins"),
                                        f"ConfigMap '{ns}/{name}' plugin_configs '{pc_id}'",
                                    )
                                    plugin_configs[(ns, pc_id)] = pc_plugins
                                    plugin_configs[pc_id] = pc_plugins

    return global_plugins, plugin_configs


def extract_routes_from_apisix_route(
    doc: dict[str, Any],
    global_plugins: list[dict[str, Any]],
    plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Extract individual HTTP entries from an ApisixRoute CR.

    Each http entry in spec.http is keyed independently as:
      namespace/cr-name/http-entry-name
    """
    routes: dict[str, dict[str, Any]] = {}
    metadata = doc.get("metadata") or {}
    ns = metadata.get("namespace", "default")
    cr_name = metadata.get("name", "")
    spec = doc.get("spec") or {}

    http_rules = spec.get("http")
    if not isinstance(http_rules, list) or not http_rules:
        raise ValueError(f"ApisixRoute '{ns}/{cr_name}' spec.http is empty or not a list")

    for idx, rule in enumerate(http_rules):
        if not isinstance(rule, dict):
            raise ValueError(f"ApisixRoute '{ns}/{cr_name}' spec.http[{idx}] is not a dict")

        entry_name = rule.get("name", f"rule-{idx}")
        identity = f"{ns}/{cr_name}/{entry_name}"

        hosts = rule.get("match", {}).get("hosts") or []
        paths = rule.get("match", {}).get("paths") or []
        raw_plugins = rule.get("plugins") or []
        route_plugins = normalize_plugin_list(raw_plugins, f"ApisixRoute '{identity}'")

        # Resolve plugin_config_name if specified
        pc_name = rule.get("plugin_config_name")
        pc_plugins: list[dict[str, Any]] = []
        if pc_name:
            if (ns, pc_name) in plugin_configs:
                pc_plugins = plugin_configs[(ns, pc_name)]
            elif pc_name in plugin_configs:
                pc_plugins = plugin_configs[pc_name]
            else:
                raise ValueError(
                    f"ApisixRoute '{identity}' references unknown ApisixPluginConfig '{pc_name}'"
                )

        effective_plugins = merge_plugins(global_plugins, pc_plugins, route_plugins)
        plugin_names = [p["name"] for p in route_plugins if isinstance(p, dict) and "name" in p]

        is_restricted, ip_msg = check_ip_restriction(effective_plugins)
        if is_restricted:
            routes[identity] = {
                "identity": identity,
                "kind": "ApisixRoute",
                "namespace": ns,
                "cr_name": cr_name,
                "entry_name": entry_name,
                "hosts": hosts,
                "paths": paths,
                "plugins": plugin_names,
                "compliant": True,
                "classification": "ip_restricted",
                "reason": f"{entry_name}: {ip_msg}",
            }
        else:
            has_rl, rl_msg = check_rate_limiting(effective_plugins)
            routes[identity] = {
                "identity": identity,
                "kind": "ApisixRoute",
                "namespace": ns,
                "cr_name": cr_name,
                "entry_name": entry_name,
                "hosts": hosts,
                "paths": paths,
                "plugins": plugin_names,
                "compliant": has_rl,
                "classification": "rate_limited" if has_rl else "unprotected_external",
                "reason": f"{entry_name}: {rl_msg}",
            }

    return routes


def extract_routes_from_ingress(
    doc: dict[str, Any],
    global_plugins: list[dict[str, Any]],
    plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Extract APISIX routes defined via networking.k8s.io Ingress."""
    routes: dict[str, dict[str, Any]] = {}
    metadata = doc.get("metadata") or {}
    ns = metadata.get("namespace", "default")
    name = metadata.get("name", "")
    annotations = metadata.get("annotations") or {}
    spec = doc.get("spec") or {}

    ingress_class = spec.get("ingressClassName") or annotations.get("kubernetes.io/ingress.class")
    if ingress_class != "apisix":
        return routes

    # Ingress-level plugins from annotations
    ingress_plugins: list[dict[str, Any]] = []
    pc_name = annotations.get("k8s.apisix.apache.org/plugin-config-name")
    if pc_name:
        if (ns, pc_name) in plugin_configs:
            ingress_plugins.extend(plugin_configs[(ns, pc_name)])
        elif pc_name in plugin_configs:
            ingress_plugins.extend(plugin_configs[pc_name])
        else:
            raise ValueError(f"Ingress '{ns}/{name}' references unknown ApisixPluginConfig '{pc_name}'")

    raw_plugins = annotations.get("k8s.apisix.apache.org/plugins")
    if raw_plugins:
        try:
            parsed = yaml.safe_load(raw_plugins)
        except yaml.YAMLError as exc:
            raise ValueError(f"Ingress '{ns}/{name}' has invalid plugins annotation: {exc}")
        ingress_plugins.extend(normalize_plugin_list(parsed, f"Ingress '{ns}/{name}'"))

    effective_plugins = merge_plugins(global_plugins, ingress_plugins)
    plugin_names = [p["name"] for p in ingress_plugins if isinstance(p, dict) and "name" in p]

    rules = spec.get("rules") or []
    if not rules:
        identity = f"{ns}/{name}/default"
        is_restricted, ip_msg = check_ip_restriction(effective_plugins)
        if is_restricted:
            routes[identity] = {
                "identity": identity,
                "kind": "Ingress",
                "namespace": ns,
                "name": name,
                "hosts": ["*"],
                "paths": ["/*"],
                "plugins": plugin_names,
                "compliant": True,
                "classification": "ip_restricted",
                "reason": ip_msg,
            }
        else:
            has_rl, rl_msg = check_rate_limiting(effective_plugins)
            routes[identity] = {
                "identity": identity,
                "kind": "Ingress",
                "namespace": ns,
                "name": name,
                "hosts": ["*"],
                "paths": ["/*"],
                "plugins": plugin_names,
                "compliant": has_rl,
                "classification": "rate_limited" if has_rl else "unprotected_external",
                "reason": rl_msg,
            }
        return routes

    for r_idx, rule in enumerate(rules):
        host = rule.get("host") or "*"
        paths = rule.get("http", {}).get("paths") or []
        if not paths:
            identity = f"{ns}/{name}/{host}"
            is_restricted, ip_msg = check_ip_restriction(effective_plugins)
            if is_restricted:
                routes[identity] = {
                    "identity": identity,
                    "kind": "Ingress",
                    "namespace": ns,
                    "name": name,
                    "hosts": [host],
                    "paths": ["/*"],
                    "plugins": plugin_names,
                    "compliant": True,
                    "classification": "ip_restricted",
                    "reason": ip_msg,
                }
            else:
                has_rl, rl_msg = check_rate_limiting(effective_plugins)
                routes[identity] = {
                    "identity": identity,
                    "kind": "Ingress",
                    "namespace": ns,
                    "name": name,
                    "hosts": [host],
                    "paths": ["/*"],
                    "plugins": plugin_names,
                    "compliant": has_rl,
                    "classification": "rate_limited" if has_rl else "unprotected_external",
                    "reason": rl_msg,
                }
            continue

        for p_idx, path_entry in enumerate(paths):
            path_val = path_entry.get("path") or "/*"
            identity = f"{ns}/{name}/{host}:{path_val}"
            is_restricted, ip_msg = check_ip_restriction(effective_plugins)
            if is_restricted:
                routes[identity] = {
                    "identity": identity,
                    "kind": "Ingress",
                    "namespace": ns,
                    "name": name,
                    "hosts": [host],
                    "paths": [path_val],
                    "plugins": plugin_names,
                    "compliant": True,
                    "classification": "ip_restricted",
                    "reason": ip_msg,
                }
            else:
                has_rl, rl_msg = check_rate_limiting(effective_plugins)
                routes[identity] = {
                    "identity": identity,
                    "kind": "Ingress",
                    "namespace": ns,
                    "name": name,
                    "hosts": [host],
                    "paths": [path_val],
                    "plugins": plugin_names,
                    "compliant": has_rl,
                    "classification": "rate_limited" if has_rl else "unprotected_external",
                    "reason": rl_msg,
                }

    return routes


def extract_routes_from_configmap(
    doc: dict[str, Any],
    global_plugins: list[dict[str, Any]],
    plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Extract standalone APISIX routes from ConfigMaps under any route key."""
    routes: dict[str, dict[str, Any]] = {}
    ns = doc.get("metadata", {}).get("namespace", "default")
    name = doc.get("metadata", {}).get("name", "")
    data = doc.get("data", {})
    if not isinstance(data, dict):
        return routes

    for filename, raw_content in data.items():
        if not isinstance(raw_content, str):
            continue

        is_candidate = (
            filename in ("apisix.yaml", "apisix.yml", "routes.yaml", "routes.yml")
            or "routes" in filename.lower()
            or "routes:" in raw_content
        )
        if not is_candidate:
            continue

        try:
            content = yaml.safe_load(raw_content)
        except yaml.YAMLError as exc:
            raise ValueError(f"ConfigMap '{ns}/{name}' key '{filename}' has invalid YAML: {exc}")

        if not isinstance(content, dict):
            continue

        raw_routes = content.get("routes")
        if raw_routes is None:
            continue
        if not isinstance(raw_routes, list):
            raise ValueError(f"ConfigMap '{ns}/{name}' key '{filename}' 'routes' field must be a list")

        for idx, r in enumerate(raw_routes):
            if not isinstance(r, dict):
                raise ValueError(f"ConfigMap '{ns}/{name}' key '{filename}' route #{idx} is not a dict")
            r_id = str(r.get("name") or r.get("id") or f"route-{idx}")
            identity = f"{ns}/{name}/{r_id}"

            route_plugins = normalize_plugin_list(r.get("plugins"), f"ConfigMap route '{identity}'")

            pc_name = r.get("plugin_config_id") or r.get("plugin_config_name")
            pc_plugins: list[dict[str, Any]] = []
            if pc_name:
                pc_key = str(pc_name)
                if (ns, pc_key) in plugin_configs:
                    pc_plugins = plugin_configs[(ns, pc_key)]
                elif pc_key in plugin_configs:
                    pc_plugins = plugin_configs[pc_key]
                else:
                    raise ValueError(
                        f"ConfigMap route '{identity}' references unknown plugin config '{pc_name}'"
                    )

            effective_plugins = merge_plugins(global_plugins, pc_plugins, route_plugins)
            hosts = r.get("hosts") or ([r["host"]] if "host" in r else [])
            paths = r.get("paths") or ([r["uri"]] if "uri" in r else ["/*"])
            plugin_names = [p["name"] for p in route_plugins if isinstance(p, dict) and "name" in p]

            is_restricted, ip_msg = check_ip_restriction(effective_plugins)
            if is_restricted:
                routes[identity] = {
                    "identity": identity,
                    "kind": "ConfigMapRoute",
                    "namespace": ns,
                    "name": name,
                    "hosts": hosts,
                    "paths": paths,
                    "plugins": plugin_names,
                    "compliant": True,
                    "classification": "ip_restricted",
                    "reason": ip_msg,
                }
            else:
                has_rl, rl_msg = check_rate_limiting(effective_plugins)
                routes[identity] = {
                    "identity": identity,
                    "kind": "ConfigMapRoute",
                    "namespace": ns,
                    "name": name,
                    "hosts": hosts,
                    "paths": paths,
                    "plugins": plugin_names,
                    "compliant": has_rl,
                    "classification": "rate_limited" if has_rl else "unprotected_external",
                    "reason": rl_msg,
                }

    return routes


def extract_routes_from_docs(
    docs: list[dict[str, Any]],
    global_plugins: list[dict[str, Any]],
    plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Extract and evaluate all route objects from parsed documents."""
    routes: dict[str, dict[str, Any]] = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        kind = doc.get("kind")
        if kind == "ApisixRoute":
            ar_routes = extract_routes_from_apisix_route(doc, global_plugins, plugin_configs)
            routes.update(ar_routes)
        elif kind == "Ingress":
            ing_routes = extract_routes_from_ingress(doc, global_plugins, plugin_configs)
            routes.update(ing_routes)
        elif kind == "ConfigMap":
            cm_routes = extract_routes_from_configmap(doc, global_plugins, plugin_configs)
            routes.update(cm_routes)
    return routes


def extract_routes(
    manifest_text: str,
    external_global_plugins: list[dict[str, Any]] | None = None,
    external_plugin_configs: dict[str | tuple[str, str], list[dict[str, Any]]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Parse manifest text using yaml.safe_load_all and extract all APISIX route objects."""
    try:
        raw_docs = list(yaml.safe_load_all(manifest_text))
    except yaml.YAMLError as exc:
        raise ValueError(f"Failed to parse manifest YAML: {exc}")

    docs = [d for d in raw_docs if isinstance(d, dict)]
    internal_global_plugins, internal_plugin_configs = extract_globals(docs)

    all_global_plugins = list(external_global_plugins or []) + internal_global_plugins
    all_plugin_configs = dict(external_plugin_configs or {})
    all_plugin_configs.update(internal_plugin_configs)

    return extract_routes_from_docs(docs, all_global_plugins, all_plugin_configs)


def audit_routes(
    rendered_routes: dict[str, dict[str, Any]],
    baseline: dict[str, dict[str, Any]],
) -> tuple[list[str], list[str]]:
    """Audit rendered routes against the frozen baseline under ratchet rules.

    Returns (errors, notices).
    """
    errors: list[str] = []
    notices: list[str] = []

    if not rendered_routes:
        errors.append("fail closed: zero relevant APISIX route objects found in rendered manifests")
        return errors, notices

    violations: dict[str, dict[str, Any]] = {}
    compliant: dict[str, dict[str, Any]] = {}

    for identity, route_info in sorted(rendered_routes.items()):
        if route_info["compliant"]:
            compliant[identity] = route_info
        else:
            violations[identity] = route_info

    # 1. Evaluate violations against baseline and frozen attributes
    for identity, info in sorted(violations.items()):
        if identity not in baseline:
            errors.append(
                f"NEW VIOLATION: route '{identity}' lacks required rate limiting and is not in frozen baseline: {info['reason']}"
            )
        else:
            base_entry = baseline[identity]
            diffs = []
            if set(info.get("hosts", [])) != set(base_entry.get("hosts", [])):
                diffs.append(
                    f"hosts changed (expected {sorted(base_entry.get('hosts', []))}, got {sorted(info.get('hosts', []))})"
                )
            if set(info.get("paths", [])) != set(base_entry.get("paths", [])):
                diffs.append(
                    f"paths changed (expected {sorted(base_entry.get('paths', []))}, got {sorted(info.get('paths', []))})"
                )
            if set(info.get("plugins", [])) != set(base_entry.get("plugins", [])):
                diffs.append(
                    f"plugin set changed (expected {sorted(base_entry.get('plugins', []))}, got {sorted(info.get('plugins', []))})"
                )

            if diffs:
                errors.append(
                    f"BASELINE DRIFT: route '{identity}' attributes modified while remaining non-compliant: "
                    + "; ".join(diffs)
                )
            else:
                notices.append(
                    f"BASELINE VIOLATION: {identity} ({base_entry['issue']}): {info['reason']}"
                )

    # 2. Check for stale baseline entries (route removed or made compliant)
    for identity, entry in sorted(baseline.items()):
        if identity not in rendered_routes:
            errors.append(
                f"STALE BASELINE: route '{identity}' is in baseline but no longer exists in rendered charts; remove from baseline"
            )
        elif identity in compliant:
            errors.append(
                f"STALE BASELINE: route '{identity}' is now compliant ({compliant[identity]['reason']}); ratchet requires removing it from baseline"
            )

    return errors, notices


def render_all_routes() -> dict[str, dict[str, Any]]:
    """Render all deployed chart combinations and collect all APISIX route objects.

    Global rules and plugin configurations across all charts (e.g. ApisixGlobalRule
    rendered in beluga-platform) are aggregated so cross-chart rules protect routes in
    beluga-data.
    """
    combo_manifests: list[str] = []
    combo_docs_list: list[list[dict[str, Any]]] = []

    for chart_name, extra_args in DEPLOYED_COMBOS:
        cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart_name)] + extra_args
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "KUBECONFIG": os.devnull},
        )
        combo_manifests.append(res.stdout)
        try:
            raw_docs = list(yaml.safe_load_all(res.stdout))
        except yaml.YAMLError as exc:
            raise ValueError(f"Failed to parse rendered manifest for chart '{chart_name}': {exc}")
        combo_docs_list.append([d for d in raw_docs if isinstance(d, dict)])

    # Aggregate global rules and plugin configs across all charts
    all_docs = [d for docs in combo_docs_list for d in docs]
    global_plugins, plugin_configs = extract_globals(all_docs)

    all_routes: dict[str, dict[str, Any]] = {}
    for combo_docs in combo_docs_list:
        combo_routes = extract_routes_from_docs(combo_docs, global_plugins, plugin_configs)
        for identity, route_info in combo_routes.items():
            if identity in all_routes:
                # If any combo renders this route as non-compliant, non-compliant takes precedence
                if all_routes[identity]["compliant"] and not route_info["compliant"]:
                    all_routes[identity] = route_info
            else:
                all_routes[identity] = route_info

    return all_routes


def self_test() -> int:
    """Run comprehensive self-tests on fixtures for all rules and ratchet behaviors."""
    fixture_count = 0

    def make_cr(name: str, ns: str, plugins: list[dict[str, Any]], rule_name: str | None = None) -> dict[str, Any]:
        r_name = rule_name or name
        return {
            "apiVersion": "apisix.apache.org/v2",
            "kind": "ApisixRoute",
            "metadata": {"name": name, "namespace": ns},
            "spec": {
                "http": [
                    {
                        "name": r_name,
                        "match": {"hosts": [f"{name}.local.beluga.internal"], "paths": ["/*"]},
                        "plugins": plugins,
                    }
                ]
            },
        }

    # Rule 1: Positive limit-req
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 100, "burst": 50}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    ok = routes["apps/srv/srv"]["compliant"]
    cls = routes["apps/srv/srv"]["classification"]
    assert ok and cls == "rate_limited", "Rule 1 positive limit-req failed"
    fixture_count += 1

    # Rule 2: Positive limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 100, "time_window": 60}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    ok = routes["apps/srv/srv"]["compliant"]
    cls = routes["apps/srv/srv"]["classification"]
    assert ok and cls == "rate_limited", "Rule 2 positive limit-count failed"
    fixture_count += 1

    # Rule 3: Positive limit-conn
    cr = make_cr("srv", "apps", [{"name": "limit-conn", "enable": True, "config": {"conn": 50, "burst": 10}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    ok = routes["apps/srv/srv"]["compliant"]
    cls = routes["apps/srv/srv"]["classification"]
    assert ok and cls == "rate_limited", "Rule 3 positive limit-conn failed"
    fixture_count += 1

    # Rule 4: Disabled limit-req (enable: false)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": False, "config": {"rate": 100, "burst": 50}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    ok = routes["apps/srv/srv"]["compliant"]
    cls = routes["apps/srv/srv"]["classification"]
    assert not ok and cls == "unprotected_external", "Rule 4 disabled limit-req failed"
    fixture_count += 1

    # Rule 5: Non-positive rate in limit-req (rate: 0)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 0, "burst": 50}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 5 zero rate in limit-req failed"
    fixture_count += 1

    # Rule 6: Negative rate in limit-req (rate: -5)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": -5, "burst": 50}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 6 negative rate in limit-req failed"
    fixture_count += 1

    # Rule 7: Negative burst in limit-req (burst: -1)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 10, "burst": -1}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 7 negative burst in limit-req failed"
    fixture_count += 1

    # Rule 8: Zero count in limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 0, "time_window": 60}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 8 zero count in limit-count failed"
    fixture_count += 1

    # Rule 9: Zero time_window in limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 10, "time_window": 0}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 9 zero time_window in limit-count failed"
    fixture_count += 1

    # Rule 10: Zero conn in limit-conn
    cr = make_cr("srv", "apps", [{"name": "limit-conn", "enable": True, "config": {"conn": 0, "burst": 0}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 10 zero conn in limit-conn failed"
    fixture_count += 1

    # Rule 11: Missing config in rate limit plugin
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 11 missing config failed"
    fixture_count += 1

    # Rule 12: Boolean type for numeric field
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": True, "burst": 1}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"], "Rule 12 bool type masquerading as int failed"
    fixture_count += 1

    # Rule 13: Positive IP-restriction (RFC 1918 10.0.0.0/8 allowlist)
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["10.0.0.0/8"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert routes["apps/srv/srv"]["compliant"] and routes["apps/srv/srv"]["classification"] == "ip_restricted"
    fixture_count += 1

    # Rule 14: Positive IP-restriction (RFC 4193 ULA fc00::/7)
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["fc00::/7"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert routes["apps/srv/srv"]["compliant"] and routes["apps/srv/srv"]["classification"] == "ip_restricted"
    fixture_count += 1

    # Rule 15: Overly broad IPv4 CIDR 0.0.0.0/0 must NOT count as internal
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["0.0.0.0/0"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"] and routes["apps/srv/srv"]["classification"] == "unprotected_external"
    fixture_count += 1

    # Rule 16: Overly broad IPv6 CIDR ::/0 must NOT count as internal
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["::/0"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"] and routes["apps/srv/srv"]["classification"] == "unprotected_external"
    fixture_count += 1

    # Rule 17: Overly broad IPv4 prefix < /8 (1.0.0.0/7) rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["1.0.0.0/7"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 18: Overly broad IPv6 prefix < /7 (2000::/3) rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["2000::/3"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 19: Allowlist mixing valid CIDR with 0.0.0.0/0 rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["10.0.0.0/8", "0.0.0.0/0"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 20: Disabled IP-restriction (enable: false) rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": False, "config": {"allow": ["10.0.0.0/8"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 21: Disabled IP-restriction via disable: true rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "disable": True, "config": {"allow": ["10.0.0.0/8"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 22: Disabled IP-restriction via _meta.disable rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "_meta": {"disable": True}, "config": {"allow": ["10.0.0.0/8"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 23: Empty allowlist rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": []}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 24: Blocklist-only in IP-restriction rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"block": ["1.2.3.4"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 25: Invalid CIDR string in allowlist rejected
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["not-an-ip"]}}])
    routes = extract_routes_from_apisix_route(cr, [], {})
    assert not routes["apps/srv/srv"]["compliant"]
    fixture_count += 1

    # Rule 26: Multi-entry ApisixRoute: new unprotected entry in baselined CR fails
    cr_multi = {
        "apiVersion": "apisix.apache.org/v2",
        "kind": "ApisixRoute",
        "metadata": {"name": "app", "namespace": "apps"},
        "spec": {
            "http": [
                {
                    "name": "public",
                    "match": {"hosts": ["app.local.beluga.internal"], "paths": ["/*"]},
                    "plugins": [{"name": "response-rewrite", "enable": True}],
                },
                {
                    "name": "internal-admin",
                    "match": {"hosts": ["admin.local.beluga.internal"], "paths": ["/admin*"]},
                    "plugins": [],
                },
            ]
        },
    }
    multi_routes = extract_routes_from_apisix_route(cr_multi, [], {})
    assert "apps/app/public" in multi_routes and "apps/app/internal-admin" in multi_routes
    test_baseline = {
        "apps/app/public": {
            "issue": "#48",
            "hosts": ["app.local.beluga.internal"],
            "paths": ["/*"],
            "plugins": ["response-rewrite"],
        }
    }
    errs, _ = audit_routes(multi_routes, test_baseline)
    assert any("NEW VIOLATION: route 'apps/app/internal-admin'" in e for e in errs)
    fixture_count += 1

    # Rule 27: Multi-entry ApisixRoute: second entry compliant passes
    cr_multi_ok = {
        "apiVersion": "apisix.apache.org/v2",
        "kind": "ApisixRoute",
        "metadata": {"name": "app", "namespace": "apps"},
        "spec": {
            "http": [
                {
                    "name": "public",
                    "match": {"hosts": ["app.local.beluga.internal"], "paths": ["/*"]},
                    "plugins": [{"name": "response-rewrite", "enable": True}],
                },
                {
                    "name": "api",
                    "match": {"hosts": ["api.local.beluga.internal"], "paths": ["/api*"]},
                    "plugins": [{"name": "limit-req", "enable": True, "config": {"rate": 50}}],
                },
            ]
        },
    }
    multi_ok_routes = extract_routes_from_apisix_route(cr_multi_ok, [], {})
    errs, notices = audit_routes(multi_ok_routes, test_baseline)
    assert not errs and any("BASELINE VIOLATION: apps/app/public" in n for n in notices)
    fixture_count += 1

    # Rule 28: Baseline drift rejected (hosts changed)
    drift_hosts_routes = {
        "apps/app/public": {
            "identity": "apps/app/public",
            "compliant": False,
            "hosts": ["tampered.local.beluga.internal"],
            "paths": ["/*"],
            "plugins": ["response-rewrite"],
            "reason": "missing rate limit",
        }
    }
    errs, _ = audit_routes(drift_hosts_routes, test_baseline)
    assert any("BASELINE DRIFT: route 'apps/app/public'" in e and "hosts changed" in e for e in errs)
    fixture_count += 1

    # Rule 29: Baseline drift rejected (paths changed)
    drift_paths_routes = {
        "apps/app/public": {
            "identity": "apps/app/public",
            "compliant": False,
            "hosts": ["app.local.beluga.internal"],
            "paths": ["/new-path"],
            "plugins": ["response-rewrite"],
            "reason": "missing rate limit",
        }
    }
    errs, _ = audit_routes(drift_paths_routes, test_baseline)
    assert any("BASELINE DRIFT: route 'apps/app/public'" in e and "paths changed" in e for e in errs)
    fixture_count += 1

    # Rule 30: Baseline drift rejected (plugins changed without becoming compliant)
    drift_plugins_routes = {
        "apps/app/public": {
            "identity": "apps/app/public",
            "compliant": False,
            "hosts": ["app.local.beluga.internal"],
            "paths": ["/*"],
            "plugins": ["response-rewrite", "cors"],
            "reason": "missing rate limit",
        }
    }
    errs, _ = audit_routes(drift_plugins_routes, test_baseline)
    assert any("BASELINE DRIFT: route 'apps/app/public'" in e and "plugin set changed" in e for e in errs)
    fixture_count += 1

    # Rule 31: Stale baseline (route became compliant) rejected
    compliant_routes = {
        "apps/app/public": {
            "identity": "apps/app/public",
            "compliant": True,
            "hosts": ["app.local.beluga.internal"],
            "paths": ["/*"],
            "plugins": ["limit-req"],
            "reason": "limit-req active",
        }
    }
    errs, _ = audit_routes(compliant_routes, test_baseline)
    assert any("STALE BASELINE: route 'apps/app/public' is now compliant" in e for e in errs)
    fixture_count += 1

    # Rule 32: Stale baseline (route deleted) rejected
    errs, _ = audit_routes({"apps/other/other": {"compliant": True, "reason": "ok"}}, test_baseline)
    assert any("STALE BASELINE: route 'apps/app/public' is in baseline but no longer exists" in e for e in errs)
    fixture_count += 1

    # Rule 33: Fail closed on zero route objects
    errs, _ = audit_routes({}, test_baseline)
    assert any("fail closed: zero relevant APISIX route objects" in e for e in errs)
    fixture_count += 1

    # Rule 34: Ingress with apisix ingress class detected as unprotected
    ing_unprotected = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "Ingress",
        "metadata": {"name": "web", "namespace": "apps"},
        "spec": {
            "ingressClassName": "apisix",
            "rules": [{"host": "web.local.beluga.internal", "http": {"paths": [{"path": "/app"}]}}],
        },
    }
    ing_routes = extract_routes_from_ingress(ing_unprotected, [], {})
    assert "apps/web/web.local.beluga.internal:/app" in ing_routes
    assert not ing_routes["apps/web/web.local.beluga.internal:/app"]["compliant"]
    fixture_count += 1

    # Rule 35: Ingress with non-apisix ingress class ignored
    ing_nginx = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "Ingress",
        "metadata": {"name": "web", "namespace": "apps"},
        "spec": {
            "ingressClassName": "nginx",
            "rules": [{"host": "web.local.beluga.internal", "http": {"paths": [{"path": "/app"}]}}],
        },
    }
    assert len(extract_routes_from_ingress(ing_nginx, [], {})) == 0
    fixture_count += 1

    # Rule 36: Ingress with apisix plugins annotation compliant
    ing_plugins_yaml = yaml.dump([{"name": "limit-req", "enable": True, "config": {"rate": 20}}])
    ing_compliant = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "Ingress",
        "metadata": {
            "name": "web-protected",
            "namespace": "apps",
            "annotations": {
                "kubernetes.io/ingress.class": "apisix",
                "k8s.apisix.apache.org/plugins": ing_plugins_yaml,
            },
        },
        "spec": {
            "rules": [{"host": "web.local.beluga.internal", "http": {"paths": [{"path": "/app"}]}}],
        },
    }
    ing_routes = extract_routes_from_ingress(ing_compliant, [], {})
    assert ing_routes["apps/web-protected/web.local.beluga.internal:/app"]["compliant"]
    fixture_count += 1

    # Rule 37: ApisixPluginConfig resolution via plugin_config_name
    pc_manifest = """
apiVersion: apisix.apache.org/v2
kind: ApisixPluginConfig
metadata:
  name: common-rl
  namespace: apps
spec:
  plugins:
  - name: limit-req
    enable: true
    config:
      rate: 100
      burst: 20
---
apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: srv-pc
  namespace: apps
spec:
  http:
  - name: srv-pc
    plugin_config_name: common-rl
    match:
      hosts: ["srv-pc.local.beluga.internal"]
      paths: ["/*"]
    plugins:
    - name: response-rewrite
      enable: true
"""
    pc_routes = extract_routes(pc_manifest)
    assert pc_routes["apps/srv-pc/srv-pc"]["compliant"]
    fixture_count += 1

    # Rule 38: Unresolvable ApisixPluginConfig fails loudly (ValueError)
    bad_pc_manifest = """
apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: srv-bad-pc
  namespace: apps
spec:
  http:
  - name: srv-bad-pc
    plugin_config_name: non-existent-pc
    match:
      hosts: ["srv.local.beluga.internal"]
      paths: ["/*"]
"""
    try:
        extract_routes(bad_pc_manifest)
        assert False, "Unresolvable plugin_config_name did not fail loudly"
    except ValueError as exc:
        assert "non-existent-pc" in str(exc)
    fixture_count += 1

    # Rule 39: ApisixGlobalRule rate-limit plugin inherited by routes
    gr_manifest = """
apiVersion: apisix.apache.org/v2
kind: ApisixGlobalRule
metadata:
  name: global-ratelimit
  namespace: platform-system
spec:
  plugins:
  - name: limit-req
    enable: true
    config:
      rate: 500
      burst: 100
---
apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: srv-global
  namespace: apps
spec:
  http:
  - name: srv-global
    match:
      hosts: ["srv-global.local.beluga.internal"]
      paths: ["/*"]
"""
    gr_routes = extract_routes(gr_manifest)
    assert gr_routes["apps/srv-global/srv-global"]["compliant"]
    fixture_count += 1

    # Rule 40: Malformed ApisixGlobalRule plugins fails loudly
    bad_gr_manifest = """
apiVersion: apisix.apache.org/v2
kind: ApisixGlobalRule
metadata:
  name: bad-gr
  namespace: platform-system
spec:
  plugins: "invalid-not-a-list"
"""
    try:
        extract_routes(bad_gr_manifest)
        assert False, "Malformed ApisixGlobalRule did not fail loudly"
    except ValueError as exc:
        assert "must be a list" in str(exc)
    fixture_count += 1

    # Rule 41: ConfigMap route definitions under custom key evaluated
    cm_custom_manifest = """
apiVersion: v1
kind: ConfigMap
metadata:
  name: standalone-conf
  namespace: gateway
data:
  custom-routes.yaml: |
    routes:
      - id: 1
        name: cm-route
        host: cm.local.beluga.internal
        plugins:
          limit-req:
            rate: 200
            burst: 50
"""
    cm_routes = extract_routes(cm_custom_manifest)
    assert "gateway/standalone-conf/cm-route" in cm_routes
    assert cm_routes["gateway/standalone-conf/cm-route"]["compliant"]
    fixture_count += 1

    # Rule 42: ConfigMap with malformed YAML under route key fails loudly
    cm_bad_manifest = """
apiVersion: v1
kind: ConfigMap
metadata:
  name: bad-cm
  namespace: gateway
data:
  routes.yaml: "{ invalid: yaml: [ "
"""
    try:
        extract_routes(cm_bad_manifest)
        assert False, "Malformed ConfigMap route YAML did not fail loudly"
    except ValueError as exc:
        assert "invalid YAML" in str(exc)
    fixture_count += 1

    # Rule 43: ConfigMap global_rules inherited by ConfigMap routes
    cm_gr_manifest = """
apiVersion: v1
kind: ConfigMap
metadata:
  name: standalone-global
  namespace: gateway
data:
  apisix.yaml: |
    global_rules:
      - id: 1
        plugins:
          limit-req:
            rate: 100
            burst: 20
    routes:
      - id: r1
        host: r1.local.beluga.internal
"""
    cm_gr_routes = extract_routes(cm_gr_manifest)
    assert cm_gr_routes["gateway/standalone-global/r1"]["compliant"]
    fixture_count += 1

    return fixture_count


def main() -> int:
    try:
        fixtures_passed = self_test()
    except (AssertionError, Exception) as exc:
        print(f"FAIL: APISIX route rate-limit self-test failed: {exc}", file=sys.stderr)
        return 1

    print(f"Self-tests OK: {fixtures_passed} positive/negative fixtures rejected and validated.")
    print("=== APISIX route rate-limit ratchet gate check ===")

    try:
        if len(sys.argv) > 1:
            manifest_parts = []
            for path_str in sys.argv[1:]:
                p = Path(path_str)
                if not p.is_file():
                    print(f"FAIL: file not found: {p}", file=sys.stderr)
                    return 1
                manifest_parts.append(p.read_text(encoding="utf-8"))
            rendered_routes = extract_routes("\n---\n".join(manifest_parts))
        else:
            rendered_routes = render_all_routes()

    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited with code {exc.returncode}:\n{exc.stderr}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"FAIL: error inspecting APISIX routes: {exc}", file=sys.stderr)
        return 1

    errors, notices = audit_routes(rendered_routes, FROZEN_BASELINE)

    for notice in notices:
        print(f"[BASELINE] {notice}")

    if errors:
        print()
        for err in errors:
            print(f"FAIL: {err}", file=sys.stderr)
        print(f"\nAPISIX route rate-limit check FAILED with {len(errors)} error(s).", file=sys.stderr)
        return 1

    print(f"\nOK: All {len(rendered_routes)} rendered APISIX route(s) match the frozen baseline (ratchet clean).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
