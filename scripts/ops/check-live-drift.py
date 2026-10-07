#!/usr/bin/env python3
"""Read-only live GitOps drift check (Issue #39, criteria 2/3/5 slice).

Compares the LIVE cluster against Git and classifies every finding as
`expected` | `tolerated` | `unauthorized`:

  sync      ArgoCD Application not Synced, or synced at a revision other than the expected
            one (default: local `origin/main`, which must equal `git ls-remote origin main`;
            there is NO fallback to HEAD; pass --expect-revision to name it explicitly).
  resource  a tracked resource is OutOfSync. `tolerated` when the app's own spec.ignoreDifferences
            matches it by kind/group/name/namespace (read from the app, never hardcoded; the rule's
            FIELDS are not compared, so the cause is not verified) or when ArgoCD reports no status
            for it (sync-hook Jobs, see docs/configuration-sources.md section 2.D); otherwise
            `unauthorized`.
  image     a live Deployment/StatefulSet/DaemonSet/CronJob container or initContainer image
            differs from the image rendered from the charts (default values), compared per
            container NAME and kind; a missing or extra container is a `container` finding.
  missing   a declared Application or declared workload is absent from the cluster.
  undeclared  a workload that is live AND Argo-tracked but absent from the chart render:
            its image cannot be checked, so it fails (unauthorized) rather than being skipped.
  health    Progressing/Degraded/... is reported separately: it is NOT drift, class `tolerated`.

Coverage: Applications, their tracked resources' sync status, and workload images. NOT
RBAC, NetworkPolicy, Service, ConfigMap/Secret contents. Live workloads that are neither
rendered from the repo charts nor Argo-tracked (operators, upstream manifests, add-ons) are
listed under `skipped`: a drifted image there is NOT detected.

READ-ONLY: the only cluster call is `kubectl get ... -o json` (enforced in kubectl_get).
Exit 0 = no unauthorized drift, 1 = unauthorized drift, 2 = cluster unreachable / unreadable
or malformed input / unverifiable expected revision (fail closed, never 1; `--skip-if-unreachable` turns an unreachable CLUSTER into exit 0).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKLOAD_KINDS = ("Deployment", "StatefulSet", "DaemonSet", "CronJob")
EXIT_OK, EXIT_DRIFT, EXIT_INPUT = 0, 1, 2


class InputError(Exception):
    """Unreadable input (exit 2)."""


class ClusterUnreachable(InputError):
    """Cluster unreachable (exit 2, or 0 with --skip-if-unreachable)."""


def finding(check: str, cls: str, subject: str, detail: str) -> dict:
    return {"check": check, "class": cls, "subject": subject, "detail": detail}


def kubectl_get(resources: str) -> dict:
    """The ONLY cluster access: `kubectl get <resources> -A -o json`. Never a mutating verb."""
    cmd = [os.environ.get("KUBECTL", "kubectl"), "get", resources, "-A", "-o", "json", "--request-timeout=30s"]
    assert cmd[1] == "get"
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ClusterUnreachable(f"kubectl get {resources}: {exc}") from exc
    if out.returncode != 0:
        raise ClusterUnreachable(f"kubectl get {resources}: {out.stderr.strip() or out.returncode}")
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        raise InputError(f"kubectl get {resources}: invalid JSON: {exc}") from exc


def read_json(path: str) -> object:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"cannot read {path}: {exc}") from exc


def items_of(doc: object, what: str) -> list[dict]:
    if isinstance(doc, list):
        return [i for i in doc if isinstance(i, dict)]
    if isinstance(doc, dict) and isinstance(doc.get("items"), list):
        return [i for i in doc["items"] if isinstance(i, dict)]
    raise InputError(f"{what}: expected a kubectl List with an 'items' array")


def git_out(*cmd: str, timeout: int = 30) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(REPO_ROOT), *cmd], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None


def expected_revision(override: str | None) -> tuple[str, str]:
    """(sha, source). Without --expect-revision the local origin/main must be resolvable AND equal
    to the remote tip (`git ls-remote`, read-only); otherwise fail closed (exit 2): a stale local ref
    would let a cluster still on the old SHA pass. No fallback to HEAD."""
    if override:
        return override, "--expect-revision"
    local = git_out("rev-parse", "--verify", "origin/main")
    if not local:
        raise InputError("cannot resolve origin/main: run `git fetch origin` or pass --expect-revision <sha>")
    remote = git_out("ls-remote", "origin", "refs/heads/main")
    if not remote:
        raise InputError("cannot verify origin/main against the remote (git ls-remote origin main failed); "
                         "pass --expect-revision <sha> explicitly")
    remote_sha = remote.split()[0]
    if remote_sha != local:
        raise InputError(f"local origin/main {local[:12]} is stale (remote tip {remote_sha[:12]}): "
                         "run `git fetch origin` or pass --expect-revision <sha>")
    return local, "origin/main (verified equal to git ls-remote origin main)"


def wid(kind: str, namespace: str, name: str) -> str:
    return f"{kind}/{namespace}/{name}"


def sub(d: dict, key: str, what: str) -> dict:
    """d[key] as an object; absent/null -> {}; any other type is malformed input (exit 2)."""
    v = d.get(key)
    if v is None:
        return {}
    if not isinstance(v, dict):
        raise InputError(f"unexpected input: {what}.{key} is {type(v).__name__}, expected an object")
    return v


def meta_of(obj: dict, what: str) -> tuple[str, str]:
    m = obj.get("metadata")
    if not isinstance(m, dict):
        raise InputError(f"unexpected input: {what} has no metadata object")
    name = m.get("name")
    if not isinstance(name, str) or not name:
        raise InputError(f"unexpected input: {what} metadata.name missing or not a string")
    return name, str(m.get("namespace") or "default")


def pod_containers(obj: dict, what: str) -> dict[str, dict[str, str | None]]:
    """{'containers': {name: image}, 'initContainers': {name: image}} of a workload object."""
    spec = sub(obj, "spec", what)
    if obj.get("kind") == "CronJob":
        spec = sub(sub(spec, "jobTemplate", what), "spec", what)
    pod = sub(sub(spec, "template", what), "spec", what)
    res: dict[str, dict[str, str | None]] = {}
    for section in ("containers", "initContainers"):
        entries = pod.get(section)
        if entries is None:
            entries = []
        if not isinstance(entries, list):
            raise InputError(f"unexpected input: {what} {section} is {type(entries).__name__}, expected a list")
        found: dict[str, str | None] = {}
        for c in entries:
            if not isinstance(c, dict) or not isinstance(c.get("name"), str):
                raise InputError(f"unexpected input: {what} {section} entry without a string name")
            found[c["name"]] = c.get("image")
        res[section] = found
    return res


def declared_from_charts() -> dict[str, dict]:
    """Declared workload containers from the default-values chart render (reuses the inventory generator)."""
    import yaml  # PyYAML is already a pinned CI dependency (requirements-ci.txt)

    spec = importlib.util.spec_from_file_location("gen_inventory", REPO_ROOT / "scripts" / "generate_platform_asset_inventory.py")
    gen = importlib.util.module_from_spec(spec)
    declared: dict[str, dict] = {}
    try:
        spec.loader.exec_module(gen)
        for chart in gen.CHARTS:
            for doc in gen.render_chart(chart):
                if doc.get("kind") in WORKLOAD_KINDS:
                    name, ns = meta_of(doc, f"rendered {doc['kind']}")
                    key = wid(doc["kind"], ns, name)
                    declared[key] = pod_containers(doc, key)
    except (OSError, subprocess.SubprocessError, yaml.YAMLError) as exc:
        # exit 2, never a traceback (exit 1 means unauthorized drift)
        raise InputError(f"cannot render charts (helm required): {exc!r}") from exc
    return declared


def check_declared(doc: object) -> dict[str, dict]:
    """--declared-file shape: {'Kind/ns/name': {'containers': {name: image}, 'initContainers': {name: image}}}."""
    if not isinstance(doc, dict):
        raise InputError("declared-file: expected an object keyed by Kind/namespace/name")
    for key, v in doc.items():
        if not isinstance(v, dict) or any(not isinstance(v.get(s, {}), dict) for s in ("containers", "initContainers")):
            raise InputError(f"declared-file: {key!r} must be {{'containers': {{name: image}}, 'initContainers': {{...}}}}")
    return doc


def declared_app_names() -> list[str]:
    import yaml  # PyYAML is already a pinned CI dependency (requirements-ci.txt)

    names = []
    try:
        for path in sorted((REPO_ROOT / "gitops" / "apps").glob("*.yaml")):
            for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")):
                if isinstance(doc, dict) and doc.get("kind") == "Application":
                    names.append(doc["metadata"]["name"])
    except (OSError, yaml.YAMLError, KeyError, TypeError) as exc:
        raise InputError(f"cannot read declared Applications in gitops/apps: {exc!r}") from exc
    return names


def ignored(res: dict, rules: list[dict]) -> bool:
    for rule in rules:
        if rule.get("kind") != res.get("kind"):
            continue
        if rule.get("group", "") != res.get("group", ""):
            continue
        if rule.get("name") not in (None, res.get("name")):
            continue
        if rule.get("namespace") not in (None, res.get("namespace")):
            continue
        return True
    return False


def container_findings(key: str, got: dict, want: dict) -> list[dict]:
    out = []
    for section, label in (("containers", "container"), ("initContainers", "initContainer")):
        g, w = got.get(section, {}), want.get(section) or {}
        for name in sorted(set(g) | set(w)):
            subject = f"{key} {label}/{name}"
            if name not in g:
                out.append(finding("container", "unauthorized", subject, "declared container absent from the live workload"))
            elif name not in w:
                out.append(finding("container", "unauthorized", subject, "live container not declared in the chart render"))
            elif g[name] != w[name]:
                out.append(finding("image", "unauthorized", subject, f"live image {g[name]!r} != declared {w[name]!r}"))
    return out


def evaluate(apps: list[dict], workloads: list[dict], declared: dict[str, dict],
             expected_apps: list[str], revision: str, revision_source: str = "explicit") -> dict:
    findings: list[dict] = []
    by_name = {meta_of(a, "Application")[0]: a for a in apps}
    managed: set[str] = set()

    for name in expected_apps:
        app = by_name.get(name)
        if app is None:
            findings.append(finding("missing", "unauthorized", f"Application/{name}", "declared in gitops/apps but absent from cluster"))
            continue
        what = f"Application/{name}"
        status = sub(app, "status", what)
        sync = sub(status, "sync", what)
        revs = sync.get("revisions") if sync.get("revisions") is not None else ([sync["revision"]] if sync.get("revision") else [])
        if not isinstance(revs, list):
            raise InputError(f"unexpected input: {what} status.sync.revisions is not a list")
        if sync.get("status") != "Synced":
            findings.append(finding("sync", "unauthorized", what, f"sync status is {sync.get('status')!r}, expected 'Synced'"))
        if revision not in revs:
            findings.append(finding("sync", "unauthorized", what, f"synced revision {revs or None} != expected {revision}"))
        health = sub(status, "health", what).get("status")
        if health != "Healthy":
            findings.append(finding("health", "tolerated", what, f"health is {health!r} (not drift)"))
        rules = sub(app, "spec", what).get("ignoreDifferences")
        if rules is None:
            rules = []
        if not isinstance(rules, list) or any(not isinstance(r, dict) for r in rules):
            raise InputError(f"unexpected input: {what} spec.ignoreDifferences must be a list of objects")
        resources = status.get("resources")
        if resources is None:
            resources = []
        if not isinstance(resources, list) or any(not isinstance(r, dict) for r in resources):
            raise InputError(f"unexpected input: {what} status.resources must be a list of objects")
        if not resources:
            findings.append(finding("resource", "tolerated", what, "no tracked resources reported (nothing to check; verify the app is populated)"))
        for res in resources:
            rid = wid(str(res.get("kind", "?")), str(res.get("namespace", "")), str(res.get("name", "?")))
            subject = f"{rid} (app {name})"
            if res.get("kind") in WORKLOAD_KINDS:
                managed.add(rid)
            rhealth = sub(res, "health", subject).get("status")
            if rhealth not in (None, "Healthy"):
                findings.append(finding("health", "tolerated", subject, f"health is {rhealth!r} (not drift)"))
            rstatus = res.get("status")
            if rstatus is None:
                findings.append(finding("resource", "tolerated", subject, "no sync status reported (sync-hook / untracked; docs section 2.D)"))
            elif rstatus == "OutOfSync":
                if ignored(res, rules):
                    findings.append(finding("resource", "tolerated", subject, "OutOfSync and matches an ignoreDifferences rule by kind/group/name/namespace; "
                                                                  "Argo applies the rule before computing sync status, but the field-level cause is NOT verified"))
                else:
                    findings.append(finding("resource", "unauthorized", subject, "OutOfSync and not covered by spec.ignoreDifferences"))
            elif rstatus != "Synced":
                findings.append(finding("resource", "tolerated", subject, f"sync status {rstatus!r}"))

    live = {}
    for w in workloads:
        wname, wns = meta_of(w, "workload")
        live[wid(str(w.get("kind", "?")), wns, wname)] = w
    for key in sorted(declared):
        obj = live.get(key)
        if obj is None:
            findings.append(finding("missing", "unauthorized", key, "declared workload absent from cluster"))
            continue
        findings.extend(container_findings(key, pod_containers(obj, key), declared[key]))
    for key in sorted(managed - set(live) - set(declared)):
        findings.append(finding("missing", "unauthorized", key, "Argo-tracked workload absent from live workload list"))
    for key in sorted((managed & set(live)) - set(declared)):
        findings.append(finding("undeclared", "unauthorized", key,
                                "live and Argo-tracked but absent from the chart render: image cannot be checked"))
    skipped = sorted(k for k in live if k not in declared and k not in managed)

    findings.sort(key=lambda f: (f["check"], f["subject"], f["class"], f["detail"]))
    return {
        "expected_revision": revision,
        "expected_revision_source": revision_source,
        "coverage": "ArgoCD Applications, tracked-resource sync status, per-container images of workloads rendered from the repo charts. "
                    "Not RBAC/NetworkPolicy/Service; images of skipped workloads are NOT checked.",
        "workloads": {"live": len(live), "image_checked": len(set(live) & set(declared))},
        "summary": {c: sum(1 for f in findings if f["class"] == c) for c in ("expected", "tolerated", "unauthorized")},
        "findings": findings,
        "skipped": [f"{k}: not rendered by the repo charts and not Argo-tracked (operator/upstream/add-on); image NOT checked" for k in skipped],
    }


def human_summary(report: dict) -> str:
    s = report["summary"]
    lines = [f"expected revision {report['expected_revision']} (source: {report['expected_revision_source']})",
             f"live drift check @ {report['expected_revision'][:12]}: unauthorized={s['unauthorized']} "
             f"expected={s['expected']} tolerated={s['tolerated']} skipped={len(report['skipped'])} "
             f"(image-checked {report['workloads']['image_checked']} of {report['workloads']['live']} live workloads)"]
    for f in report["findings"]:
        if f["class"] == "unauthorized":
            lines.append(f"  UNAUTHORIZED {f['check']}: {f['subject']} - {f['detail']}")
    for f in report["findings"]:
        if f["check"] == "resource" and f["class"] == "tolerated":
            lines.append(f"  tolerated resource: {f['subject']} - {f['detail']}")
    for f in report["findings"]:
        if f["check"] == "health":
            lines.append(f"  health (not drift): {f['subject']} - {f['detail']}")
    if report["skipped"]:
        lines.append(f"  NOT CHECKED (image drift undetected) - {len(report['skipped'])} workloads:")
        lines.extend(f"    {k.split(': ', 1)[0]}" for k in report["skipped"])
    lines.append("RESULT: " + ("FAIL (unauthorized drift)" if s["unauthorized"] else "PASS (no unauthorized drift)"))
    return "\n".join(lines)


def gather(args: argparse.Namespace) -> tuple[list[dict], list[dict]]:
    if args.from_file:
        dump = read_json(args.from_file)
        if not isinstance(dump, dict):
            raise InputError(f"{args.from_file}: expected an object with 'applications' and 'workloads'")
        return items_of(dump.get("applications"), "applications"), items_of(dump.get("workloads"), "workloads")
    if bool(args.apps_file) != bool(args.workloads_file):
        raise InputError("--apps-file and --workloads-file must be given together")
    if args.apps_file:
        return items_of(read_json(args.apps_file), "apps-file"), items_of(read_json(args.workloads_file), "workloads-file")
    apps = items_of(kubectl_get("applications.argoproj.io"), "applications")
    workloads = items_of(kubectl_get("deployments,statefulsets,daemonsets,cronjobs"), "workloads")
    return apps, workloads


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only live GitOps drift check (Issue #39)")
    ap.add_argument("--from-file", help="combined JSON {'applications': <kubectl list>, 'workloads': <kubectl list>}")
    ap.add_argument("--apps-file", help="kubectl get applications.argoproj.io -A -o json dump")
    ap.add_argument("--workloads-file", help="kubectl get deploy,sts,ds,cronjob -A -o json dump")
    ap.add_argument("--declared-file", help="JSON {'Kind/ns/name': {'containers': {name: image}, 'initContainers': {...}}} instead of rendering the charts")
    ap.add_argument("--expect-revision", help="expected Git revision (default: local origin/main, verified against git ls-remote; no HEAD fallback)")
    ap.add_argument("--out", help="write the JSON report here instead of stdout")
    ap.add_argument("--skip-if-unreachable", action="store_true", help="exit 0 with a message when the cluster is unreachable")
    args = ap.parse_args(argv)
    try:
        apps, workloads = gather(args)
        revision, source = expected_revision(args.expect_revision)
        declared = check_declared(read_json(args.declared_file)) if args.declared_file else declared_from_charts()
        report = evaluate(apps, workloads, declared, declared_app_names(), revision, source)
    except ClusterUnreachable as exc:
        if args.skip_if_unreachable:
            print(f"SKIPPED: cluster unreachable ({exc}); no drift check performed", file=sys.stderr)
            return EXIT_OK
        print(f"error: cluster unreachable: {exc}", file=sys.stderr)
        return EXIT_INPUT
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    except (AttributeError, TypeError, KeyError, ValueError) as exc:
        print(f"error: unreadable/unexpected input shape ({exc!r}); this is NOT a drift verdict", file=sys.stderr)
        return EXIT_INPUT
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    print(human_summary(report), file=sys.stderr)
    return EXIT_DRIFT if report["summary"]["unauthorized"] else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
