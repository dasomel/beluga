#!/usr/bin/env python3
"""Ratchet gate for APISIX route rate limiting (Issue #48).

Enforces that every externally reachable APISIX route object in rendered Helm manifests
carries an enabled rate limiting plugin (limit-req, limit-count, or limit-conn) with
positive limits. Internal-only/admin routes restricted by an ip-restriction allowlist
are classified separately and exempted from external rate-limit enforcement.

Existing violations are frozen in a baseline dictionary. The gate fails closed on:
- Any violation not present in the baseline (new unprotected routes)
- Any baseline entry that no longer violates (ratchet only tightens: stale entry)
- Any baseline entry that no longer exists in rendered manifests (stale entry)
- Zero relevant route objects found in rendered charts (fail closed)
- Helm template execution failure
"""
from __future__ import annotations

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
# Note: strimzi.oauthListener was inspected (gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml);
# it is false by default, never enabled by 01-argocd-bootstrap.sh or env.sh, and toggles only Kafka CR
# listeners without generating any ApisixRoute objects.
DEPLOYED_COMBOS: list[tuple[str, list[str]]] = [
    ("beluga-platform", []),
    ("beluga-data", []),
    ("beluga-data", ["--set", "trino.workerEnabled=true,openmetadata.enabled=true"]),
]

# FROZEN baseline of existing violations before Issue #48 remediation.
# Keyed by stable route identity (namespace/name).
FROZEN_BASELINE: dict[str, dict[str, str]] = {
    "analytics/superset": {
        "issue": "#48",
        "reason": "Superset BI dashboard UI and REST API exposed on superset.local.beluga.internal without rate limiting; needs limit-req plugin to protect chart rendering and login routes.",
    },
    "analytics/trino": {
        "issue": "#48",
        "reason": "Trino query coordinator UI and REST API exposed on trino.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to guard against query flooding.",
    },
    "governance/openmetadata": {
        "issue": "#48",
        "reason": "OpenMetadata governance server UI and API exposed on metadata.local.beluga.internal without rate limiting (profile 48GB+); needs limit-req plugin to guard metadata ingestion.",
    },
    "iam/keycloak": {
        "issue": "#48",
        "reason": "Keycloak SSO authentication realm and admin console exposed on sso.local.beluga.internal without rate limiting; needs limit-req plugin to mitigate credential stuffing and auth endpoint abuse.",
    },
    "lakehouse/lakekeeper": {
        "issue": "#48",
        "reason": "Lakekeeper Iceberg REST catalog API exposed on catalog.local.beluga.internal without rate limiting; needs limit-req plugin to protect catalog metadata queries and commit endpoints.",
    },
    "orchestration/airflow": {
        "issue": "#48",
        "reason": "Airflow webserver UI and API exposed on airflow.local.beluga.internal without rate limiting; needs limit-req plugin to prevent UI session exhaustion and API abuse.",
    },
    "platform-system/argocd": {
        "issue": "#48",
        "reason": "ArgoCD Web UI/API exposed on argocd.local.beluga.internal without rate limiting; needs limit-req/limit-count plugin to prevent brute-force and DoS on login and API endpoints.",
    },
    "storage/seaweedfs-filer": {
        "issue": "#48",
        "reason": "SeaweedFS Filer HTTP interface exposed on filer.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to protect file browsing and metadata lookups.",
    },
    "storage/seaweedfs-s3": {
        "issue": "#48",
        "reason": "SeaweedFS S3 object storage API exposed on s3.local.beluga.internal without rate limiting; needs limit-req/limit-conn plugin to prevent S3 data-plane saturation.",
    },
    "streaming/flink": {
        "issue": "#48",
        "reason": "Flink JobManager dashboard and REST API exposed on flink.local.beluga.internal without rate limiting; needs limit-req plugin to prevent JobManager API overload.",
    },
}


def is_positive_number(val: Any) -> bool:
    """Return True if val is a positive int or float (excluding bool)."""
    return type(val) in (int, float) and val > 0


def is_non_negative_number(val: Any) -> bool:
    """Return True if val is a non-negative int or float (excluding bool)."""
    return type(val) in (int, float) and val >= 0


