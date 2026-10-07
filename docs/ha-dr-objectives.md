# HA and Disaster-Recovery Objectives (Proposal)

English | [한국어](ha-dr-objectives-ko.md)

Refs [Issue #5](https://github.com/dasomel/beluga/issues/5) ("Establish HA and disaster-recovery objectives for the data platform").

> **Status: PROPOSAL. Documentation only.** No manifest, values file, script or backup schedule is changed. Repository
> statements carry a `file:line` read at the commit this document was written against. Live statements come from read-only
> `kubectl` commands run on 2026-10-07 (~14:07 UTC) and are labelled **L#**; unmeasured items are **not verified live**. External
> statements cite an official page `[S#]` (accessed 2026-10-07) or say **no official recommendation**. **RPO, RTO and
> availability targets are Owner decisions**: this document gives options and the basis for each, never a target as a fact.

Related: [environment profiles](environment-profiles.md) (the production-style profile that would carry the HA settings),
[data lifecycle policy](data-lifecycle-policy.md) (retention of the data being protected).

---

## 1. Purpose and issue mapping

| Issue #5 acceptance criterion | Where addressed |
|---|---|
| RPO/RTO targets documented | Section 4.2 (options per tier, **Owner decision**) |
| Production profile has no unintended single-instance critical datastore | Sections 2, 4.3 |
| PostgreSQL failover demonstrated | Section 5 (not executed here) |
| Kafka keeps operating after loss of an eligible broker | Sections 4.3, 5 (not executed here) |
| Backup and restore demonstrated from a clean cluster | Sections 4.4, 5 (not executed here) |
| Recovery verification repeatable in `tests/` or documented | Section 5, task T4 |

The README states the project is personal/learning-scale and does not claim production readiness ([`README.md:7`](../README.md#L7), [`:16`](../README.md#L16)); the current layout is therefore the **non-production profile** the issue asks to keep.

---

## 2. Current state (verified)

### 2.1 Repository and live, side by side

| Component | Repository | Live (L1, read-only) | Failure domain observed |
|---|---|---|---|
| PostgreSQL (CNPG 1.30.0, PG 17.6) | `instances: 1`, 5Gi ([`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7), [`:17`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L17)) | 1 pod on `worker-2`; PVC `local-path` on `worker-2`; PDB min 1 / allowed disruptions 0 | one node |
| SeaweedFS (S3) | `replicas: 1`, 5Gi ([`01-seaweedfs.yaml:49`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L49), [`:191`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L191)) | 1 pod; PV on `master-1` (the control-plane node) | one node |
| Kafka (Strimzi, Kafka 4.3.0, KRaft) | `KafkaNodePool` replicas from values (`strimzi.replicas: 3`), roles controller+broker, 5Gi JBOD, `deleteClaim: false`; offsets/transaction/default replication factor 1, transaction min ISR 1, no `min.insync.replicas` ([`values.yaml:25`](../gitops/charts/beluga-data/values.yaml#L25), [`03-strimzi-kafka.yaml:25-31`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L25-L31), [`:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104)) | 3 nodes; PVs: broker 0 and 2 on `worker-3`, broker 1 on `master-1`; PDB min 2 / allowed 1; no `KafkaTopic` objects (topics created by the broker default, topic-level RF **not verified live**); Strimzi `Warning KafkaMinInsyncReplicas` | broker 0 and 2 share one node |
| Flink (operator 1.15.0, Flink 1.20.0) | session cluster, one JobManager, no HA or checkpoint-directory keys ([`05-flink-operator.yaml:10-20`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L10-L20)) | live config shows only `execution.checkpointing.mode/interval`; 3 jobs running, started 10:19 UTC today | JobManager pod |
| Trino | coordinator `replicas: 1`; worker `replicas: 1` only when `trino.workerEnabled` (default `false`) ([`06-trino.yaml:235`](../gitops/charts/beluga-data/templates/06-trino.yaml#L235), [`:413`](../gitops/charts/beluga-data/templates/06-trino.yaml#L413), [`:436`](../gitops/charts/beluga-data/templates/06-trino.yaml#L436), [`values.yaml:74`](../gitops/charts/beluga-data/values.yaml#L74)) | coordinator 1/1 and worker 1/1 both present (differs from the chart default; why was not investigated) | single coordinator |
| Others | Lakekeeper, Keycloak, OpenFGA, OPA, OpenLDAP, APISIX, ArgoCD, Superset, Airflow, OpenMetadata | all 1 replica (L1); OpenLDAP PVs on `master-1`; APISIX etcd 1 replica on `worker-2` | per component |
| Control plane | one server node `master-1` | 1 control-plane node (L2); k3s datastore type **not verified live** | single control plane |
| Storage class | `local-path` only, reclaim `Delete` | PV node affinity pins every volume to one node (L3) | node loss = volume loss |

### 2.2 Backup state

| Fact | Evidence |
|---|---|
| CNPG backs up with in-tree `barmanObjectStore` to `s3://beluga-postgres-backups/` on the **same cluster's SeaweedFS** (itself a single replica on `master-1`), WAL gzip, `retentionPolicy: 30d`, daily 02:00 UTC | [`02-cnpg.yaml:57-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L71), [`:81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L81) |
| **Live: neither scheduled backup completed.** `postgres-main-backup-20261005020000` started 2026-10-05T02:00:00Z and was marked `failed` at 2026-10-07T02:08:09Z; the second `Backup` object was created 2026-10-07T02:09:09Z (its name still says 20261006) and was marked `failed` at 09:58:43Z. Both carry the error "instance manager was restarted during backup", have no `startedAt`/`stoppedAt`, and sat unfinished for about 2 days and about 7h50m: the backups **hung**, and the restart only ended them (the restarts, probably VM restarts, were not investigated). `lastSuccessfulBackup` and `firstRecoverabilityPoint` are empty (L4). **Verified cause of the broken recovery chain:** the cluster condition `ContinuousArchiving` is `False` since 2026-10-04T07:19:43Z ("unexpected failure invoking barman-cloud-wal-archive: exit status 4"), and the instance log repeats `barman-cloud-check-wal-archive ... ERROR ... An error occurred (AccessDenied) when calling the CreateBucket operation: Access Denied` (766 matching lines in the last 5000 log lines). WAL archiving has therefore failed since bootstrap. CNPG states object-store backups always require WAL archiving [S1]. That the hang is caused by the failing archive is a **hypothesis** (not confirmed read-only) | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; `kubectl -n database get cluster postgres-main -o json` (status.conditions); `kubectl -n database logs postgres-main-1 --tail=5000 \| grep -c AccessDenied` |
| The repository never creates the bucket `beluga-postgres-backups` (the only references are the destination path and the S3 identity `postgres-backup-service`, whose actions are `Read/Write/List/Tagging` on that bucket, with no bucket-level create right). The comment claiming these rights suffice for barman-cloud is contradicted by the live `CreateBucket` AccessDenied; whether the bucket exists was **not verified** (the error is consistent with it not existing, an inference about barman-cloud behaviour) | [`01-seaweedfs.yaml:5-7`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L5-L7), [`:35-37`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L35-L37), [`02-cnpg.yaml:57-59`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L59) |
| CNPG needs a physical base backup for recovery; a WAL archive alone is not recoverable [S1]. So no recovery point exists today | [S1] |
| **Verified from [S1]:** the in-tree `barmanObjectStore` backup is "deprecated from 1.26 in favor of the Barman Cloud Plugin, but still the default for backward compatibility", and native backup/recovery is being progressively phased out of the core operator in favour of CNPG-I plugins; `spec.backup.retentionPolicy` is deprecated as well. The repository uses both (CNPG 1.30.0) | [`02-cnpg.yaml:57`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57), [`:71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L71) |
| No Kubernetes-resource backup tool exists ("no Velero in Beluga"); declarative state is in Git, but bootstrap-generated credentials are not (random per bootstrap) | [`portfolio-integration-matrix.md:80`](portfolio-integration-matrix.md#L80), [`01-argocd-bootstrap.sh:52`](../scripts/gitops/01-argocd-bootstrap.sh#L52) |
| Kafka, SeaweedFS (Iceberg data), OpenLDAP, Keycloak realm (via DB) have no backup declared in the repository | search of `gitops/`: only the CNPG backup resources |

### 2.3 Live measurements (read-only, 2026-10-07)

| # | Command | Result |
|---|---|---|
| L1 | `kubectl get deploy,sts -A`; `kubectl get pdb -A` | all Beluga workloads 1 replica; PDBs: `postgres-main-primary` (min 1, allowed 0), `beluga-kafka-kafka` (min 2, allowed 1), entity operator (allowed 1) |
| L2 | `kubectl get nodes` | 4 nodes, one control-plane |
| L3 | `kubectl get pv -o json`, `kubectl get sc` | node affinity per PV: Postgres `worker-2`; SeaweedFS, Kafka-1, OpenLDAP data/config `master-1`; Kafka-0 and Kafka-2 `worker-3`; APISIX etcd `worker-2`; reclaim `Delete` |
| L4 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; `get scheduledbackups`; cluster `status.conditions`; `logs postgres-main-1` | 2 `Backup` objects, both `failed` after hanging (see 2.2); `ContinuousArchiving=False` since 2026-10-04T07:19:43Z with `AccessDenied ... CreateBucket`; `ScheduledBackup` `0 0 2 * * *`, last scheduled 2026-10-06T02:00Z |
| L5 | `kubectl -n streaming get kafka`, `kafkanodepool` | 3 nodes `[controller, broker]`; Warning `KafkaMinInsyncReplicas`; config RF 1 |
| L6 | Flink REST via API-server proxy (GET) | no HA/checkpoint-directory keys |

---

## 3. Gaps against the acceptance criteria

| Criterion | Status | Gap |
|---|---|---|
| RPO/RTO documented | **Open** | none defined |
| No unintended single-instance critical datastore in a production profile | **Open** | no production-style HA values exist; every datastore is one instance (2.1) |
| PostgreSQL failover demonstrated | **Open** | `instances: 1`; no failover possible |
| Kafka survives loss of an eligible broker | **Open** | 3 brokers but RF 1: any broker loss makes its partitions unavailable; brokers 0 and 2 share a node (L3), so one node loss removes two of three controllers/brokers |
| Backup/restore from a clean cluster | **Open, blocked** | the only backup path is failing (L4) and its target is a singleton on the control-plane node |
| Repeatable recovery verification | **Open** | none |

---

## 4. Proposal (all **Proposed**)

### 4.1 Two profiles

Keep the current layout as the **learning profile** (no HA, documented RPO "best effort"). Add a **production-style HA profile** as a Helm values layer (mechanism and file name follow the environment-profiles proposal). It must not be required on laptops.

### 4.2 RPO/RTO and availability options (**Owner decision**)

**No official recommendation** exists for numeric targets; they follow business need. Options by tier:

| Tier | Stores | Option A (learning) | Option B (HA profile) | Basis |
|---|---|---|---|---|
| T1 relational | PostgreSQL (shop, `beluga_meta`, Keycloak/Lakekeeper/Airflow/OpenFGA metadata) | RPO = last successful backup (daily), RTO = manual restore | RPO near WAL-archive interval, RTO = automated failover | CNPG states an out-of-the-box RPO <= 5 minutes with WAL archiving, even across regions [S1]; failover is immediate by default (`failoverDelay` 0) and may impact RTO/RPO [S2]. Both hold only after a base backup exists (L4) |
| T2 event log | Kafka | RPO = unreplicated data may be lost | RPO 0 for acknowledged writes (`acks=all`, RF 3, `min.insync.replicas` 2) | Kafka's documented durability pattern: RF 3, min ISR 2, `acks=all` [S3]; note [S3] is the Kafka **4.1** page while the deployed version is 4.3.0 ([`VERSIONS.md:28`](../VERSIONS.md#L28)), so confirm the text on the 4.3 page before adopting |
| T3 lake data | SeaweedFS (Iceberg files, backup target) | single copy | replicated volumes or an external S2 target | replication modes of the pinned SeaweedFS version were **not verified** in this lane |
| T4 processing state | Flink jobs | rebuild from Kafka offsets | Kubernetes HA + checkpoint/savepoint directory on durable storage | Flink: without HA a JobManager failure fails running programs; HA persists JobGraphs and completed checkpoints [S4] |
| T5 control/identity | ArgoCD, Keycloak, OpenLDAP, APISIX, Lakekeeper | restore from Git + DB | 2+ replicas where the component supports it | per-component support **not verified** |

### 4.3 HA profile content (what must change; none done here)

| Component | Proposed setting | Note |
|---|---|---|
| CNPG | `instances` 2 or 3, anti-affinity across nodes, backup target outside the failure domain | instance count: **no official recommendation** retrieved; owner chooses by cost |
| Kafka | RF 3 for offsets/transaction/default topics, transaction min ISR 2, `min.insync.replicas` 2; spread brokers across nodes (today two share `worker-3`); explicit `KafkaTopic` with RF | requires >= 3 brokers (present); controller-quorum arithmetic **not verified in official docs here** |
| SeaweedFS | replicated or multi-instance topology | needs a version-specific doc read first |
| Trino | enable the worker by default in this profile; coordinator single pod stays a known SPOF unless a second is verified | not verified |
| Flink | `high-availability.type` kubernetes and `high-availability.storageDir`; checkpoint directory on S2 [S4] | enables `last-state`/`savepoint` upgrades [S5] |
| Control plane | 3 server nodes (HA k3s) or accept SPOF | k3s HA mode **not verified here** |
| Storage | node-pinned `local-path` cannot survive node loss; replicated storage class or application-level replication | owner decision |

### 4.4 Backups and restore

1. Fix the failing backup first (T1); then verify a recoverability point.
2. Put the backup target outside the primary failure domain (second S3 endpoint or off-cluster), because today a SeaweedFS-node loss takes primary data and backups together (2.2).
3. Restore model: CNPG recovery creates a **new** cluster from `bootstrap.recovery`, optionally to a `targetTime` [S6]; it is not in-place.
4. Kubernetes resources: Git is the backup for declared state. Generated credentials are not in Git, so the DR design needs a secret-escrow or regeneration policy (**Owner decision**; ADR-0002 documents the random bootstrap generation).
5. Kafka/Iceberg data: backup approach not defined; decide whether Kafka is a replayable source (CDC re-snapshot) or needs MirrorMaker/backup.
6. DR runbook `docs/runbooks/disaster-recovery.md`: order = control plane, ArgoCD + secrets, CNPG restore, SeaweedFS, Kafka, Lakekeeper catalog, Flink resubmit, verification.

---

## 5. Verification and test ideas

| Test | Acceptance signal |
|---|---|
| Backup freshness probe (read-only) | exits non-zero when `lastSuccessfulBackup` is empty or older than the chosen RPO |
| Restore drill `tests/19-restore-verify.sh` (lab) | recover into a scratch namespace from the object store; row counts in `shop` equal the source at the recovery point |
| PostgreSQL failover (HA profile) | delete the primary pod; a replica is promoted; measured outage recorded as RTO evidence |
| Kafka broker loss (HA profile) | stop one broker; produce and consume with `acks=all` still succeed |
| Flink JobManager loss (HA profile) | job resumes from the last checkpoint without resubmission |
| Clean-cluster DR | rebuild from Git plus restored credentials and the CNPG backup, then `tests/run-all.sh` |

Drills run on a rehearsal cluster only; none was run here.

---

## 6. Owner decisions remaining

| # | Decision | Recommendation (basis) |
|---|---|---|
| D1 | RPO/RTO per tier | Start with Option A for the learning profile and write Option B as the production target once D2 is set |
| D2 | Required availability (planned hours, single-site vs multi-site) | Single site first; no official numeric recommendation |
| D3 | PostgreSQL instance count (2 vs 3) | 3 gives a replica while one is rebuilt; confirm against capacity |
| D4 | Backup target location | Off the primary failure domain (2.2) |
| D5 | Credential escrow vs regeneration | Escrow the root credentials secret; regeneration breaks restored DB roles (inference, test in the drill) |
| D6 | Kafka as replayable source vs backed-up store | Replayable for CDC, back up only non-replayable topics |
| D7 | HA control plane | Defer; document as accepted risk |

---

## 7. Follow-up implementation tasks (ordered, small)

| # | Task | Acceptance test idea |
|---|---|---|
| T1 | Diagnose and fix the hanging CNPG backups and failing WAL archiving. Diagnosis order (read-only first): (1) does bucket `beluga-postgres-backups` exist and which S3 identity may create it; (2) is the `postgres-backup-s3-credential` Secret present and does its key pair match the `postgres-backup-service` identity (check presence and key names only, never read values); (3) network path: the `AccessDenied` reply shows the endpoint is reachable and answering, so this is unlikely the cause (the `database` namespace has no NetworkPolicy; `storage` has `default-deny-all`, `allow-cluster-dns` and `seaweedfs-data-plane-restrict`, effect not verified); (4) SeaweedFS S3 endpoint health and its identity configuration; (5) why a base backup hangs instead of failing | a `completed` Backup, `ContinuousArchiving=True` and a set `firstRecoverabilityPoint` |
| T2 | Read-only backup-freshness check in `scripts/ops/` | fails in the current state (L4) |
| T3 | Migrate from in-tree `barmanObjectStore`/`retentionPolicy`, deprecated since 1.26 [S1], to the Barman Cloud Plugin (or record an owner decision to stay), and update `check-postgres-backup-config.py` | the static check and a restore drill pass with the new mechanism |
| T4 | Restore drill script (scratch namespace) | row count equality |
| T5 | HA values layer for CNPG and Kafka (RF 3, min ISR 2, anti-affinity) | `helm template` renders; failover/broker-loss drills pass |
| T6 | Flink HA and checkpoint directory | JobManager deletion keeps the jobs |
| T7 | DR runbook and secrets decision (D5) | clean-cluster rebuild evidence |

---

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | CloudNativePG 1.30 backup: https://cloudnative-pg.io/docs/1.30/backup |
| S2 | CloudNativePG 1.30 failover: https://cloudnative-pg.io/docs/1.30/failover |
| S3 | Apache Kafka 4.1 topic configs (`min.insync.replicas`): https://kafka.apache.org/41/configuration/topic-configs/ |
| S4 | Flink 1.20 HA overview: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/overview/ |
| S5 | Flink Kubernetes Operator 1.15 job management: https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.15/docs/custom-resource/job-management/ |
| S6 | CloudNativePG 1.30 recovery: https://cloudnative-pg.io/docs/1.30/recovery |
