#!/usr/bin/env python3
"""Static render contract for the Beluga Manager GitHub writer wiring (ADR-0009 rollout 4, D-MSSO-15/16).

Asserts on the rendered beluga-platform chart (default domain and Kakao overlay):
1. ServiceAccount platform-system/manager-domain-api; the Deployment uses it and keeps
   automountServiceAccountToken false (the token only arrives through the projected kube-api volume).
2. Role argocd/manager-argocd-app-reader grants exactly get on argoproj.io applications
   restricted to resourceNames [beluga-platform, beluga-data]; no wildcard, no other rule; the
   RoleBinding binds it to the ServiceAccount only. No Role in platform-system grants Secret access.
3. GitHub App wiring: ids from Secret manager-github-app (optional secretKeyRef), key as a file from an
   optional Secret volume that projects only private-key.pem with mode 0400; KUBE_API_* env and the
   projected serviceAccountToken + kube-root-ca.crt volume; SSO_RECONCILE_INTERVAL_MS stays unset.
4. No literal key material or token in the rendered chart.
Built-in negative self-tests prove the checks fail closed.
"""
from __future__ import annotations

import copy
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CHART = REPO_ROOT / "gitops" / "charts" / "beluga-platform"
SSO_VALUES = REPO_ROOT / "gitops" / "values" / "sso.yaml"
KAKAO_DOMAIN = REPO_ROOT / "gitops" / "values" / "domain-kakao.yaml"
NS = "platform-system"
SA = "manager-domain-api"
ROLE = "manager-argocd-app-reader"
APPS = ["beluga-platform", "beluga-data"]

RENDERS: list[tuple[str, list[str]]] = [
    ("default", ["-f", str(SSO_VALUES)]),
    ("kakao", ["-f", str(CHART / "values.yaml"), "-f", str(CHART / "values-kakao.yaml"),
               "-f", str(SSO_VALUES), "-f", str(KAKAO_DOMAIN)]),
]

EXPECTED_ENV: dict[str, str] = {
    "GITHUB_APP_PRIVATE_KEY_FILE": "/var/run/secrets/github-app/private-key.pem",
    "KUBE_API_URL": "https://kubernetes.default.svc",
    "KUBE_API_TOKEN_FILE": "/var/run/secrets/kube-api/token",
    "KUBE_API_CA_FILE": "/var/run/secrets/kube-api/ca.crt",
}
EXPECTED_SECRET_ENV = {"GITHUB_APP_ID": "app-id", "GITHUB_APP_INSTALLATION_ID": "installation-id"}
FORBIDDEN_MARKERS = ("BEGIN RSA PRIVATE KEY", "BEGIN PRIVATE KEY", "BEGIN OPENSSH PRIVATE KEY", "ghs_", "github_pat_")


def render(extra: list[str]) -> list[dict[str, Any]]:
    out = subprocess.run(["helm", "template", str(CHART), *extra], check=True,
                         capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(out) if isinstance(d, dict)]


def find(docs: list[dict[str, Any]], kind: str, name: str, ns: str = NS) -> dict[str, Any]:
    for d in docs:
        meta = d.get("metadata", {})
        if d.get("kind") == kind and meta.get("name") == name and meta.get("namespace") == ns:
            return d
    raise ValueError(f"{kind} {ns}/{name} not rendered")


