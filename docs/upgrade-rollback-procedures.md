# Upgrade, Rollback, Compatibility and Maintenance Procedures (Proposal)

English | [한국어](upgrade-rollback-procedures-ko.md)

Refs [Issue #13](https://github.com/dasomel/beluga/issues/13) ("Define upgrade, rollback, compatibility, and maintenance procedures").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed. Repository
> statements carry a `file:line` read at the commit this document was written against. Live-cluster statements come from
> read-only `kubectl get` commands run on 2026-10-07 (~14:07 UTC) and are labelled **L#**; anything not measured is labelled
> **not verified live**. External statements cite an official page `[S#]` (accessed 2026-10-07) or say **no official
> recommendation**. Items marked **Proposed** or **Owner decision** have no basis in the repository.

---

## 1. Purpose and issue mapping

| Issue #13 acceptance criterion | Where addressed |
|---|---|
| Supported upgrade path is documented | Section 4.1 (proposed order), section 2.1 (how versions are pinned today) |
| One representative upgrade and rollback tested from a clean environment | Section 4.6 (rehearsal design); not executed here |
| Data compatibility checked before stateful upgrades | Section 4.2 (pre-upgrade gates) |
| Recovery from a failed upgrade demonstrated | Section 4.4, section 5 (not executed here) |
| Service impact and maintenance procedure documented | Section 4.3, section 4.5 |
| Compatibility matrix maintained with every release | Section 4.7 |

---

## 2. Current state (verified)

### 2.1 How versions are pinned and changed today

| Fact | Evidence |
|---|---|
| `VERSIONS.md` is the single source for component and image versions | [`VERSIONS.md:1-5`](../VERSIONS.md) (rows: [`:14-20`](../VERSIONS.md#L14-L20) platform, [`:28`](../VERSIONS.md#L28) Strimzi) |
| `make validate` runs a drift check between `VERSIONS.md` and rendered images (two chart combinations); operator versions are checked against the pins in the bootstrap script | [`Makefile:64`](../Makefile#L64), [`check-version-consistency.py:18-22`](../scripts/ci/check-version-consistency.py#L18-L22), [`:150`](../scripts/ci/check-version-consistency.py#L150) |
| Operators and base add-ons are **not** ArgoCD Applications: the bootstrap script applies ArgoCD v3.5.0 (`:23`), cert-manager 1.21.1 (`:299`), CNPG 1.30.0 (`:306`), Strimzi 1.1.0 (`:313`) with `kubectl apply`, and the Flink operator with `helm upgrade --install` 1.15.0 (`:320-322`). Downloads are SHA-256 locked | [`01-argocd-bootstrap.sh:23-24`](../scripts/gitops/01-argocd-bootstrap.sh#L23-L24), [`:299-300`](../scripts/gitops/01-argocd-bootstrap.sh#L299-L300), [`:306-307`](../scripts/gitops/01-argocd-bootstrap.sh#L306-L307), [`:313`](../scripts/gitops/01-argocd-bootstrap.sh#L313), [`:320-322`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L322), [`upstream-artifacts.sha256`](../configs/upstream-artifacts.sha256) |
| k3s is installed from a **channel** (`INSTALL_K3S_CHANNEL=v${K8S_VERSION}`, `K8S_VERSION=1.36`), i.e. the patch level is whatever the channel serves at install time; no upgrade script exists in `scripts/cluster/` | [`cluster.env:21`](../configs/cluster.env#L21), [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32), [`:61`](../scripts/cluster/02-k8s-init.sh#L61) |
| Workload charts (`beluga-platform`, `beluga-data`) are deployed by ArgoCD with `automated: {prune: true, selfHeal: true}` at `targetRevision: HEAD` | [`beluga-data.yaml:10`](../gitops/apps/beluga-data.yaml#L10), [`:20-26`](../gitops/apps/beluga-data.yaml#L20-L26) |
| Known incompatibility is recorded only as free text in `VERSIONS.md` notes (e.g. Strimzi 0.45 is "incompatible with K8s 1.36", measured; APISIX Ingress Controller 2.x and etcd 3.5 held back). There is no structured matrix | [`VERSIONS.md:28`](../VERSIONS.md#L28), [`:48-49`](../VERSIONS.md#L48-L49) |
| The bootstrap-rerun upgrade path swallows failures: `kubectl apply ... cnpg.yaml \|\| true` (and the same `\|\| true` on the Strimzi apply, the Flink operator `helm upgrade`, and the final chart `helm template \| kubectl apply`), so a failed operator upgrade can look successful; any rerun must check each step's result explicitly | [`01-argocd-bootstrap.sh:307`](../scripts/gitops/01-argocd-bootstrap.sh#L307), [`:315`](../scripts/gitops/01-argocd-bootstrap.sh#L315), [`:325`](../scripts/gitops/01-argocd-bootstrap.sh#L325), [`:346`](../scripts/gitops/01-argocd-bootstrap.sh#L346), [`:361`](../scripts/gitops/01-argocd-bootstrap.sh#L361) |
| No upgrade rehearsal or rollback test exists under `tests/` (listing of `tests/` at this commit: 01-18 functional/render checks only) | [`tests/run-all.sh:12-29`](../tests/run-all.sh#L12-L29) |
| No Kubernetes-resource backup tool is planned ("no Velero in Beluga"); CNPG barman to SeaweedFS is the only backup | [`portfolio-integration-matrix.md:80`](portfolio-integration-matrix.md#L80), [`02-cnpg.yaml:57-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L71) |

### 2.2 Lifecycle gotchas already recorded in the mistakes log (relevant to every upgrade)

| # | Gotcha | Evidence | Consequence for an upgrade |
|---|---|---|---|
| G1 | Flink SQL jobs are submitted by an ArgoCD **Sync hook** Job (`flink-sql-submit`, `backoffLimit: 10`), not by a controller. After a restart the jobs are only resubmitted when a sync runs the hook. CI never executes hooks, so a hook failure (e.g. the `drop ALL` + root `curl` failure) is invisible before merge | [`14-flink-jobs.yaml:27-31`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L27-L31), [`mistakes-log.md:86`](mistakes-log.md#L86), [`:88`](mistakes-log.md#L88) |
| G2 | The Flink session cluster has no HA and no checkpoint directory configured (only `execution.checkpointing.interval/mode`); live config confirms (L5). Flink documents that without HA a JobManager crash makes running programs fail [S7] | [`05-flink-operator.yaml:10-14`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L10-L14) |
| G3 | Cached dependencies hide egress/identity gaps: Lakekeeper ran 5 hours on an in-memory JWKS cache and failed only after a pod restart (default-deny egress did not allow the gateway) | [`mistakes-log.md:88`](mistakes-log.md#L88) |
| G4 | init containers must be re-runnable: Trino `keytool -importcert` failed on a second run in the same pod after a node restart | [`mistakes-log.md:85`](mistakes-log.md#L85) |
| G5 | `selfHeal: true` silently reverts live edits and any fix that was committed but not pushed; an operation stuck on an old hook revision can pin an Application | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:53`](mistakes-log.md#L53), [`:63`](mistakes-log.md#L63) |

### 2.3 Live measurements (read-only, 2026-10-07)

| # | Command (`KUBECONFIG` set to the lab kubeconfig) | Result |
|---|---|---|
| L1 | `kubectl get nodes -o wide` | 4 nodes (1 control-plane `master-1`, 3 workers), all `Ready`, `v1.36.5+k3s1`, 3d6h old |
| L2 | `kubectl -n argocd get applications` | `beluga-root`, `beluga-platform`, `beluga-data`: Synced/Healthy at revision `9f74c2be...` **as of the measurement (2026-10-07 ~14:07 UTC)**, which equalled `origin/main` then; `origin/main` has moved since (the current head is a later commit), so do not read this revision as current; only 3 Applications exist, so no operator is Argo-managed |
| L3 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`, cluster `status.conditions`, `logs postgres-main-1` | Two `Backup` objects (first started 2026-10-05T02:00:00Z, second created 2026-10-07T02:09:09Z) both ended `failed` only when the instance manager restarted (2026-10-07T02:08:09Z and 09:58:43Z, probably VM restarts, not investigated) after sitting unfinished for about 2 days and about 7h50m with no `startedAt`/`stoppedAt`: the backups **hung**. `lastSuccessfulBackup` and `firstRecoverabilityPoint` are empty. `ContinuousArchiving=False` since 2026-10-04T07:19:43Z with `barman-cloud-check-wal-archive ... AccessDenied ... CreateBucket` in the log (details: [HA/DR objectives](ha-dr-objectives.md) section 2.2) |
| L4 | `kubectl get pdb -A` | `postgres-main-primary` min 1 / allowed disruptions 0; `beluga-kafka-kafka` min 2 / allowed 1; `beluga-kafka-entity-operator` allowed 1; no other PDB |
| L5 | `kubectl get --raw .../flink-cluster-rest:8081/proxy/jobs/overview` and `/jobmanager/config` (GET through the API server) | 3 jobs `RUNNING` (`beluga-cdc_orders`, `beluga-cdc_customers`, `beluga-events_sessionization`), all started 2026-10-07 10:19 UTC although the cluster is 3 days old; the config keys matching `high-availability`/`checkpoint`/`state` are only `execution.checkpointing.mode/interval`. The start time matches a restart of `postgres-main-1` ("2 restarts, last 4h8m ago") and is consistent with jobs being resubmitted after a VM restart (inference; the restart cause was not investigated) |
| L6 | `kubectl get sc` / `kubectl get pv` | Only `local-path`, reclaim policy `Delete`; every PV has node affinity to one node (Postgres `worker-2`; SeaweedFS and Kafka broker 1 `master-1`; Kafka brokers 0 and 2 both `worker-3`) |
| L7 | `make drift-live` (read-only) at the same revision | `PASS (no unauthorized drift)`: 0 expected, 15 tolerated (hook-created objects without sync status), 0 unauthorized; 14 images checked, 28 live workloads skipped (operators, ArgoCD itself, add-ons) |
| L8 | `kubectl get deploy,sts -A` (spec/ready replicas) | Every Beluga workload listed has 1 replica (Deployments and the `seaweedfs` / ArgoCD controller StatefulSets); only `cilium-operator` has 2. Kafka: `KafkaNodePool/mixed` has 3 nodes with roles controller+broker |

---

## 3. Gaps against the acceptance criteria

| Criterion | Status | Gap |
|---|---|---|
| Supported upgrade path documented | **Open** | Pins and checks exist (2.1) but no order, no per-component procedure, no supported version jumps. Operators/ArgoCD/k3s sit outside GitOps, so the upgrade path for them is "edit pin + lock + rerun bootstrap", which is not documented or tested (**not verified live**) |
| Clean-environment upgrade and rollback tested | **Open** | No rehearsal exists (2.1) |
| Data compatibility checked before stateful upgrades | **Open** | No pre-upgrade gate. The only Postgres recovery point today does not exist (L3), so a "backup checkpoint" cannot currently be satisfied |
| Recovery from failed upgrade demonstrated | **Open** | Nothing demonstrates it; rollback of auto-synced Applications is by Git, because ArgoCD does not allow `rollback` on an Application with automated sync [S3] |
| Impact and maintenance procedure documented | **Open** | No maintenance-window or impact statement exists |
| Matrix maintained every release | **Open** | Free-text notes only (2.1) |

---

## 4. Proposal (all **Proposed**)

### 4.1 Upgrade order

Rationale: infrastructure first, then controllers that own CRDs, then stateful stores, then identity, then the data path, then the
edge. Vendor documents give per-product ordering only (k3s servers before agents and no skipped minor versions [S1]; Kubernetes
control plane before kubelets [S2]; ArgoCD read per-minor upgrade notes [S3]; Strimzi Cluster Operator before the Kafka cluster [S5]; CNPG replicas before primary [S4]). **No official recommendation** was found for the cross-product order below; it is derived from the dependencies visible in the charts and is the owner's to confirm.

| Step | Components | Mechanism today | Rollback class |
|---|---|---|---|
| 0 | Preflight (4.2) | scripts to be written | n/a |
| 1 | k3s / Kubernetes (server, then agents; one minor at a time) | manual (no script) | **Snapshot restore only** [S1b] |
| 2 | Cilium, MetalLB, cert-manager | helm/bootstrap | CRD changes: forward-fix preferred |
| 3 | ArgoCD | bootstrap `kubectl apply --server-side --force-conflicts` [S3] | restore settings backup [S3] |
| 4 | CNPG, Strimzi, Flink operators (CRDs, then controllers) | bootstrap | operator image rollback only if CRD/schema unchanged (not verified) |
| 5 | Stateful: PostgreSQL minor (image tag), SeaweedFS, Kafka (Strimzi, then Kafka version, then metadata version) | Git (chart) | Postgres major and Kafka metadata version: **treat as irreversible** |
| 6 | OpenLDAP, Keycloak, OpenFGA, OPA | Git | DB-schema dependent (not verified) |
| 7 | Lakekeeper (has a `lakekeeper-migrate` Job), OpenMetadata, Airflow, Superset | Git | restore DB checkpoint |
| 8 | Trino, Flink runtime and connectors, Debezium | Git | `git revert` |
| 9 | APISIX, APISIX Ingress Controller | Git | `git revert` |

### 4.2 Pre-upgrade gates (read-only, scriptable)

1. `make validate` and `make drift-live` pass (the latter reports no unauthorized drift).
2. All three Applications `Synced/Healthy`; no hook Job in `Failed` (G1).
3. **Recovery point exists**: CNPG `status.lastSuccessfulBackup` is recent and `firstRecoverabilityPoint` is set. CNPG recovery needs a physical base backup; a WAL archive alone is not enough [S4b]. Today this gate fails (L3).
4. k3s datastore snapshot taken on the version being left (k3s rollback of a minor version needs a snapshot taken on the older minor [S1b]); datastore type is **not verified live**.
5. Compatibility check: the target versions appear in the lifecycle matrix (4.7) as supported, and the vendor release notes were read (ArgoCD, Strimzi, CNPG, Flink operator).
6. Stateful specifics: Kafka `min.insync.replicas` and topic replication known (L4/section 5), Flink job list and last checkpoint recorded (G2).

### 4.3 Maintenance windows and expected impact

Qualitative today; numeric windows are an owner decision. With the current singleton layout (L8: one replica for Postgres, SeaweedFS,
Trino coordinator, Keycloak, Lakekeeper, APISIX, Flink JobManager; Kafka has 3 brokers but replication factor 1) any restart of those workloads is a visible interruption, and `postgres-main-primary` allows 0 disruptions (L4), so a node drain stops at the PDB. An explicit window is therefore required for every step in 4.1 until an HA profile exists (see [HA/DR objectives](ha-dr-objectives.md)).

### 4.4 Rollback criteria and procedure

- **Trigger (Proposed):** any of: Application not `Healthy` after the agreed settle time; any hook Job `Failed`; `tests/run-all.sh` failing; `make drift-live` exit 1; data-path check failing (rows still flowing Kafka to Iceberg, Trino query returns).
- **Stateless/Git-managed:** `git revert` of the upgrade commit and push; then hard refresh. Not `argocd app rollback` [S3]. Confirm the push happened (G5).
- **Stateful with schema migration (Lakekeeper, Airflow, Superset, OpenMetadata, Keycloak):** whether the migration is reversible is **not verified**; rollback = restore the pre-upgrade database checkpoint, then revert the image.
- **PostgreSQL:** minor upgrade is an image-tag change with CNPG rolling update [S4a]; major upgrades are logical dump/restore, logical replication or offline `pg_upgrade`, and CNPG strongly recommends a full backup first and a new base backup afterwards [S4c].
- **Kafka:** metadata-version upgrade cannot be assumed reversible (**no official recommendation** retrieved here; Strimzi documents the version ordering [S5]).
- **Flink:** with no checkpoint directory, `last-state`/`savepoint` upgrade modes are not usable [S6]; a runtime upgrade means resubmitting jobs (data replay from Kafka offsets is the only recovery).

### 4.5 Post-upgrade checks (add to the runbook)

1. Re-run the three gotcha probes: every restarted pod passed readiness; hook Jobs `Complete`; Flink `jobs/overview` shows all 3 jobs `RUNNING` (G1/G2).
2. Force the first dependency lookup after a pod restart (Lakekeeper JWKS fetch in logs) (G3).
3. `make drift-live`, then `bash tests/run-all.sh`.
4. A new CNPG base backup completes (gate 3 again).

### 4.6 Clean-cluster rehearsal (design only)

Provision a clean cluster at the previous tagged release, load the demo data, take a CNPG backup, apply the upgrade step by step from 4.1 through Git, run 4.5, then roll back using 4.4 and run 4.5 again; record timings (they become the numbers for 4.3). Provisioning uses the existing Vagrant flow; **not run in this lane**.

### 4.7 Lifecycle matrix

Proposed file `docs/lifecycle-matrix.md` (+ `-ko`): per component the current pin, the last tested pair, the supported upgrade jump, known-bad combinations with evidence, and rollback class. A new `make validate` check would compare its "current" column with `VERSIONS.md` (same pattern as `check-version-consistency.py`) so it cannot go stale.

---

## 5. Verification and test ideas

| Idea | Acceptance signal |
|---|---|
| `scripts/ops/preupgrade-check.sh` (read-only; JSON report) | exit non-zero while no recent CNPG recovery point exists (reproduces L3) |
| Matrix freshness check in `make validate` | fails when `VERSIONS.md` changes without a matrix row change |
| Rehearsal job (manual, documented) | upgrade and rollback each end with 4.5 green |
| Fault drill: delete the Flink JobManager pod | documents job loss and the resubmission path (confirms G1/G2) |

---

## 6. Owner decisions remaining

| # | Decision | Recommendation (basis) |
|---|---|---|
| D1 | Maintenance window length/frequency and tolerated outage per step | Start with an explicit announced window for every step while workloads are singletons (L4) |
| D2 | Supported version-jump policy | One minor version at a time for k3s and ArgoCD [S1][S3]; no official statement for the rest |
| D3 | Where the compatibility matrix lives | New `docs/lifecycle-matrix.md` with a validate check (4.7) |
| D4 | Rehearsal environment size and cadence | Per release, full 4-VM profile; cheaper alternatives need owner input |
| D5 | Should operators/ArgoCD move under GitOps | Defer; first document the bootstrap-rerun path |
| D6 | Pin the k3s patch version instead of the channel | Recommend pinning (reproducible rehearsal), owner to weigh patch-lag |
| D7 | Accept downtime for singleton stateful upgrades | Yes for the learning profile; revisit with the HA profile |

---

## 7. Follow-up implementation tasks (ordered, small)

| # | Task | Acceptance test idea |
|---|---|---|
| T1 | Make CNPG scheduled backups and WAL archiving succeed; start with the diagnosis steps in [HA/DR objectives](ha-dr-objectives.md) T1 (the backups hang, WAL archiving fails with `CreateBucket` AccessDenied) | `lastSuccessfulBackup` populated within 24 h |
| T2 | Add `docs/lifecycle-matrix.md` and validate check | check fails on a deliberate mismatch |
| T3 | Write `scripts/ops/preupgrade-check.sh` | fails on L3 state, passes after T1 |
| T4 | Write `scripts/ops/postupgrade-check.sh` (4.5) | detects a deleted Flink job |
| T5 | Pin k3s patch (D6) | node versions equal the pin |
| T6 | Rehearsal runbook with recorded timings | one upgrade+rollback evidence file |

---

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | k3s manual upgrade: https://docs.k3s.io/upgrades/manual (servers first, one at a time; do not skip minor versions) |
| S1b | k3s rollback: https://docs.k3s.io/upgrades/roll-back (needs a snapshot from the older version) |
| S2 | Kubernetes version skew policy: https://kubernetes.io/releases/version-skew-policy/ |
| S3 | ArgoCD upgrade overview https://argo-cd.readthedocs.io/en/stable/operator-manual/upgrading/overview/ ; automated sync https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/ ("Rollback cannot be performed against an application with automated sync enabled") |
| S4 | CloudNativePG 1.30: (a) rolling updates https://cloudnative-pg.io/docs/1.30/rolling_update ; (b) backup https://cloudnative-pg.io/docs/1.30/backup ; (c) PostgreSQL upgrades https://cloudnative-pg.io/docs/1.30/postgres_upgrades |
| S5 | Strimzi deploying guide, upgrades: https://strimzi.io/docs/operators/latest/deploying#assembly-upgrade-str |
| S6 | Flink Kubernetes Operator 1.15 job management: https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.15/docs/custom-resource/job-management/ |
| S7 | Flink 1.20 HA overview: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/overview/ |