def check_ip_restriction(plugins: list[dict[str, Any]]) -> tuple[bool, str]:
    """Check if an enabled ip-restriction plugin restricts route access via allowlist.

    D1: A denylist/blocklist (only blocking a few IPs) leaves the route open to arbitrary
    clients on the internet, so it remains externally reachable. Only an explicit allowlist
    (allow or whitelist) restricts access to internal-only / administrative networks.
    """
    for p in plugins:
        if not isinstance(p, dict):
            continue
        if p.get("name") == "ip-restriction" and p.get("enable", True) is not False:
            cfg = p.get("config")
            if isinstance(cfg, dict):
                allow = cfg.get("allow") or cfg.get("whitelist")
                if isinstance(allow, list) and len(allow) > 0 and all(isinstance(x, str) and x.strip() for x in allow):
                    return True, f"ip-restriction allowlist active ({len(allow)} CIDRs/IPs)"
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
        if p.get("enable", True) is False:
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


def evaluate_apisix_route(doc: dict[str, Any]) -> tuple[bool, str, str]:
    """Evaluate an ApisixRoute CR.

    Returns (compliant, classification, reason).
    """
    spec = doc.get("spec", {})
    http_rules = spec.get("http", [])
    if not isinstance(http_rules, list) or not http_rules:
        return False, "invalid", "ApisixRoute spec.http is empty or not a list"

    # Evaluate all HTTP rules in the route
    rule_statuses = []
    for idx, rule in enumerate(http_rules):
        rule_name = rule.get("name", f"rule-{idx}")
        plugins = rule.get("plugins") or []
        if not isinstance(plugins, list):
            plugins = []

        is_restricted, ip_msg = check_ip_restriction(plugins)
        if is_restricted:
            rule_statuses.append((True, "ip_restricted", f"{rule_name}: {ip_msg}"))
            continue

        has_rate_limit, rl_msg = check_rate_limiting(plugins)
        if has_rate_limit:
            rule_statuses.append((True, "rate_limited", f"{rule_name}: {rl_msg}"))
        else:
            rule_statuses.append((False, "unprotected_external", f"{rule_name}: {rl_msg}"))

    # If any rule is unprotected_external, the route object as a whole violates
    violations = [msg for (ok, cls, msg) in rule_statuses if not ok]
    if violations:
        return False, "unprotected_external", "; ".join(violations)

    classifications = {cls for (ok, cls, msg) in rule_statuses}
    summary = "; ".join(msg for (ok, cls, msg) in rule_statuses)
    if classifications == {"ip_restricted"}:
        return True, "ip_restricted", summary
    return True, "rate_limited", summary


