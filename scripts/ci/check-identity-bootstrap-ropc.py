#!/usr/bin/env python3
"""Ratchet gate for identity bootstrap ROPC and inline secret interpolation (Issue #3).

Issue #3 criterion:
  "Automated checks fail if an identity bootstrap reintroduces ROPC or inline secret interpolation."

Enforces that:
1. ROPC Detection:
   No rendered workload (Job, Pod, Deployment, StatefulSet, DaemonSet, CronJob) introduces
   ROPC (grant_type bound to password in any form: form bodies such as grant_type=password,
   including split across adjacent args or joined by --data/--data-urlencode/-d; JSON or
   Python dict literals such as 'grant_type': 'password'; urlencode dict/tuple literals;
   or env values containing grant_type=password), unless explicitly recorded in
   identity-bootstrap-baseline.yaml with reason and issue.
   - Workloads configured with other grant types (such as client_credentials) are NOT flagged,
     even if passwords or password keys are mentioned elsewhere in the workload spec
     (e.g. in user provisioning dicts or database connection variables).
   - Detection is static and pattern-based: request bodies dynamically assembled at runtime
     from variables or external calls are out of scope (do not overclaim).

2. Inline Secret Interpolation Detection:
   Scope: container and initContainer command, args and explicit env values of the
   rendered workloads only (other fields are not inspected).
   - Flagged patterns:
     * Literal credentials in curl: `curl -u user:pass` or `curl --user user:pass`
       where the password portion is a literal value rather than a variable reference.
     * Authorization headers with literal tokens: `Authorization: Bearer <literal>` or
       `Authorization: Basic <literal>` in command flags or header literals.
     * Command variable assignments with literal secrets: `PASSWORD="literal"`,
       `ADMIN_KEY="literal"`, etc.
     * Dictionary literals with hardcoded passwords: `{"password": "literal"}`,
       `{"client_secret": "literal"}`, etc.
     * CLI flags with hardcoded credentials: `--password="literal"`,
       `--admin-password="literal"`, `--client-secret="literal"`.
     * URI userinfo embedding literal credentials: `scheme://user:literal_pass@host`
       in commands, args, or env values.
     * Explicit hardcoded bootstrap placeholders such as `SET-AT-BOOTSTRAP`.
   - Clean / safe references (never flagged):
     * Environment variables sourced from `secretKeyRef` or `valueFrom` (never flagged).
     * Variable references in commands or env values: `$(VAR)`, `$VAR`, `${VAR}`.
     * Python runtime environment lookups: `os.environ[...]`.
     * Filesystem secret mount paths: `/etc/secrets/...`, `/sql/...`.
   - Detection boundary: Detection is static and pattern-based. Dynamic payload generation
     or runtime variable assembly is out of scope.

3. Baseline Ratchet Gate:
   - Any new or undocumented violation fails closed.
   - Any baselined violation that disappears fails closed as a stale baseline entry
     (the ratchet only tightens; resolved items must be removed).
   - Baseline entries must be in the frozen FROZEN_BASELINE_IDS ceiling (D-1).

4. Built-in negative self-tests run on every invocation to verify fail-closed detection.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "identity-bootstrap-baseline.yaml"
CHARTS = ("beluga-platform", "beluga-data")
WORKLOAD_KINDS = frozenset({"Job", "Pod", "Deployment", "StatefulSet", "DaemonSet", "CronJob"})

# D-1: Baseline ratchet ceiling (matching check-networkpolicy-coverage.py).
# The YAML baseline may only contain IDs from this frozen set; growing the
# baseline beyond this ceiling requires an explicit code edit to this script.
FROZEN_BASELINE_IDS = frozenset({
    "Job/iam/keycloak-clients",
    "Job/iam/keycloak-group-mapper",
    "Job/iam/keycloak-ldap-federation",
    "Job/iam/keycloak-role-migration",
    "Job/iam/keycloak-users",
})

# Detection regexes: grant_type bound to password in form body, dict literals, or tuple pairs
ROPC_BINDING_RE = re.compile(
    r"""(?ix)
    (?:
        # Key: grant_type with optional quotes
        ['"]?grant_type['"]?
        \s*
        # Separator: = or : or url-encoded %3D
        (?:[:=]|%3D)
        \s*
        # Optional quotes / quote-space-quote split between '=' and 'password'
        # e.g., 'password', "password", ' 'password', " "password", \n, etc.
        [\s'"]*
        password\b
    |
        # Tuple / pair literal in Python / JSON, e.g. ("grant_type", "password") or ['grant_type', 'password']
        (?:[\(\[]\s*['"]grant_type['"]\s*,\s*['"]password['"]\s*[\)\]])
    )
    """
)

# curl -u / --user with user:password literal credentials
CURL_USER_RE = re.compile(
    r"""(?:curl\b[^\n]*\s(?:-u|--user)\s+|(?:\b(?:-u\b|--user\b)\s*=?\s*))([\"']?)(?:([^'\"\s:]*):)([^'\"\s]+)\1""",
)

# Authorization header with literal token
CMD_AUTH_HEADER_RE = re.compile(
    r"""['"]?Authorization['"]?\s*:\s*['"]?(?:Bearer|Basic)\s+([^\s'"]+)""",
    re.IGNORECASE,
)

SECRET_ENV_PATTERNS = re.compile(
    r"(?:PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|AUTH_TOKEN|_KEY\b|_PASS\b)",
    re.IGNORECASE,
)
NON_SECRET_ENV_PATTERNS = re.compile(
    r"(?:PUBLIC_KEY|KEY_CONVERTER|_FILE|_PATH|_ENABLED?)\b",
    re.IGNORECASE,
)
VAR_REF_PATTERN = re.compile(r"^\$\([A-Za-z0-9_]+\)$|^\$[A-Za-z0-9_]+$|^\$\{[A-Za-z0-9_]+\}$")
URI_CREDENTIAL_PATTERN = re.compile(r"://[^:\s/]+:([^@\s/]+)@")

CMD_SECRET_ASSIGN_RE = re.compile(
    r"^\s*(?:[A-Za-z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|ADMIN_KEY|ACCESS_KEY))\s*=\s*([\"'])(.+?)\1",
    re.MULTILINE,
)
CMD_DICT_PASSWORD_RE = re.compile(
    r"[\"'](?:password|client_?secret|bindCredential)[\"']\s*:\s*([\"'])(.+?)\1",
    re.IGNORECASE,
)
CMD_FLAG_SECRET_RE = re.compile(
    r"--(?:(?:admin-)?password|client-secret)\s*=\s*([\"']?)(.+?)\1(?:\s|$)",
    re.IGNORECASE,
)


def documents(manifest_text: str) -> list[dict[str, Any]]:
    """Parse `helm template` stdout into a flat list of resource mappings."""
    result: list[dict[str, Any]] = []

    def add(resource: Any) -> None:
        if not isinstance(resource, dict):
            raise ValueError("rendered document must be a resource mapping")
        if resource.get("kind") == "List":
            for item in resource.get("items", []):
                add(item)
            return
        result.append(resource)

    for doc in yaml.safe_load_all(manifest_text):
        if doc is not None:
            add(doc)
    return result


def load_baseline(path: Path) -> dict[str, dict[str, Any]]:
    """Load and validate the YAML baseline file schema."""
    if not path.is_file():
        raise ValueError(f"baseline file not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    items = data.get("items")
    if not isinstance(items, list):
        raise ValueError(f"{path.name}: top-level 'items' must be a list")

    baseline: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError(f"{path.name}: each baseline item must be a mapping")
        item_id = item.get("id")
        reason = item.get("reason")
        issue = item.get("issue")
        violation = item.get("violation")

        if not isinstance(item_id, str) or not item_id.strip():
            raise ValueError(f"{path.name}: baseline item missing non-empty 'id'")
        if item_id in baseline:
            raise ValueError(f"{path.name}: duplicate baseline item '{item_id}'")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"{path.name}: baseline item '{item_id}' missing non-empty 'reason'")
        if not isinstance(issue, int) or isinstance(issue, bool) or issue <= 0:
            raise ValueError(f"{path.name}: baseline item '{item_id}' missing positive integer 'issue'")
        if violation not in ("ropc", "inline-secret"):
            raise ValueError(
                f"{path.name}: baseline item '{item_id}' invalid violation '{violation}' "
                "(must be 'ropc' or 'inline-secret')"
            )
        baseline[item_id] = item
    return baseline


def check_ropc_tokens(tokens: list[str]) -> bool:
    """Detect split-arg grant_type=password across adjacent CLI arguments."""
    for i in range(len(tokens) - 1):
        t1 = tokens[i].strip("'\"")
        t2 = tokens[i + 1].strip("'\"")
        if (
            (t1.lower() == "grant_type=" and t2.lower() == "password")
            or (t1.lower() == "grant_type" and t2.lower() == "=password")
            or (t1.lower() == "grant_type:" and t2.lower() == "password")
        ):
            return True
        if i + 2 < len(tokens):
            t3 = tokens[i + 2].strip("'\"")
            if t1.lower() == "grant_type" and t2 in ("=", ":") and t3.lower() == "password":
                return True
            if (
                t1.lower() in ("-d", "--data", "--data-urlencode", "--data-raw")
                and t2.lower().rstrip("=") == "grant_type"
                and t3.lower().lstrip("=") == "password"
            ):
                return True
    return False


def evaluate_container(container: dict[str, Any]) -> list[tuple[str, str]]:
    """Scan container command, args, and env for ROPC and inline secret interpolation."""
    cname = container.get("name", "<unnamed>")
    violations: list[tuple[str, str]] = []

    cmd = container.get("command") or []
    args = container.get("args") or []
    cmd_list = cmd if isinstance(cmd, list) else [str(cmd)]
    args_list = args if isinstance(args, list) else [str(args)]
    tokens = cmd_list + args_list
    text = "\n".join(tokens)

    # 1. ROPC detection in command/args
    # Detects grant_type bound to password in any form (form body, split args, dict/tuple literals).
    # A job with grant_type client_credentials is NOT flagged even if passwords appear elsewhere.
    if ROPC_BINDING_RE.search(text) or check_ropc_tokens(tokens):
        violations.append(("ropc", f"container '{cname}': command/args contains grant_type=password (ROPC)"))

    # 2. Inline secret interpolation in command/args
    if "SET-AT-BOOTSTRAP" in text:
        violations.append(
            ("inline-secret", f"container '{cname}': command/args contains literal placeholder 'SET-AT-BOOTSTRAP'")
        )

    for m_u in CURL_USER_RE.finditer(text):
        pwd = m_u.group(3).strip()
        if not (
            pwd.startswith("$")
            or pwd.startswith("%s")
            or pwd.startswith("os.")
            or (pwd.startswith("{") and pwd.endswith("}"))
            or pwd.startswith("__")
        ):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args uses curl -u with literal secret: {m_u.group(0).strip()}")
            )

    for m_auth in CMD_AUTH_HEADER_RE.finditer(text):
        token_val = m_auth.group(1).strip()
        if token_val and not (
            token_val.startswith("$")
            or token_val.startswith("%s")
            or token_val.startswith("os.")
            or (token_val.startswith("{") and token_val.endswith("}"))
            or token_val.startswith('"')
            or token_val.startswith("'")
            or token_val.startswith("__")
        ):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args contains Authorization header with literal token: {m_auth.group(0).strip()}")
            )

    for uri_m in URI_CREDENTIAL_PATTERN.finditer(text):
        pwd_part = uri_m.group(1).strip()
        if pwd_part and not (
            pwd_part.startswith("$")
            or pwd_part.startswith("%s")
            or pwd_part.startswith("os.")
            or (pwd_part.startswith("{") and pwd_part.endswith("}"))
            or VAR_REF_PATTERN.match(pwd_part)
        ):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args URI embeds literal secret instead of $(VAR) ref")
            )

    for match in CMD_SECRET_ASSIGN_RE.finditer(text):
        val = match.group(2).strip()
        if not (
            val.startswith("$")
            or val.startswith("os.")
            or val.startswith("__")
            or val == "%s"
            or val.startswith("/")
        ):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args assigns literal secret value: {match.group(0).strip()}")
            )

    for match in CMD_DICT_PASSWORD_RE.finditer(text):
        val = match.group(2).strip()
        if not (
            val.startswith("$")
            or val.startswith("os.")
            or val.startswith("__")
            or val == "%s"
            or val == ""
        ):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args contains literal secret key-value: {match.group(0).strip()}")
            )

    for match in CMD_FLAG_SECRET_RE.finditer(text):
        val = match.group(2).strip()
        if not (val.startswith("$") or val.startswith("/")):
            violations.append(
                ("inline-secret", f"container '{cname}': command/args contains literal secret flag: {match.group(0).strip()}")
            )

    # 3. Env variables inspection
    # env values from secretKeyRef / valueFrom are safe references and never flagged.
    for env_item in container.get("env") or []:
        if not isinstance(env_item, dict):
            continue
        if "valueFrom" in env_item:
            # Sourced from secretKeyRef, configMapKeyRef, etc. Never flagged.
            continue
        ename = str(env_item.get("name") or "")
        val = env_item.get("value")

        if val is not None:
            sval = str(val)
            if ROPC_BINDING_RE.search(sval):
                violations.append(("ropc", f"container '{cname}': env '{ename}' value contains grant_type=password (ROPC)"))
            if "SET-AT-BOOTSTRAP" in sval:
                violations.append(
                    ("inline-secret", f"container '{cname}': env '{ename}' value contains literal placeholder 'SET-AT-BOOTSTRAP'")
                )
            if SECRET_ENV_PATTERNS.search(ename) and not NON_SECRET_ENV_PATTERNS.search(ename):
                if sval and not VAR_REF_PATTERN.match(sval) and not sval.startswith("/"):
                    violations.append(
                        ("inline-secret", f"container '{cname}': env '{ename}' has literal secret value instead of secretKeyRef")
                    )
            uri_m = URI_CREDENTIAL_PATTERN.search(sval)
            if uri_m:
                pwd_part = uri_m.group(1).strip()
                if pwd_part and not VAR_REF_PATTERN.match(pwd_part) and not pwd_part.startswith("$"):
                    violations.append(
                        ("inline-secret", f"container '{cname}': env '{ename}' URI embeds literal secret instead of $(VAR) ref")
                    )

    return violations


def evaluate_resource(resource: dict[str, Any]) -> list[tuple[str, str]]:
    """Extract Pod spec from workload resource and evaluate all containers."""
    kind = resource.get("kind")
    if kind not in WORKLOAD_KINDS:
        return []

    spec = resource.get("spec") or {}
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "Job"):
        pod_spec = (spec.get("template") or {}).get("spec") or {}
    elif kind == "CronJob":
        pod_spec = (((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}).get("spec") or {}
    elif kind == "Pod":
        pod_spec = spec
    else:
        return []

    violations: list[tuple[str, str]] = []
    containers = (pod_spec.get("containers") or []) + (pod_spec.get("initContainers") or [])
    for container in containers:
        if isinstance(container, dict):
            violations.extend(evaluate_container(container))
    return violations


def check_manifests(
    combos: list[tuple[str, list[dict[str, Any]]]],
    baseline: dict[str, dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    """Evaluate all rendered resources against the baseline ratchet."""
    errors: list[str] = []
    active_violations: dict[str, dict[str, list[str]]] = {}

    for label, resources in combos:
        for res in resources:
            vlist = evaluate_resource(res)
            if not vlist:
                continue
            meta = res.get("metadata") or {}
            res_id = f"{res.get('kind')}/{meta.get('namespace', 'default')}/{meta.get('name')}"
            entry = active_violations.setdefault(res_id, {})
            for vtype, detail in vlist:
                entry.setdefault(vtype, []).append(f"[{label}] {detail}")

    # Check active violations against baseline
    for res_id, vtypes in active_violations.items():
        if res_id not in baseline:
            details_str = "; ".join(f"{vt}: {', '.join(details)}" for vt, details in vtypes.items())
            errors.append(f"unbaselined violation in '{res_id}': {details_str} - not listed in {BASELINE_PATH.name}")
        else:
            expected_vt = baseline[res_id]["violation"]
            if expected_vt not in vtypes:
                errors.append(
                    f"baseline type mismatch for '{res_id}': baseline specifies '{expected_vt}', "
                    f"but active violations are {list(vtypes.keys())}"
                )
            for vt, details in vtypes.items():
                if vt != expected_vt:
                    errors.append(
                        f"unbaselined additional violation in '{res_id}': unexpected violation '{vt}' "
                        f"({details}) not permitted by baseline (baseline only permits '{expected_vt}')"
                    )

    # Check for stale baseline entries (ratchet tightens)
    for b_id in sorted(baseline):
        if b_id not in active_violations:
            errors.append(
                f"stale baseline entry '{b_id}': resource no longer has violations; "
                f"remove it from {BASELINE_PATH.name} (ratchet only tightens)"
            )
        elif b_id not in FROZEN_BASELINE_IDS:
            errors.append(
                f"item '{b_id}' is in {BASELINE_PATH.name} but not in the frozen "
                f"FROZEN_BASELINE_IDS ceiling in {Path(__file__).name} (D-1)"
            )

    report = {
        "active_violations": active_violations,
        "baselined": sorted(baseline.keys()),
    }
    return errors, report


def _resource(kind: str, namespace: str, name: str, spec: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "apiVersion": "batch/v1" if kind == "Job" else "v1",
        "kind": kind,
        "metadata": {"name": name, "namespace": namespace},
        "spec": spec or {},
    }


def _job(name: str, namespace: str, container_spec: dict[str, Any]) -> dict[str, Any]:
    return _resource(
        "Job",
        namespace,
        name,
        {
            "template": {
                "spec": {
                    "containers": [container_spec],
                }
            }
        },
    )


def self_test() -> None:
    """Built-in positive and negative fixtures verifying fail-closed detection."""
    # 1. Compliant job using secretKeyRef and variable references
    job_compliant = _job(
        "keycloak-setup",
        "iam",
        {
            "name": "setup",
            "env": [
                {
                    "name": "KEYCLOAK_ADMIN_PASSWORD",
                    "valueFrom": {"secretKeyRef": {"name": "keycloak-admin-credential", "key": "password"}},
                },
                {
                    "name": "DB_URL",
                    "value": "postgresql://user:$(KEYCLOAK_ADMIN_PASSWORD)@postgres:5432/db",
                },
            ],
            "command": ["python3", "-c", 'import os\npwd = os.environ["KEYCLOAK_ADMIN_PASSWORD"]\nprint("ok")\n'],
        },
    )

    # 2. Baselined ROPC job
    job_ropc = _job(
        "keycloak-clients",
        "iam",
        {
            "name": "clients",
            "env": [
                {
                    "name": "KEYCLOAK_ADMIN_PASSWORD",
                    "valueFrom": {"secretKeyRef": {"name": "keycloak-admin-credential", "key": "password"}},
                }
            ],
            "command": [
                "python3",
                "-c",
                'token_data = {"grant_type": "password", "client_id": "admin-cli"}\n',
            ],
        },
    )

    # 3. New / undocumented ROPC job
    job_new_ropc = _job(
        "keycloak-new-bootstrap",
        "iam",
        {
            "name": "bootstrap",
            "command": ["/bin/sh", "-c", "curl -d 'grant_type=password' https://keycloak/protocol/openid-connect/token"],
        },
    )

    # 4. Job with literal secret env value
    job_literal_env = _job(
        "keycloak-bad-env",
        "iam",
        {
            "name": "bad-env",
            "env": [{"name": "KEYCLOAK_ADMIN_PASSWORD", "value": "hardcoded_secret_123"}],
        },
    )

    # 5. Job with literal secret in command assignment
    job_literal_cmd_assign = _job(
        "keycloak-bad-cmd",
        "iam",
        {
            "name": "bad-cmd",
            "command": ["python3", "-c", 'ADMIN_PASS = "literal_admin_password"\n'],
        },
    )

    # 6. Job with literal password in dict key-value
    job_literal_dict = _job(
        "keycloak-bad-dict",
        "iam",
        {
            "name": "bad-dict",
            "command": ["python3", "-c", 'payload = {"username": "admin", "password": "hardcoded_password"}\n'],
        },
    )

    # 7. Job with SET-AT-BOOTSTRAP placeholder
    job_placeholder = _job(
        "keycloak-placeholder",
        "iam",
        {
            "name": "placeholder",
            "env": [{"name": "ADMIN_PASSWORD", "value": "SET-AT-BOOTSTRAP"}],
        },
    )

    # Case 1: Compliant + Baselined ROPC passes with exact baseline
    baseline_exact = {
        "Job/iam/keycloak-clients": {
            "id": "Job/iam/keycloak-clients",
            "violation": "ropc",
            "reason": "OIDC client secret sync",
            "issue": 3,
        }
    }
    combos_valid = [("default", [job_compliant, job_ropc])]
    errors, report = check_manifests(combos_valid, baseline_exact)
    if errors:
        raise ValueError(f"self-test valid baseline unexpectedly failed: {errors}")
    if report["baselined"] != ["Job/iam/keycloak-clients"]:
        raise ValueError(f"self-test report mismatch: {report}")

    # Case 2: Undocumented ROPC must fail closed
    combos_unbaselined_ropc = [("default", [job_compliant, job_new_ropc])]
    errors, _ = check_manifests(combos_unbaselined_ropc, {})
    if not any("unbaselined violation" in err and "keycloak-new-bootstrap" in err for err in errors):
        raise ValueError(f"self-test unbaselined ROPC did not fail as expected: {errors}")

    # Case 3: Stale baseline entry must fail closed (ratchet tightens)
    combos_stale = [("default", [job_compliant])]
    errors, _ = check_manifests(combos_stale, baseline_exact)
    if not any("stale baseline entry" in err and "keycloak-clients" in err for err in errors):
        raise ValueError(f"self-test stale baseline entry did not fail as expected: {errors}")

    # Case 4: Literal secret in env must fail closed
    combos_literal_env = [("default", [job_literal_env])]
    errors, _ = check_manifests(combos_literal_env, {})
    if not any("inline-secret" in err and "literal secret value" in err for err in errors):
        raise ValueError(f"self-test literal env secret did not fail as expected: {errors}")

    # Case 5: Literal secret assignment in script must fail closed
    combos_literal_cmd = [("default", [job_literal_cmd_assign])]
    errors, _ = check_manifests(combos_literal_cmd, {})
    if not any("inline-secret" in err and "assigns literal secret value" in err for err in errors):
        raise ValueError(f"self-test literal command assignment did not fail as expected: {errors}")

    # Case 6: Literal password in dict must fail closed
    combos_literal_dict = [("default", [job_literal_dict])]
    errors, _ = check_manifests(combos_literal_dict, {})
    if not any("inline-secret" in err and "literal secret key-value" in err for err in errors):
        raise ValueError(f"self-test literal dict password did not fail as expected: {errors}")

    # Case 7: SET-AT-BOOTSTRAP placeholder must fail closed
    combos_placeholder = [("default", [job_placeholder])]
    errors, _ = check_manifests(combos_placeholder, {})
    if not any("SET-AT-BOOTSTRAP" in err for err in errors):
        raise ValueError(f"self-test SET-AT-BOOTSTRAP did not fail as expected: {errors}")

    # Case 8: Baselined resource introduces additional unbaselined violation (e.g. inline-secret) -> fails
    job_ropc_plus_inline = _job(
        "keycloak-clients",
        "iam",
        {
            "name": "clients",
            "env": [{"name": "ADMIN_PASSWORD", "value": "hardcoded123"}],
            "command": ["python3", "-c", 'token_data = {"grant_type": "password"}\n'],
        },
    )
    combos_multi_violation = [("default", [job_ropc_plus_inline])]
    errors, _ = check_manifests(combos_multi_violation, baseline_exact)
    if not any("unbaselined additional violation" in err for err in errors):
        raise ValueError(f"self-test additional violation on baselined resource did not fail: {errors}")

    # Case 9: Ratchet ceiling: entry in baseline YAML outside FROZEN_BASELINE_IDS must fail
    baseline_outside_ceiling = {
        "Job/iam/unauthorized-job": {
            "id": "Job/iam/unauthorized-job",
            "violation": "ropc",
            "reason": "bypass attempt",
            "issue": 3,
        }
    }
    job_unauthorized = _job(
        "unauthorized-job",
        "iam",
        {
            "name": "job",
            "command": ["python3", "-c", 'token_data = {"grant_type": "password"}\n'],
        },
    )
    combos_outside = [("default", [job_unauthorized])]
    errors, _ = check_manifests(combos_outside, baseline_outside_ceiling)
    if not any("ceiling" in err for err in errors):
        raise ValueError(f"self-test ratchet ceiling did not fail as expected: {errors}")

    # Case 10: Baseline schema validation
    with tempfile.TemporaryDirectory(prefix="beluga-identity-baseline-") as tmpdir:
        path = Path(tmpdir) / "identity-bootstrap-baseline.yaml"
        schema_cases = [
            ("items:\n  - id: Job/iam/kc\n    issue: 3\n", "non-empty 'reason'"),
            ("items:\n  - id: Job/iam/kc\n    reason: x\n", "positive integer 'issue'"),
            ("items:\n  - id: Job/iam/kc\n    reason: x\n    issue: 0\n", "positive integer 'issue'"),
            ("items:\n  - id: Job/iam/kc\n    reason: x\n    issue: 3\n    violation: invalid\n", "invalid violation"),
            ("items:\n  - reason: x\n    issue: 3\n    violation: ropc\n", "non-empty 'id'"),
            (
                "items:\n  - id: Job/iam/kc\n    reason: x\n    issue: 3\n    violation: ropc\n"
                "  - id: Job/iam/kc\n    reason: y\n    issue: 3\n    violation: ropc\n",
                "duplicate baseline item",
            ),
            ("items: not-a-list\n", "must be a list"),
        ]
        for content, expected_diagnostic in schema_cases:
            path.write_text(content, encoding="utf-8")
            try:
                load_baseline(path)
            except ValueError as error:
                if expected_diagnostic not in str(error):
                    raise ValueError(f"self-test schema case unexpected error message: {error}") from error
            else:
                raise ValueError(f"self-test schema case unexpectedly accepted: {content!r}")

    # Case 11: Formerly-ROPC workload switched to client_credentials (a)
    # Remediated workload must NOT be flagged even if it mentions passwords elsewhere;
    # its baseline entry must be reported stale (ratchet only tightens).
    job_remediated_users = _job(
        "keycloak-users",
        "iam",
        {
            "name": "keycloak-users",
            "env": [
                {
                    "name": "KEYCLOAK_ADMIN_PASSWORD",
                    "valueFrom": {"secretKeyRef": {"name": "keycloak-admin-credential", "key": "password"}},
                },
                {
                    "name": "USER_PASSWORD_ADMIN",
                    "valueFrom": {"secretKeyRef": {"name": "keycloak-user-passwords", "key": "admin"}},
                },
            ],
            "command": [
                "python3",
                "-c",
                (
                    "import os, urllib.parse\n"
                    "token_data = urllib.parse.urlencode({\n"
                    '    "client_id": "admin-cli",\n'
                    '    "grant_type": "client_credentials",\n'
                    '    "client_secret": os.environ["KEYCLOAK_ADMIN_PASSWORD"],\n'
                    "})\n"
                    "USERS = [{'username': 'beluga-admin', 'password': os.environ['USER_PASSWORD_ADMIN']}]\n"
                ),
            ],
        },
    )
    # Alone against empty baseline: clean (0 violations)
    errors, _ = check_manifests([("default", [job_remediated_users])], {})
    if errors:
        raise ValueError(f"self-test remediated client_credentials unexpectedly flagged violations: {errors}")

    # Against baseline expecting ROPC on keycloak-users: reported stale
    baseline_kc_users = {
        "Job/iam/keycloak-users": {
            "id": "Job/iam/keycloak-users",
            "violation": "ropc",
            "reason": "formerly ROPC",
            "issue": 3,
        }
    }
    errors, _ = check_manifests([("default", [job_remediated_users])], baseline_kc_users)
    if not any("stale baseline entry" in err and "keycloak-users" in err for err in errors):
        raise ValueError(f"self-test remediated workload did not report stale baseline entry: {errors}")

    # Case 12: Split-arg grant body => violation (b)
    job_split_arg = _job(
        "keycloak-split-grant",
        "iam",
        {
            "name": "split-grant",
            "command": [
                "curl",
                "-X",
                "POST",
                "https://keycloak.iam.svc.cluster.local:8080/realms/master/protocol/openid-connect/token",
                "-d",
                "grant_type=",
                "password",
            ],
        },
    )
    errors, _ = check_manifests([("default", [job_split_arg])], {})
    if not any("unbaselined violation" in err and "grant_type=password" in err for err in errors):
        raise ValueError(f"self-test split-arg grant body did not fail as expected: {errors}")

    job_split_quotes = _job(
        "keycloak-split-quotes",
        "iam",
        {
            "name": "split-quotes",
            "command": [
                "/bin/sh",
                "-c",
                "curl -d 'grant_type=' 'password' https://keycloak/protocol/openid-connect/token",
            ],
        },
    )
    errors, _ = check_manifests([("default", [job_split_quotes])], {})
    if not any("unbaselined violation" in err and "grant_type=password" in err for err in errors):
        raise ValueError(f"self-test split-quotes grant body did not fail as expected: {errors}")

    # Case 13: curl -u literal => inline-secret violation (c)
    job_curl_u_literal = _job(
        "keycloak-curl-literal",
        "iam",
        {
            "name": "curl-literal",
            "command": [
                "curl",
                "-u",
                "admin:hardcoded_secret_password",
                "https://keycloak.iam.svc.cluster.local:8080/admin/realms",
            ],
        },
    )
    errors, _ = check_manifests([("default", [job_curl_u_literal])], {})
    if not any("inline-secret" in err and "curl -u" in err for err in errors):
        raise ValueError(f"self-test curl -u literal did not fail as expected: {errors}")

    # Case 14: secretKeyRef env => clean (d)
    job_secretkeyref_clean = _job(
        "keycloak-secretkeyref-clean",
        "iam",
        {
            "name": "clean-env",
            "env": [
                {
                    "name": "KEYCLOAK_ADMIN_PASSWORD",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": "keycloak-admin-credential",
                            "key": "password",
                        }
                    },
                },
                {
                    "name": "LDAP_BIND_CREDENTIAL",
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": "openldap-credentials",
                            "key": "bindPassword",
                        }
                    },
                },
            ],
            "command": ["python3", "-c", "import os; print('clean')"],
        },
    )
    errors, _ = check_manifests([("default", [job_secretkeyref_clean])], {})
    if errors:
        raise ValueError(f"self-test secretKeyRef env unexpectedly reported violations: {errors}")

    print("Identity bootstrap ROPC self-tests OK: fixtures accepted/rejected as expected.", file=sys.stderr)


