# GitOps Configuration Drift Control (Proposal)

English | [한국어](gitops-drift-control-ko.md)

Refs [Issue #39](https://github.com/dasomel/beluga/issues/39) ("Detect and enforce GitOps configuration drift").

> **Status: PROPOSAL. Documentation only.** No script, Application, policy or CI workflow is changed. This document builds on
> what already exists: [Authoritative Configuration Sources](configuration-sources.md) (criterion 1) and the read-only
> `make drift-live` check. Repository statements carry a `file:line` read at the commit this document was written against.
> Live statements come from read-only commands run on 2026-10-07 (~14:07 UTC), labelled **L#**; unmeasured items are **not
> verified live**. External statements cite an official page `[S#]` (accessed 2026-10-07) or say **no official recommendation**.
> Items marked **Proposed** or **Owner decision** have no basis in the repository.

---

## 1. Purpose and issue mapping

| Issue #39 acceptance criterion | State today | Where addressed here |
|---|---|---|
| Authoritative configuration sources documented | Done: [`configuration-sources.md` section 1](configuration-sources.md) | not repeated |
| Material drift detected and reported | Partly: on demand, for the covered scope (2.2) | sections 3, 4.2, 4.4 |
| Unauthorized live changes distinguished from expected generated state | Partly: classification exists for the covered scope | sections 3, 4.1 |
| Reconciliation procedure repeatable | **Open** (owner decision pending in `configuration-sources.md`) | section 4.3 |
| Drift evidence retained for operational review | Artifact only (manual) | section 4.4 |

---

## 2. Current state (verified)

### 2.1 Enforcement by ArgoCD

| Fact | Evidence |
|---|---|
| Both workload Applications have `automated: {prune: true, selfHeal: true}` plus `ServerSideApply=true`; `beluga-data` adds `RespectIgnoreDifferences=true` and one `ignoreDifferences` rule (StatefulSet `volumeClaimTemplates` API-defaulted fields) | [`beluga-data.yaml:20-26`](../gitops/apps/beluga-data.yaml#L20-L26), [`:30-37`](../gitops/apps/beluga-data.yaml#L30-L37); `ignoreDifferences` semantics [S4] |
| ArgoCD documents the automatic sync interval as the `timeout.reconciliation` ConfigMap value, default 120 s plus 60 s jitter, and that `selfHeal` retries after the self-heal timeout (5 s default) [S1]. The live `argocd-cm` does not override `timeout.reconciliation` (L2), so the default applies | [S1], L2 |
| Self-heal reverts out-of-band edits quietly, including fixes that were committed but not pushed; this has already cost debugging time | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:63`](mistakes-log.md#L63) |
| ArgoCD only automates one sync per unique (commit, parameters) pair and does not retry a failed attempt on the same commit [S1]; a stuck hook can pin an Application | [S1], [`mistakes-log.md:53`](mistakes-log.md#L53), [`:86`](mistakes-log.md#L86) |

### 2.2 `make drift-live` (existing)

| Fact | Evidence |
|---|---|
| Read-only (`kubectl get` only); exit 0 clean, 1 unauthorized, 2 unreachable/unverifiable revision; **not** part of `make validate` (its offline unit tests are) | [`Makefile:147-155`](../Makefile#L147-L155), [`Makefile:97-98`](../Makefile#L97-L98) |
| Classes: `expected` (reserved, nothing emits it), `tolerated`, `unauthorized`; checks: sync revision, tracked-resource OutOfSync, per-container image vs chart render, missing/undeclared workloads, health reported as tolerated | [`check-live-drift.py:7-21`](../scripts/ops/check-live-drift.py#L7-L21) |
| Stated coverage limit: Applications, tracked-resource sync status, workload images; **not** RBAC, NetworkPolicy, Service, ConfigMap/Secret contents; workloads neither chart-rendered nor Argo-tracked (operators, upstream manifests, add-ons) are `skipped` and their images are not checked | [`check-live-drift.py:23-27`](../scripts/ops/check-live-drift.py#L23-L27) |
| Evidence artifact: `--out <file>` writes deterministic JSON; storage and review are manual, no scheduler and no retention | [`configuration-sources.md` section 4](configuration-sources.md#L101), [`Makefile:149-155`](../Makefile#L149-L155) |
| Expected generated state is documented (credentials, operator-generated Secrets/Certificates, API-server defaults, sync-hook Jobs) | [`configuration-sources.md` section 2](configuration-sources.md#L34) |
| Static gates already prevent several prohibited changes before merge (image pinning, NetworkPolicy coverage, security baseline, plaintext identity endpoints, Kafka listener security); see [security gates](security-gates.md) | [`Makefile:64-120`](../Makefile#L64-L120) |

### 2.3 Live measurements (read-only, 2026-10-07)

| # | Command | Result |
|---|---|---|
| L1 | `kubectl -n argocd get applications` and `-o json` | 3 Applications (`beluga-root`, `beluga-platform`, `beluga-data`), all Synced/Healthy at `9f74c2be...` = `origin/main`; `selfHeal`, `prune` true on all three; only `beluga-data` has `ignoreDifferences` (the StatefulSet rule above); no `retry` block |
| L2 | `kubectl -n argocd get cm argocd-cm -o json` (keys) | only `resource.customizations.ignoreResourceUpdates.*` and `resource.exclusions`; no `timeout.reconciliation` |
| L3 | `kubectl -n argocd get cm argocd-notifications-cm` | `DATA 0`: no notification triggers or services; no alerting stack exists (see [monitoring coverage](monitoring-alerting-coverage.md) L1) |
| L4 | `make drift-live DRIFT_ARGS="--expect-revision 9f74c2be... --out <scratch>"` | `RESULT: PASS (no unauthorized drift)`; summary `expected 0 / tolerated 15 / unauthorized 0`; all 15 findings are `resource` with "no sync status reported (sync-hook / untracked)", e.g. `ConfigMap/streaming/flink-sql-files`; 14 workload images checked of 42 live workloads, 28 skipped |
| L5 | `kubectl get networkpolicy -A --no-headers \| wc -l`; `kubectl get clusterrolebinding` count | 25 NetworkPolicies, 83 ClusterRoleBindings exist; whether each is Argo-tracked or upstream was **not verified** |

---

## 3. Gaps against the acceptance criteria

| # | Gap | Why it matters |
|---|---|---|
| G1 | **Transient drift is invisible.** `selfHeal` corrects tracked resources within the reconciliation window, and `drift-live` is a point-in-time snapshot with no history; an unauthorized edit that was healed leaves no retained record | criterion 2 and 5: "material drift detected" is only true if someone runs the check during the window |
| G2 | **No alerting or schedule.** No CronJob/CI job runs `drift-live` (the Makefile is the only caller); `argocd-notifications-cm` is empty (L3) | criterion 2 |
| G3 | **Untracked additions are not detected.** `prune` and `OutOfSync` only concern resources that belong to an Application; a resource created by hand in a workload namespace is an "orphaned resource", which ArgoCD can warn about only if the AppProject enables `orphanedResources` [S3]; the live AppProject setting was **not verified** | criteria 2/3 |
| G4 | **Scope limits.** RBAC, NetworkPolicy, Service exposure and ConfigMap/Secret content are outside `drift-live` coverage (2.2); 28 of 42 live workloads, including every operator, ArgoCD and the base add-ons installed by the bootstrap script, are skipped (L4) | the issue names exactly these (Helm values, manifests, RBAC, NetworkPolicy, service exposure, critical runtime settings) |
| G5 | **Generated state is only partly distinguishable.** Credentials and derived Secrets are never compared (by design); `expected` is reserved but never emitted, so generated and unauthorized changes of unchecked kinds are not told apart | criterion 3 |
| G6 | **No reconciliation / break-glass procedure.** Whether unauthorized drift is alerted only, healed by `selfHeal` (already on) or needs a recorded exception is undecided; the documented way to pause is not in the pages read | criterion 4 |
| G7 | **Release preflight covers Git, not the cluster.** The static gates stop prohibited changes in Git; nothing compares the cluster to the release before or after a promotion | the last requirement of the issue |
| G8 | **Operators and bootstrap-installed components sit outside GitOps** (see [upgrade procedures](upgrade-rollback-procedures.md) 2.1): their drift cannot be detected by ArgoCD at all | scope of "authoritative sources" |

---

## 4. Proposal (all **Proposed**)

### 4.1 Drift classification

| Class | Definition | Examples | Response |
|---|---|---|---|
| expected | generated or defaulted by design | derived Secrets, cert-manager/CNPG-generated Secrets, API-server defaults on the ignored StatefulSet fields | none; the exception list stays in `configuration-sources.md` |
| tolerated | operationally accepted, bounded | hook Jobs without sync status (L4), Progressing/Degraded health | report only |
| unauthorized | anything else that differs from Git | edited Deployment image, extra Service/RoleBinding/NetworkPolicy change, deleted policy | alert, then reconcile or record a break-glass exception |

Proposal: make `expected` real by emitting it for the documented exception list, so reviewers can tell generated from unauthorized without reading prose.

### 4.2 Detection layers

1. **Continuous (ArgoCD):** export `argocd_app_info{sync_status,health_status}` [S2] and alert when an Application is not `Synced` for longer than a few reconcile periods; requires the metrics stack (see [monitoring coverage](monitoring-alerting-coverage.md) T1).
2. **Event record:** ArgoCD notifications (trigger on sync status change) to a log or channel, so healed drift leaves a record (G1). Service/channel is an **Owner decision**.
3. **Scheduled snapshot:** run `drift-live --out` from a scheduler with read-only RBAC (in-cluster CronJob or an operator host), keep the JSON artifacts.
4. **Orphan detection:** enable `orphanedResources: {warn: true}` on the AppProject [S3], then include "orphaned" in the report (G3).
5. **Coverage extension (small steps):** add NetworkPolicy, Service type/ports, RoleBinding/ClusterRoleBinding subjects, and selected ConfigMap keys (never Secret values) to `drift-live`; operators compared against `VERSIONS.md` pins (G4, G8).

### 4.3 Reconciliation and break-glass

| Situation | Procedure (**Proposed**) |
|---|---|
| Unauthorized drift found | default is `selfHeal` reverting; the operator confirms with `make drift-live`, then records the finding |
| Deliberate emergency live change | open a break-glass record first (who, what, why, expiry), pause automated sync for that Application using the documented ArgoCD mechanism (**confirm the exact command in the official docs before writing the runbook**; the auto-sync page read did not state it), make the change, **commit the same change to Git**, re-enable sync, run `drift-live` |
| Fix committed but not pushed | treated as drift on the next sync (known failure, `mistakes-log.md:63`); the runbook checks `git ls-remote` equals the expected revision, as `drift-live` already requires |
| Rollback | revert in Git; ArgoCD does not allow its `rollback` command on an Application with automated sync [S1] |

### 4.4 Evidence retention

Keep every scheduled JSON report plus the break-glass records for a period chosen by the owner, as CI artifacts or in an operations repository; the schema is already deterministic. Link the retention rule to the data-lifecycle and release-evidence practices. Period: **Owner decision**.

### 4.5 Release preflight

Before promotion run: `make validate`, `make drift-live` (with `--expect-revision` = the release commit); fail the promotion on exit 1 or 2. After promotion repeat. Prohibited-change rules stay in the static gates; add rules only where a live-only property exists (e.g. selfHeal disabled on an Application).

---

## 5. Verification and test ideas

| Test | Acceptance signal |
|---|---|
| Image drift: set a Deployment image by hand with `selfHeal` paused in the lab | `drift-live` exit 1 with an `image` finding; healing removes it |
| Unauthorized NetworkPolicy edit | once coverage is extended, an `unauthorized` finding; before that, the missing coverage is documented as the test's expected failure |
| Orphan: create a Service by hand | AppProject warning appears [S3] and is reported |
| Healed-drift record | an event/notification exists after `selfHeal` reverts a manual edit |
| Break-glass dry run | record, pause, change, commit, resume, clean `drift-live` |
| Report determinism | two runs on an unchanged cluster produce byte-identical JSON apart from the timestamp field (check the existing schema) |

---

## 6. Owner decisions remaining

| # | Decision | Recommendation (basis) |
|---|---|---|
| D1 | Enforcement mode: alert only vs `selfHeal` (current) | Keep `selfHeal` on; add alerts and records so healing is not silent (G1) |
| D2 | Break-glass: who may approve, maximum duration | Single owner approval, short expiry, mandatory Git commit afterwards |
| D3 | Scheduler location (in-cluster CronJob vs operator host) | In-cluster read-only CronJob with a minimal ServiceAccount; the lab CI cannot reach the cluster (not verified) |
| D4 | Retention period for drift evidence | Align with the release-evidence retention |
| D5 | Notification channel | needs owner input (L3) |
| D6 | Bring operators/bootstrap components under drift checks | Pin comparison against `VERSIONS.md` first (G8) |

---

## 7. Follow-up implementation tasks (ordered, small)

| # | Task | Acceptance test idea |
|---|---|---|
| T1 | Emit `expected` for the documented exception list in `check-live-drift.py` | unit test with a derived Secret fixture |
| T2 | Scheduled `drift-live --out` with read-only RBAC | two timestamped reports exist |
| T3 | Enable `orphanedResources.warn` and surface it | hand-made Service appears in the report |
| T4 | ArgoCD notification on sync-status change | a manual edit leaves a notification record |
| T5 | Extend coverage: NetworkPolicy, Service, RoleBindings | unit test per kind; live run shows 0 unauthorized |
| T6 | Break-glass runbook (after confirming the documented ArgoCD pause command) | dry run recorded |
| T7 | Release-preflight wrapper (`validate` + `drift-live`) | fails on exit 1/2 |

---

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | ArgoCD automated sync policy: https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/ |
| S2 | ArgoCD metrics (`argocd_app_info`): https://argo-cd.readthedocs.io/en/stable/operator-manual/metrics/ |
| S3 | ArgoCD orphaned resources monitoring: https://argo-cd.readthedocs.io/en/stable/user-guide/orphaned-resources/ |
| S4 | ArgoCD diffing customization (`ignoreDifferences`): https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/ |