def extract_routes_from_configmap(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Extract standalone APISIX routes from ConfigMaps if defined."""
    routes: dict[str, dict[str, Any]] = {}
    ns = doc.get("metadata", {}).get("namespace", "default")
    name = doc.get("metadata", {}).get("name", "")
    data = doc.get("data", {})
    if not isinstance(data, dict):
        return routes

    for filename in ("apisix.yaml", "routes.yaml"):
        if filename not in data:
            continue
        try:
            content = yaml.safe_load(data[filename])
        except yaml.YAMLError:
            continue
        if not isinstance(content, dict):
            continue
        raw_routes = content.get("routes")
        if not isinstance(raw_routes, list):
            continue
        for idx, r in enumerate(raw_routes):
            if not isinstance(r, dict):
                continue
            r_id = str(r.get("id") or r.get("name") or f"route-{idx}")
            identity = f"{ns}/{name}/{r_id}"
            plugins = r.get("plugins", {})
            plugin_list = []
            if isinstance(plugins, dict):
                for p_name, p_cfg in plugins.items():
                    if isinstance(p_cfg, dict):
                        plugin_list.append({"name": p_name, **p_cfg, "config": p_cfg})
            is_restricted, ip_msg = check_ip_restriction(plugin_list)
            if is_restricted:
                routes[identity] = {
                    "identity": identity,
                    "kind": "ConfigMapRoute",
                    "compliant": True,
                    "classification": "ip_restricted",
                    "reason": ip_msg,
                }
            else:
                has_rate_limit, rl_msg = check_rate_limiting(plugin_list)
                routes[identity] = {
                    "identity": identity,
                    "kind": "ConfigMapRoute",
                    "compliant": has_rate_limit,
                    "classification": "rate_limited" if has_rate_limit else "unprotected_external",
                    "reason": rl_msg,
                }
    return routes


def extract_routes(manifest_text: str) -> dict[str, dict[str, Any]]:
    """Parse manifest text using yaml.safe_load_all and extract all APISIX route objects."""
    routes: dict[str, dict[str, Any]] = {}
    for doc in yaml.safe_load_all(manifest_text):
        if not isinstance(doc, dict):
            continue
        kind = doc.get("kind")
        if kind == "ApisixRoute":
            ns = doc.get("metadata", {}).get("namespace", "default")
            name = doc.get("metadata", {}).get("name", "")
            identity = f"{ns}/{name}"
            compliant, classification, reason = evaluate_apisix_route(doc)
            routes[identity] = {
                "identity": identity,
                "kind": "ApisixRoute",
                "namespace": ns,
                "name": name,
                "compliant": compliant,
                "classification": classification,
                "reason": reason,
            }
        elif kind == "ConfigMap":
            cm_routes = extract_routes_from_configmap(doc)
            routes.update(cm_routes)
    return routes


def audit_routes(
    rendered_routes: dict[str, dict[str, Any]],
    baseline: dict[str, dict[str, str]],
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

    # 1. New violations not recorded in baseline
    for identity, info in sorted(violations.items()):
        if identity not in baseline:
            errors.append(
                f"NEW VIOLATION: route '{identity}' lacks required rate limiting and is not in frozen baseline: {info['reason']}"
            )
        else:
            notices.append(
                f"BASELINE VIOLATION: {identity} ({baseline[identity]['issue']}): {info['reason']}"
            )

    # 2. Stale baseline entries (route no longer exists or now compliant)
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


def self_test() -> int:
    """Run comprehensive self-tests on fixtures for all rules and ratchet behaviors."""
    fixture_count = 0

    def make_cr(name: str, ns: str, plugins: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "apiVersion": "apisix.apache.org/v2",
            "kind": "ApisixRoute",
            "metadata": {"name": name, "namespace": ns},
            "spec": {
                "http": [
                    {
                        "name": name,
                        "match": {"hosts": [f"{name}.local.beluga.internal"], "paths": ["/*"]},
                        "plugins": plugins,
                    }
                ]
            },
        }

    # Rule 1: Positive limit-req
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 100, "burst": 50}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert ok and cls == "rate_limited", "Rule 1 positive limit-req failed"
    fixture_count += 1

    # Rule 2: Positive limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 100, "time_window": 60}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert ok and cls == "rate_limited", "Rule 2 positive limit-count failed"
    fixture_count += 1

    # Rule 3: Positive limit-conn
    cr = make_cr("srv", "apps", [{"name": "limit-conn", "enable": True, "config": {"conn": 50, "burst": 10}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert ok and cls == "rate_limited", "Rule 3 positive limit-conn failed"
    fixture_count += 1

    # Rule 4: Disabled limit-req (enable: false)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": False, "config": {"rate": 100, "burst": 50}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok and cls == "unprotected_external", "Rule 4 disabled limit-req failed"
    fixture_count += 1

    # Rule 5: Non-positive rate in limit-req (rate: 0)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 0, "burst": 50}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 5 zero rate in limit-req failed"
    fixture_count += 1

    # Rule 6: Negative rate in limit-req (rate: -5)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": -5, "burst": 50}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 6 negative rate in limit-req failed"
    fixture_count += 1

    # Rule 7: Negative burst in limit-req (burst: -1)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": 10, "burst": -1}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 7 negative burst in limit-req failed"
    fixture_count += 1

    # Rule 8: Zero count in limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 0, "time_window": 60}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 8 zero count in limit-count failed"
    fixture_count += 1

    # Rule 9: Zero time_window in limit-count
    cr = make_cr("srv", "apps", [{"name": "limit-count", "enable": True, "config": {"count": 10, "time_window": 0}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 9 zero time_window in limit-count failed"
    fixture_count += 1

    # Rule 10: Zero conn in limit-conn
    cr = make_cr("srv", "apps", [{"name": "limit-conn", "enable": True, "config": {"conn": 0, "burst": 0}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 10 zero conn in limit-conn failed"
    fixture_count += 1

    # Rule 11: Missing config in rate limit plugin
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 11 missing config failed"
    fixture_count += 1

    # Rule 12: Boolean type for numeric field (bool issubclass of int in Python)
    cr = make_cr("srv", "apps", [{"name": "limit-req", "enable": True, "config": {"rate": True, "burst": 1}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok, "Rule 12 bool type masquerading as int failed"
    fixture_count += 1

    # Rule 13: Positive IP-restriction (allowlist)
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": ["10.42.0.0/16"]}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert ok and cls == "ip_restricted", "Rule 13 positive ip-restriction failed"
    fixture_count += 1

    # Rule 14: Positive IP-restriction (whitelist alias)
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"whitelist": ["10.0.0.0/8"]}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert ok and cls == "ip_restricted", "Rule 14 positive ip-restriction whitelist failed"
    fixture_count += 1

    # Rule 15: Disabled IP-restriction (enable: false) without rate limit
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": False, "config": {"allow": ["10.0.0.0/8"]}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok and cls == "unprotected_external", "Rule 15 disabled ip-restriction failed"
    fixture_count += 1

    # Rule 16: Empty allowlist in IP-restriction
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"allow": []}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok and cls == "unprotected_external", "Rule 16 empty allowlist failed"
    fixture_count += 1

    # Rule 17: Blocklist-only in IP-restriction (not internal-only)
    cr = make_cr("srv", "apps", [{"name": "ip-restriction", "enable": True, "config": {"block": ["1.2.3.4"]}}])
    ok, cls, _ = evaluate_apisix_route(cr)
    assert not ok and cls == "unprotected_external", "Rule 17 blocklist-only failed"
    fixture_count += 1

    # Rule 18: Multiple rules under spec.http where one lacks protection
    cr_multi = {
        "apiVersion": "apisix.apache.org/v2",
        "kind": "ApisixRoute",
        "metadata": {"name": "multi", "namespace": "apps"},
        "spec": {
            "http": [
                {
                    "name": "r1",
                    "plugins": [{"name": "limit-req", "enable": True, "config": {"rate": 50}}],
                },
                {
                    "name": "r2",
                    "plugins": [],
                },
            ]
        },
    }
    ok, cls, _ = evaluate_apisix_route(cr_multi)
    assert not ok and cls == "unprotected_external", "Rule 18 partial route protection failed"
    fixture_count += 1

    # Rule 19: Ratchet gate rejects new violation not in baseline
    test_routes = {
        "apps/new-service": {
            "identity": "apps/new-service",
            "compliant": False,
            "reason": "missing rate limit",
        }
    }
    errs, _ = audit_routes(test_routes, {})
    assert any("NEW VIOLATION: route 'apps/new-service'" in e for e in errs), "Rule 19 new violation rejection failed"
    fixture_count += 1

    # Rule 20: Ratchet gate rejects stale baseline entry that is now compliant
    test_routes = {
        "apps/srv": {
            "identity": "apps/srv",
            "compliant": True,
            "reason": "limit-req enabled",
        }
    }
    test_baseline = {"apps/srv": {"issue": "#48", "reason": "legacy"}}
    errs, _ = audit_routes(test_routes, test_baseline)
    assert any("STALE BASELINE: route 'apps/srv' is now compliant" in e for e in errs), "Rule 20 stale compliant baseline rejection failed"
    fixture_count += 1

    # Rule 21: Ratchet gate rejects stale baseline entry that no longer exists
    test_routes = {
        "apps/other": {
            "identity": "apps/other",
            "compliant": False,
            "reason": "missing",
        }
    }
    test_baseline = {
        "apps/other": {"issue": "#48", "reason": "legacy"},
        "apps/deleted": {"issue": "#48", "reason": "deleted route"},
    }
    errs, _ = audit_routes(test_routes, test_baseline)
    assert any("STALE BASELINE: route 'apps/deleted' is in baseline but no longer exists" in e for e in errs), "Rule 21 missing route baseline rejection failed"
    fixture_count += 1

    # Rule 22: Ratchet gate fails closed on zero relevant objects
    errs, _ = audit_routes({}, {"apps/srv": {"issue": "#48", "reason": "legacy"}})
    assert any("fail closed: zero relevant APISIX route objects" in e for e in errs), "Rule 22 fail closed on empty failed"
    fixture_count += 1

    return fixture_count


def render_all_routes() -> dict[str, dict[str, Any]]:
    """Render all deployed chart combinations and collect all APISIX route objects."""
    all_routes: dict[str, dict[str, Any]] = {}
    for chart_name, extra_args in DEPLOYED_COMBOS:
        cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart_name)] + extra_args
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "KUBECONFIG": os.devnull},
        )
        combo_routes = extract_routes(res.stdout)
        all_routes.update(combo_routes)
    return all_routes


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
            # Audit explicitly provided manifest files (used for negative verification checks)
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