DEPLOYED_COMBOS: list[tuple[str, list[str]]] = [
    ("beluga-platform", []),
    ("beluga-data", []),
    ("beluga-data", ["--set", "trino.workerEnabled=true,openmetadata.enabled=true"]),
]


def render_combo(chart: str, extra_args: list[str]) -> list[dict[str, Any]]:
    cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart), *extra_args]
    env = {**os.environ, "KUBECONFIG": os.devnull}
    result = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
    return documents(result.stdout)


def main() -> int:
    try:
        self_test()
    except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
        print(f"Identity bootstrap ROPC self-test FAIL: {error}", file=sys.stderr)
        return 1

    if "--self-test" in sys.argv:
        print("Self-test mode: all checks passed.")
        return 0

    try:
        baseline = load_baseline(BASELINE_PATH)
        combos = [(f"{chart} {' '.join(args)}".strip(), render_combo(chart, args)) for chart, args in DEPLOYED_COMBOS]
        errors, report = check_manifests(combos, baseline)
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (OSError, ValueError, yaml.YAMLError) as exc:
        print(f"FAIL: identity bootstrap check: {exc}", file=sys.stderr)
        return 1

    print("=== Identity bootstrap ROPC and inline secret ratchet (Issue #3) ===")
    print(f"Baselined known ROPC identity bootstrap workloads ({len(report['baselined'])}):")
    for b_id in report["baselined"]:
        entry = baseline[b_id]
        print(f"  - {b_id}: {entry['reason']} (issue #{entry['issue']})")

    if errors:
        print()
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print("\nOK: identity bootstrap workloads match baseline; no unbaselined ROPC or inline secrets.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