def check(docs: list[dict[str, Any]]) -> None:
    sa = find(docs, "ServiceAccount", SA)
    if sa.get("automountServiceAccountToken") is not False:
        raise ValueError("ServiceAccount manager-domain-api must set automountServiceAccountToken: false")

    dep = find(docs, "Deployment", "manager-domain-api")
    pod = dep["spec"]["template"]["spec"]
    if pod.get("serviceAccountName") != SA:
        raise ValueError(f"Deployment manager-domain-api must use serviceAccountName {SA}")
    if pod.get("automountServiceAccountToken") is not False:
        raise ValueError("Deployment manager-domain-api must keep automountServiceAccountToken: false (D-MSSO-16)")

    role = find(docs, "Role", ROLE, "argocd")
    rules = role.get("rules") or []
    if len(rules) != 1:
        raise ValueError(f"Role {ROLE} must have exactly one rule, got {len(rules)}")
    rule = rules[0]
    if rule.get("apiGroups") != ["argoproj.io"] or rule.get("resources") != ["applications"] \
            or rule.get("verbs") != ["get"] or sorted(rule.get("resourceNames") or []) != sorted(APPS):
        raise ValueError(f"Role {ROLE} must grant exactly get on argoproj.io applications named {APPS}, got {rule!r}")
    if any("*" in str(rule.get(k)) for k in rule):
        raise ValueError(f"Role {ROLE} must not use wildcards")

    rb = find(docs, "RoleBinding", ROLE, "argocd")
    subjects = rb.get("subjects") or []
    if rb.get("roleRef", {}).get("kind") != "Role" or rb["roleRef"].get("name") != ROLE \
            or len(subjects) != 1 or subjects[0].get("kind") != "ServiceAccount" \
            or subjects[0].get("name") != SA or subjects[0].get("namespace") != NS:
        raise ValueError(f"RoleBinding {ROLE} must bind Role {ROLE} to ServiceAccount {NS}/{SA} only")

    # D-MSSO-15: the key reaches the Pod through kubelet, so no Role in platform-system may grant Secret access.
    for d in docs:
        if d.get("kind") == "Role" and d.get("metadata", {}).get("namespace") == NS:
            for r in d.get("rules") or []:
                if "secrets" in (r.get("resources") or []) or "*" in (r.get("resources") or []):
                    raise ValueError(f"{d['kind']} {d['metadata']['name']} must not grant access to Secrets (D-MSSO-15)")

    container = pod["containers"][0]
    env = {e["name"]: e for e in container.get("env", [])}
    for k, v in EXPECTED_ENV.items():
        if env.get(k, {}).get("value") != v:
            raise ValueError(f"domain-api env {k} must be {v!r}, got {env.get(k)!r}")
    for k, key in EXPECTED_SECRET_ENV.items():
        ref = env.get(k, {}).get("valueFrom", {}).get("secretKeyRef", {})
        if ref.get("name") != "manager-github-app" or ref.get("key") != key or ref.get("optional") is not True \
                or "value" in env[k]:
            raise ValueError(f"domain-api env {k} must be an optional secretKeyRef manager-github-app/{key}")
    if "SSO_RECONCILE_INTERVAL_MS" in env:
        raise ValueError("SSO_RECONCILE_INTERVAL_MS must stay unset (code default, D-MSSO-18)")

    vols = {v["name"]: v for v in pod.get("volumes", [])}
    key_vol = vols.get("github-app", {}).get("secret", {})
    items = [(i.get("key"), i.get("path")) for i in key_vol.get("items") or []]
    if key_vol.get("secretName") != "manager-github-app" or key_vol.get("optional") is not True \
            or items != [("private-key.pem", "private-key.pem")] or key_vol.get("defaultMode") != 0o400:
        raise ValueError("volume github-app must be Secret manager-github-app, optional, items only private-key.pem, mode 0400")
    mounts = {m["name"]: m for m in container.get("volumeMounts", [])}
    if mounts.get("github-app", {}).get("mountPath") != "/var/run/secrets/github-app" \
            or mounts["github-app"].get("readOnly") is not True:
        raise ValueError("volumeMount github-app must be read-only at /var/run/secrets/github-app")
    if mounts.get("kube-api", {}).get("mountPath") != "/var/run/secrets/kube-api" \
            or mounts["kube-api"].get("readOnly") is not True:
        raise ValueError("volumeMount kube-api must be read-only at /var/run/secrets/kube-api")

    sources = vols.get("kube-api", {}).get("projected", {}).get("sources", [])
    tokens = [s["serviceAccountToken"] for s in sources if "serviceAccountToken" in s]
    cms = [s["configMap"] for s in sources if "configMap" in s]
    if len(sources) != 2 or len(tokens) != 1 or tokens[0].get("path") != "token" \
            or not 600 <= int(tokens[0].get("expirationSeconds", 0)) <= 3600 or "audience" in tokens[0]:
        raise ValueError("volume kube-api must project one serviceAccountToken (path token, expirationSeconds 600-3600, default audience)")
    if len(cms) != 1 or cms[0].get("name") != "kube-root-ca.crt" \
            or [(i["key"], i["path"]) for i in cms[0].get("items") or []] != [("ca.crt", "ca.crt")]:
        raise ValueError("volume kube-api must project only ca.crt of ConfigMap kube-root-ca.crt")

    # No other workload may gain the ServiceAccount token or use the Role's ServiceAccount.
    for d in docs:
        if d.get("kind") != "Deployment":
            continue
        p = d["spec"]["template"]["spec"]
        if d["metadata"]["name"] != "manager-domain-api" and p.get("serviceAccountName") == SA:
            raise ValueError(f"Deployment {d['metadata']['name']} must not use ServiceAccount {SA}")

    text = yaml.safe_dump(docs)
    for marker in FORBIDDEN_MARKERS:
        if marker in text:
            raise ValueError(f"rendered chart contains key/token material marker {marker!r}")
    for d in docs:
        if d.get("kind") == "Secret" and d.get("metadata", {}).get("name") == "manager-github-app":
            raise ValueError("Secret manager-github-app must not be rendered (the owner creates it)")


