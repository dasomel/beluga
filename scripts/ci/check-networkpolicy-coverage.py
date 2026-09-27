#!/usr/bin/env python3
"""NetworkPolicy coverage ratchet gate (Issue #11).

Triage for #11 found that the rendered charts leave several workload namespaces
(iam, database, lakehouse, orchestration, streaming, analytics) with zero
NetworkPolicy of any kind, while governance/storage already carry a real
namespace-wide default-deny. This gate is a RATCHET ONLY: it does not add
default-deny policies to the uncovered namespaces (that needs live cluster
traffic validation and is #11's follow-up), it only prevents further drift.

Code review (post-#11) tightened this from name-keyed and shape-loose checks to
semantic, name-independent ones. Rules, evaluated against `helm template` output
for every deployed values combo (see COMBOS below):

1. Coverage: every namespace that renders a workload (Deployment/StatefulSet/
   DaemonSet/Job/CronJob) must have >=1 NetworkPolicy that is a real
   namespace-wide default-deny for Ingress (see is_namespace_default_deny),
   *regardless of the policy's name* -- unless the namespace is listed in
   networkpolicy-baseline.yaml with a reason and an issue reference. The
   baseline is a ratchet: a namespace that gains coverage must be removed from
   it (stale entries fail), and a namespace that loses coverage without being
   (re-)baselined fails too. A narrow, pod-scoped, or allow-all-ingress policy
   does NOT count as coverage (D-2 below).
2. Ingress regression (unconditional, not baseline-gated, name-independent):
   any NetworkPolicy whose podSelector selects every pod in the namespace
   (`{}` / empty matchLabels) and whose policyTypes include Ingress must have
   zero ingress rules. A namespace-wide policy that claims to gate Ingress but
   still leaks traffic through via ingress rules is a broken/fake default-deny
   and fails always -- it cannot be hidden by adding the namespace to the
   baseline (D-3 below; this generalizes the old "default-deny-all" literal
   name check so a rename can no longer bypass it).
3. Egress requirement (D-5 below): every namespace in the coverage set (rule 1)
   must also carry a namespace-wide default-deny for Egress. Verified against
   the current render before landing this rule: every namespace that is
   actually covered already has it (governance, storage), so this is a hard
   requirement, not baseline-gated -- a future covered namespace lacking it
   fails closed instead of silently degrading to ingress-only protection.
4. Egress regression (unconditional, D-4 below): any policy in a namespace
   that has an unrestricted egress rule (no `to` selector, matching every
   destination) is flagged, even if a separate policy in the same namespace
   is a correct default-deny -- an allow-all-egress companion policy defeats
   the point regardless of what else is present.
5. Baseline ratchet ceiling (D-1 below): every namespace listed in
   networkpolicy-baseline.yaml must also appear in the frozen
   ACCEPTED_BASELINE_NAMESPACES set in this file. Growing the baseline beyond
   that ceiling requires editing this script, not just the YAML data file.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = Path(__file__).resolve().parent / "networkpolicy-baseline.yaml"
CHARTS = ("beluga-platform", "beluga-data")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}

# D-1 (Issue #11 code review, HIGH): the baseline YAML alone is not a real
# ratchet -- editing it to add a new namespace with a reason+issue always
# passed before this change, so silent drift and legitimate new-gap
# baselining looked identical in the diff. A history-based check
# (`git show origin/main:scripts/ci/networkpolicy-baseline.yaml`) was
# considered, but .github/workflows/ci.yml's `validate` job checks out with
# actions/checkout's default fetch-depth (1) against a single ref
# (the PR merge ref or push ref) -- `origin/main` is not resolvable there
# without an extra fetch step. Even with one, it wouldn't actually solve the
# problem: a PR legitimately baselining a brand-new gap (self-test below)
# necessarily adds an entry that isn't on main yet either, so a
# diff-against-main check can't tell that apart from silent drift without
# extra out-of-band signal. Instead: this frozen ceiling of accepted baseline
# namespaces lives in the gate's own code. The YAML baseline may only ever
# contain namespaces from this set; growing it requires editing THIS
# constant -- a change to the gate script itself, not just its data file --
# which is a strictly more visible, reviewable diff than a two-line YAML
# addition. Shrinking this set is not required when a namespace gains real
# coverage and drops out of the baseline; only growth beyond it is blocked.
ACCEPTED_BASELINE_NAMESPACES = frozenset({
    "iam",
    "database",
    "lakehouse",
    "orchestration",
    "streaming",
    "analytics",
    # D-2 (Issue #11 code review, follow-up to HIGH/MEDIUM #2 and #4 below):
    # platform-system's only NetworkPolicy (apisix-admin-restrict) is
    # pod-scoped (podSelector matchLabels app=apisix), not namespace-wide, so
    # it never was a real default-deny -- the previous "has >=1 policy of any
    # shape" coverage rule just didn't notice. Under the semantic coverage
    # rule this namespace is honestly uncovered like the others above, same
    # class of problem (needs live traffic validation before hardening), so
    # it is baselined openly here rather than weakening the new rule to keep
    # it looking "covered".
    "platform-system",
})


def documents(manifest_text: str) -> list[dict]:
    """Parse `helm template` stdout into a flat list of resource mappings."""
    result: list[dict] = []

    def add(resource) -> None:
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


def workload_namespaces(resources: list[dict]) -> set[str]:
    namespaces = set()
    for resource in resources:
        if resource.get("kind") in WORKLOAD_KINDS:
            namespaces.add(resource.get("metadata", {}).get("namespace", "default"))
    return namespaces


def networkpolicies_by_namespace(resources: list[dict]) -> dict[str, list[dict]]:
    by_ns: dict[str, list[dict]] = {}
    for resource in resources:
        if resource.get("kind") != "NetworkPolicy":
            continue
        ns = resource.get("metadata", {}).get("namespace", "default")
        by_ns.setdefault(ns, []).append(resource)
    return by_ns


def _selects_all_pods(pod_selector) -> bool:
    """True if `pod_selector` matches every pod in the namespace (namespace-wide)."""
    if pod_selector == {}:
        return True
    if not isinstance(pod_selector, dict):
        return False
    match_labels = pod_selector.get("matchLabels") or {}
    match_expressions = pod_selector.get("matchExpressions") or []
    return not match_labels and not match_expressions


def is_namespace_default_deny(netpol: dict, *, require_egress: bool) -> bool:
    """True if `netpol` is a namespace-wide default-deny policy, regardless of name.

    D-2/D-3 (Issue #11 code review, HIGH): the old check keyed detection off the
    literal name `default-deny-all`, so renaming a policy (or writing an
    equivalent one under a different name) silently bypassed both coverage and
    the regression check. Detection here is purely structural: the policy must
    select every pod in the namespace (D-selectors), cover Ingress (and, when
    `require_egress` is set, Egress too), and carry no ingress rules -- and, when
    Egress is required, no egress rules of its own. A companion policy may still
    carve out narrow, scoped exceptions (e.g. DNS) without affecting this check;
    see has_unrestricted_egress_rule for the check that guards against a
    companion policy reopening egress wholesale.
    """
    spec = netpol.get("spec") or {}
    if not _selects_all_pods(spec.get("podSelector")):
        return False
    policy_types = spec.get("policyTypes") or []
    if "Ingress" not in policy_types or spec.get("ingress"):
        return False
    if require_egress:
        if "Egress" not in policy_types or spec.get("egress"):
            return False
    return True


def is_leaky_namespace_wide_ingress(netpol: dict) -> bool:
    """True if a namespace-wide policy claims to gate Ingress but still leaks it.

    D-3 (Issue #11 code review, HIGH): a policy that selects every pod in the
    namespace and lists Ingress in policyTypes is, by this codebase's
    convention, meant to express "no ingress reaches this namespace by
    default". If it still carries ingress rules, that promise is broken --
    this is checked unconditionally (not baseline-gated) so it can't be
    silently hidden by adding the namespace to the baseline, generalizing the
    old name-keyed regression check.
    """
    spec = netpol.get("spec") or {}
    if not _selects_all_pods(spec.get("podSelector")):
        return False
    policy_types = spec.get("policyTypes") or []
    return "Ingress" in policy_types and bool(spec.get("ingress"))


def has_unrestricted_egress_rule(netpol: dict) -> bool:
    """True if any egress rule on `netpol` omits `to` (matches every destination).

    D-4 (Issue #11 code review, MEDIUM): per the NetworkPolicy spec, an egress
    rule with no `to` selector matches all destinations. A namespace can carry
    a genuine default-deny-all policy *and* a second policy that quietly
    reopens egress to everything, which would defeat the point while the
    namespace still "looks" default-deny at a glance. Checked unconditionally,
    against every policy, not just ones that otherwise look like default-deny.
    """
    spec = netpol.get("spec") or {}
    for rule in spec.get("egress") or []:
        if not rule.get("to"):
            return True
    return False


def evaluate_combo(resources: list[dict]) -> tuple[set[str], set[str], set[str], list[str]]:
    """Return (workload_namespaces, default_deny_ingress_ns, default_deny_egress_ns, violations)."""
    workloads = workload_namespaces(resources)
    netpols = networkpolicies_by_namespace(resources)

    default_deny_ingress_ns: set[str] = set()
    default_deny_egress_ns: set[str] = set()
    violations: list[str] = []

    for ns, policies in netpols.items():
        if any(is_namespace_default_deny(p, require_egress=False) for p in policies):
            default_deny_ingress_ns.add(ns)
        if any(is_namespace_default_deny(p, require_egress=True) for p in policies):
            default_deny_egress_ns.add(ns)

        for policy in policies:
            name = policy.get("metadata", {}).get("name")
            if is_leaky_namespace_wide_ingress(policy):
                violations.append(
                    f"namespace '{ns}': policy '{name}' selects every pod and lists Ingress in "
                    "policyTypes, but still carries ingress rules -- a namespace-wide policy "
                    "claiming to gate Ingress cannot leak ingress through it (D-3); this cannot "
                    "be silenced by baselining the namespace"
                )
            if has_unrestricted_egress_rule(policy):
                violations.append(
                    f"namespace '{ns}': policy '{name}' has an unrestricted egress rule (no 'to' "
                    "selector, matches every destination) -- this reopens egress to everything "
                    "and defeats any default-deny egress policy in the same namespace (D-4)"
                )

    return workloads, default_deny_ingress_ns, default_deny_egress_ns, violations


def load_baseline(path: Path) -> dict[str, dict]:
    if not path.is_file():
        raise ValueError(f"baseline file not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = data.get("namespaces")
    if not isinstance(entries, list):
        raise ValueError(f"{path.name}: top-level 'namespaces' must be a list")

    baseline: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"{path.name}: each baseline entry must be a mapping")
        namespace = entry.get("namespace")
        reason = entry.get("reason")
        issue = entry.get("issue")
        if not isinstance(namespace, str) or not namespace:
            raise ValueError(f"{path.name}: baseline entry missing non-empty 'namespace'")
        if namespace in baseline:
            raise ValueError(f"{path.name}: duplicate baseline entry for namespace '{namespace}'")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"{path.name}: baseline entry '{namespace}' missing non-empty 'reason'")
        if not isinstance(issue, int) or isinstance(issue, bool) or issue <= 0:
            raise ValueError(f"{path.name}: baseline entry '{namespace}' missing positive integer 'issue'")
        baseline[namespace] = {"reason": reason, "issue": issue}
    return baseline


def check_coverage(combos: list[tuple[str, list[dict]]], baseline: dict[str, dict]) -> tuple[list[str], dict]:
    """combos: list of (label, resources) already rendered/parsed for one values combo."""
    errors: list[str] = []
    all_workloads: set[str] = set()
    # A namespace is only evaluated for a given combo when it actually renders a workload
    # THERE (e.g. governance only gets workloads when openmetadata is enabled) -- these dicts
    # track, per namespace, which combo *labels* it was found lacking coverage in among the
    # combos where it had a workload at all. A namespace with no entry never went uncovered in
    # any applicable combo.
    ingress_gap_in: dict[str, set[str]] = {}
    egress_gap_in: dict[str, set[str]] = {}

    for label, resources in combos:
        workloads, dd_ingress_ns, dd_egress_ns, violations = evaluate_combo(resources)
        all_workloads |= workloads
        errors.extend(violations)

        for ns in workloads:
            if ns not in dd_ingress_ns:
                ingress_gap_in.setdefault(ns, set()).add(label)
            if ns not in dd_egress_ns:
                egress_gap_in.setdefault(ns, set()).add(label)

    gap_namespaces = set(ingress_gap_in)

    for ns in sorted(gap_namespaces):
        if ns not in baseline:
            combos_str = ", ".join(sorted(ingress_gap_in[ns]))
            errors.append(
                f"namespace '{ns}' has workloads without namespace-wide default-deny Ingress "
                f"coverage in combo(s): {combos_str}, and is not listed in {BASELINE_PATH.name} "
                "(either add a baseline entry with reason+issue, or apply default-deny after "
                "cluster traffic validation)"
            )

    for ns in sorted(baseline):
        if ns not in gap_namespaces:
            errors.append(
                f"stale baseline entry '{ns}': namespace now has default-deny Ingress coverage in "
                f"every deployed combo; remove it from {BASELINE_PATH.name} (ratchet only tightens)"
            )
        elif ns not in ACCEPTED_BASELINE_NAMESPACES:
            # D-1: ratchet ceiling -- see the constant's docstring above.
            errors.append(
                f"namespace '{ns}' is in {BASELINE_PATH.name} but not in the frozen "
                f"ACCEPTED_BASELINE_NAMESPACES ceiling in {Path(__file__).name} -- baseline growth "
                "requires bumping that ceiling as an explicit, reviewable code change, not just "
                "editing the YAML data file (D-1)"
            )

    covered = sorted(all_workloads - gap_namespaces)
    for ns in covered:
        if ns in egress_gap_in:
            errors.append(
                f"namespace '{ns}' has namespace-wide default-deny Ingress coverage but not Egress "
                "-- coverage requires both (D-5); add an Egress default-deny for this namespace or "
                "revisit this requirement if it can no longer be met"
            )

    egress_report = {ns: ("open" if ns in egress_gap_in else "default-deny") for ns in covered}
    report = {"covered": covered, "baselined": sorted(baseline), "gaps": sorted(gap_namespaces), "egress": egress_report}
    return errors, report


def _resource(kind: str, namespace: str, name: str, spec: dict | None = None) -> dict:
    return {
        "apiVersion": "v1",
        "kind": kind,
        "metadata": {"name": name, "namespace": namespace},
        "spec": spec or {},
    }


def self_test() -> None:
    """Built-in positive/negative fixtures; run on every gate invocation (no `helm` needed)."""
    deploy_iam = _resource("Deployment", "iam", "keycloak")
    deploy_storage = _resource("StatefulSet", "storage", "seaweedfs")
    deploy_platform = _resource("Deployment", "platform-system", "apisix")

    full_default_deny = _resource(
        "NetworkPolicy", "storage", "default-deny-all",
        {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
    )
    empty_lists_default_deny = _resource(
        "NetworkPolicy", "storage", "default-deny-all",
        {"podSelector": {}, "policyTypes": ["Ingress", "Egress"], "ingress": [], "egress": []},
    )
    # Rename-safety fixture (D-2/D-3): a namespace-wide, full default-deny policy under a
    # deliberately unconventional name must still be recognized -- detection is structural.
    renamed_full_default_deny = _resource(
        "NetworkPolicy", "storage", "zz-net-lockdown",
        {"podSelector": {"matchLabels": {}}, "policyTypes": ["Ingress", "Egress"]},
    )
    leaky_namespace_wide_ingress = _resource(
        "NetworkPolicy", "storage", "storage-guard",
        {"podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{"from": []}]},
    )
    ingress_only_default_deny = _resource(
        "NetworkPolicy", "iam", "iam-ingress-lockdown",
        {"podSelector": {}, "policyTypes": ["Ingress"]},
    )
    scoped_policy = _resource(
        "NetworkPolicy", "platform-system", "apisix-admin-restrict",
        {"podSelector": {"matchLabels": {"app": "apisix"}}, "policyTypes": ["Ingress"], "ingress": [{"from": []}]},
    )
    unrestricted_egress_companion = _resource(
        "NetworkPolicy", "storage", "storage-allow-egress-everywhere",
        {"podSelector": {}, "policyTypes": ["Egress"], "egress": [{"ports": [{"port": 443}]}]},
    )

    # 1. Baseline correctly documents an uncovered namespace -> passes, reported as a gap.
    combos = [("default", [deploy_iam, deploy_storage, full_default_deny])]
    baseline = {"iam": {"reason": "needs cluster validation", "issue": 11}}
    errors, report = check_coverage(combos, baseline)
    if errors:
        raise ValueError(f"self-test baseline-covers-gap unexpectedly failed: {errors}")
    if report["gaps"] != ["iam"] or report["covered"] != ["storage"]:
        raise ValueError(f"self-test baseline-covers-gap report mismatch: {report}")
    if report["egress"] != {"storage": "default-deny"}:
        raise ValueError(f"self-test baseline-covers-gap egress report mismatch: {report}")

    # 2. Same render, no baseline entry -> new gap must fail closed.
    errors, _ = check_coverage(combos, {})
    if not any("is not listed in" in error for error in errors):
        raise ValueError(f"self-test undocumented-gap did not fail as expected: {errors}")

    # 3. Namespace is fully covered but still baselined -> stale entry must fail (ratchet tightens).
    combos_covered = [("default", [deploy_iam, deploy_storage, full_default_deny,
                                    _resource("NetworkPolicy", "iam", "iam-default-deny",
                                              {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]})])]
    errors, _ = check_coverage(combos_covered, baseline)
    if not any("stale baseline entry" in error for error in errors):
        raise ValueError(f"self-test stale-baseline did not fail as expected: {errors}")

    # 4. A namespace whose only policy is narrower than a namespace-wide default-deny (reality:
    #    platform-system's apisix-admin-restrict is pod-scoped) no longer counts as coverage
    #    (D-2/D-4 tightened this from the old "any policy at all" rule) -- must fail if undocumented.
    combos_scoped = [("default", [deploy_platform, scoped_policy])]
    errors, report = check_coverage(combos_scoped, {})
    if not any("is not listed in" in error for error in errors):
        raise ValueError(f"self-test scoped-policy-is-not-coverage did not fail as expected: {errors}")
    if report["covered"]:
        raise ValueError(f"self-test scoped-policy-is-not-coverage report mismatch: {report}")

    # 5. A default-deny-all policy with explicit empty ingress/egress lists is still a true,
    #    fully covered (ingress + egress) default-deny.
    combos_empty = [("default", [deploy_storage, empty_lists_default_deny])]
    errors, report = check_coverage(combos_empty, {})
    if errors:
        raise ValueError(f"self-test empty-lists-is-default-deny unexpectedly failed: {errors}")
    if report["egress"] != {"storage": "default-deny"}:
        raise ValueError(f"self-test empty-lists-is-default-deny egress report mismatch: {report}")

    # 6. Rename safety (D-2/D-3): a full default-deny policy under a non-conventional name is
    #    still recognized as coverage -- detection must not depend on the literal name.
    combos_renamed = [("default", [deploy_storage, renamed_full_default_deny])]
    errors, report = check_coverage(combos_renamed, {})
    if errors:
        raise ValueError(f"self-test renamed-default-deny-is-coverage unexpectedly failed: {errors}")
    if report["covered"] != ["storage"] or report["egress"] != {"storage": "default-deny"}:
        raise ValueError(f"self-test renamed-default-deny-is-coverage report mismatch: {report}")

    # 7. A namespace-wide policy that claims to gate Ingress but still leaks ingress rules through
    #    is a broken/fake default-deny -- fails unconditionally, baseline or not (D-3), and a
    #    differently-named policy proves this isn't a name-keyed check.
    combos_leaky = [("default", [deploy_storage, leaky_namespace_wide_ingress])]
    errors, _ = check_coverage(combos_leaky, {"storage": {"reason": "irrelevant", "issue": 11}})
    if not any("leak ingress through it" in error for error in errors):
        raise ValueError(f"self-test leaky-namespace-wide-ingress did not fail as expected: {errors}")

    # 8. Egress requirement (D-5): a namespace with ingress-only default-deny coverage (no Egress
    #    in policyTypes) must fail the egress requirement even though it is otherwise covered.
    combos_ingress_only = [("default", [deploy_iam, ingress_only_default_deny])]
    errors, report = check_coverage(combos_ingress_only, {})
    if not any("coverage requires both" in error for error in errors):
        raise ValueError(f"self-test ingress-only-default-deny did not fail as expected: {errors}")
    if report["covered"] != ["iam"] or report["egress"] != {"iam": "open"}:
        raise ValueError(f"self-test ingress-only-default-deny report mismatch: {report}")

    # 9. Egress regression (D-4): an unrestricted-egress companion policy defeats an otherwise
    #    correct default-deny-all in the same namespace and must be flagged regardless.
    combos_unrestricted_egress = [
        ("default", [deploy_storage, full_default_deny, unrestricted_egress_companion])
    ]
    errors, _ = check_coverage(combos_unrestricted_egress, {})
    if not any("reopens egress to everything" in error for error in errors):
        raise ValueError(f"self-test unrestricted-egress-companion did not fail as expected: {errors}")

    # 10. Ratchet ceiling (D-1): a baseline entry for a namespace outside the frozen
    #     ACCEPTED_BASELINE_NAMESPACES ceiling must fail even though it is a genuine, documented gap.
    deploy_new_gap = _resource("Deployment", "totally-new-namespace", "svc")
    combos_new_gap = [("default", [deploy_new_gap])]
    errors, _ = check_coverage(combos_new_gap, {"totally-new-namespace": {"reason": "x", "issue": 999}})
    if not any("baseline growth requires bumping that ceiling" in error for error in errors):
        raise ValueError(f"self-test ratchet-ceiling did not fail as expected: {errors}")

    # 11. Baseline schema validation: missing reason, missing issue, duplicate namespace.
    with tempfile.TemporaryDirectory(prefix="beluga-networkpolicy-baseline-") as tmpdir:
        path = Path(tmpdir) / "networkpolicy-baseline.yaml"
        schema_cases = [
            ("namespaces:\n  - namespace: iam\n    issue: 11\n", "non-empty 'reason'"),
            ("namespaces:\n  - namespace: iam\n    reason: x\n", "positive integer 'issue'"),
            ("namespaces:\n  - namespace: iam\n    reason: x\n    issue: 0\n", "positive integer 'issue'"),
            (
                "namespaces:\n  - namespace: iam\n    reason: x\n    issue: 11\n"
                "  - namespace: iam\n    reason: y\n    issue: 11\n",
                "duplicate baseline entry",
            ),
            ("namespaces: not-a-list\n", "must be a list"),
        ]
        for content, expected_diagnostic in schema_cases:
            path.write_text(content, encoding="utf-8")
            try:
                load_baseline(path)
            except ValueError as error:
                if expected_diagnostic not in str(error):
                    raise ValueError(f"self-test schema case unexpected message: {error}") from error
            else:
                raise ValueError(f"self-test schema case unexpectedly accepted: {content!r}")

        path.write_text("namespaces:\n  - namespace: iam\n    reason: x\n    issue: 11\n", encoding="utf-8")
        if load_baseline(path) != {"iam": {"reason": "x", "issue": 11}}:
            raise ValueError("self-test valid baseline schema did not round-trip")

    print(f"Self-tests OK: {len(schema_cases) + 10} ratchet fixtures accepted/rejected as expected.",
          file=sys.stderr)


def render_combo(values: dict[str, str]) -> list[dict]:
    resources: list[dict] = []
    env = {**os.environ, "KUBECONFIG": os.devnull}
    for chart in CHARTS:
        cmd = ["helm", "template", str(REPO_ROOT / "gitops" / "charts" / chart)]
        for key, value in values.items():
            cmd.extend(["--set", f"{key}={value}"])
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
        resources.extend(documents(result.stdout))
    return resources


# Deployed values combos. beluga-data's flags mirror scripts/common/env.sh's RAM
# profile switch (BELUGA_PROFILE >= 48 flips both together) and are applied exactly
# this way by scripts/gitops/01-argocd-bootstrap.sh. beluga-platform takes neither
# flag today but is rendered in both combos anyway, so a future platform-side
# namespace gated by them is not silently skipped by this gate.
#
# D-6 (Issue #11 code review, follow-up finding, verified not applicable): a
# review pass asked whether plain (non-Helm) manifests under gitops/apps/ (or
# elsewhere under gitops/) are excluded from this render. Checked: gitops/apps/
# contains only ArgoCD `kind: Application` CRs (app-of-apps.yaml,
# beluga-data.yaml, beluga-platform.yaml) that point back at these same two
# charts -- they define no Deployment/StatefulSet/NetworkPolicy of their own,
# and `find gitops -name Chart.yaml` / a repo-wide grep for
# `kind: NetworkPolicy` and workload kinds confirm there is no other Helm
# chart or raw manifest under gitops/ that this gate would need to render.
COMBOS: tuple[tuple[str, dict[str, str]], ...] = (
    ("default (BELUGA_PROFILE < 48)", {"openmetadata.enabled": "false", "trino.workerEnabled": "false"}),
    ("48/64GB profile", {"openmetadata.enabled": "true", "trino.workerEnabled": "true"}),
)


def main() -> int:
    try:
        self_test()
    except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
        print(f"NetworkPolicy coverage self-test FAIL: {error}", file=sys.stderr)
        return 1

    try:
        baseline = load_baseline(BASELINE_PATH)
        combos = [(label, render_combo(values)) for label, values in COMBOS]
        errors, report = check_coverage(combos, baseline)
    except subprocess.CalledProcessError as exc:
        print(f"FAIL: helm template exited {exc.returncode}\n{exc.stderr}", file=sys.stderr)
        return 1
    except (OSError, ValueError, yaml.YAMLError) as exc:
        print(f"FAIL: NetworkPolicy coverage: {exc}", file=sys.stderr)
        return 1

    print("=== NetworkPolicy coverage ratchet (Issue #11) ===")
    print(f"Covered namespaces ({len(report['covered'])}):")
    for ns in report["covered"]:
        print(f"  - {ns}: ingress=default-deny, egress={report['egress'][ns]}")
    print(f"Baselined known-uncovered namespaces ({len(report['baselined'])}):")
    for ns in report["baselined"]:
        entry = baseline[ns]
        print(f"  - {ns}: {entry['reason']} (issue #{entry['issue']})")

    if errors:
        print()
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print("\nOK: every workload namespace has namespace-wide default-deny (Ingress+Egress) coverage "
          "or a documented baseline exception; no default-deny regressions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