def self_test(docs: list[dict[str, Any]]) -> None:
    def mutated(fn) -> list[dict[str, Any]]:
        c = copy.deepcopy(docs)
        fn(c)
        return c

    def pod(c):
        return find(c, "Deployment", "manager-domain-api")["spec"]["template"]["spec"]

    def rule(c):
        return find(c, "Role", ROLE, "argocd")["rules"][0]

    def vol(c, name):
        return next(v for v in pod(c)["volumes"] if v["name"] == name)

    def drop_sa_name(c):
        pod(c).pop("serviceAccountName")

    def automount_true(c):
        pod(c)["automountServiceAccountToken"] = True

    def sa_automount(c):
        find(c, "ServiceAccount", SA)["automountServiceAccountToken"] = True

    def add_list(c):
        rule(c)["verbs"] = ["get", "list"]

    def wildcard(c):
        rule(c)["resourceNames"] = ["*"]

    def third_app(c):
        rule(c)["resourceNames"].append("other-app")

    def no_names(c):
        rule(c).pop("resourceNames")

    def extra_rule(c):
        find(c, "Role", ROLE, "argocd")["rules"].append({"apiGroups": [""], "resources": ["secrets"], "verbs": ["get"]})

    def wrong_subject(c):
        find(c, "RoleBinding", ROLE, "argocd")["subjects"][0]["name"] = "default"

    def secret_role(c):
        c.append({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
                  "metadata": {"name": "x", "namespace": NS},
                  "rules": [{"apiGroups": [""], "resources": ["secrets"], "verbs": ["get"]}]})

    def required_secret(c):
        vol(c, "github-app")["secret"].pop("optional")

    def whole_secret(c):
        vol(c, "github-app")["secret"].pop("items")

    def extra_key(c):
        vol(c, "github-app")["secret"]["items"].append({"key": "app-id", "path": "app-id"})

    def loose_mode(c):
        vol(c, "github-app")["secret"]["defaultMode"] = 0o444

    def required_env(c):
        for e in pod(c)["containers"][0]["env"]:
            if e["name"] == "GITHUB_APP_ID":
                e["valueFrom"]["secretKeyRef"].pop("optional")

    def literal_env(c):
        for e in pod(c)["containers"][0]["env"]:
            if e["name"] == "GITHUB_APP_INSTALLATION_ID":
                e.pop("valueFrom")
                e["value"] = "12345"

    def bad_key_path(c):
        for e in pod(c)["containers"][0]["env"]:
            if e["name"] == "GITHUB_APP_PRIVATE_KEY_FILE":
                e["value"] = "/tmp/key.pem"

    def interval_set(c):
        pod(c)["containers"][0]["env"].append({"name": "SSO_RECONCILE_INTERVAL_MS", "value": "1000"})

    def drop_kube_env(c):
        pod(c)["containers"][0]["env"] = [e for e in pod(c)["containers"][0]["env"] if e["name"] != "KUBE_API_URL"]

    def long_token(c):
        next(s for s in vol(c, "kube-api")["projected"]["sources"] if "serviceAccountToken" in s)["serviceAccountToken"]["expirationSeconds"] = 86400

    def whole_cm(c):
        next(s for s in vol(c, "kube-api")["projected"]["sources"] if "configMap" in s)["configMap"].pop("items")

    def key_literal(c):
        find(c, "ConfigMap", "manager-web-config")["data"]["leak"] = "-----BEGIN PRIVATE KEY-----"

    def rendered_secret(c):
        c.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "manager-github-app", "namespace": NS}})

    for name, fn in (("missing serviceAccountName", drop_sa_name), ("pod automount true", automount_true),
                     ("SA automount true", sa_automount), ("list verb", add_list), ("wildcard resourceNames", wildcard),
                     ("third app", third_app), ("no resourceNames", no_names), ("extra secrets rule", extra_rule),
                     ("wrong subject", wrong_subject), ("Secret Role in platform-system", secret_role),
                     ("required key Secret volume", required_secret), ("whole Secret volume", whole_secret),
                     ("extra Secret key", extra_key), ("loose file mode", loose_mode), ("required secretKeyRef", required_env),
                     ("literal installation id", literal_env), ("wrong key path", bad_key_path),
                     ("interval env set", interval_set), ("missing KUBE_API_URL", drop_kube_env),
                     ("24h token", long_token), ("whole ConfigMap", whole_cm), ("key material literal", key_literal),
                     ("rendered Secret", rendered_secret)):
        try:
            check(mutated(fn))
        except ValueError:
            continue
        raise SystemExit(f"self-test failed: '{name}' mutation was not detected")


def main() -> int:
    for label, extra in RENDERS:
        docs = render(extra)
        try:
            check(docs)
        except ValueError as exc:
            print(f"FAIL [{label}]: {exc}", file=sys.stderr)
            return 1
        if label == "default":
            self_test(docs)
        print(f"PASS [{label}]: manager GitHub writer / ArgoCD reader render contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
