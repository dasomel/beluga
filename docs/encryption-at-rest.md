# Encryption at Rest and Key Management (Proposal)

English | [한국어](encryption-at-rest-ko.md)

Refs issue [#16](https://github.com/dasomel/beluga/issues/16) ("Define encryption-at-rest and key-management controls").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed by this
> document. Every statement about the repository carries a `file:line` read at commit `9f74c2b`. Every statement about
> the live cluster comes from a read-only `kubectl` command run on 2026-10-07 ([section 2.2](#22-live-state-measured-2026-10-07)) or is marked
> **not verified live**. External facts cite [Sources](#sources) (accessed 2026-10-07); where no official figure was found it says
> "no official recommendation". Items marked **Proposed** need an owner decision before they become policy.

Related: [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md) (retention and Object Lock for the backup bucket),
[`docs/privileged-access-inventory.md`](privileged-access-inventory.md) (credential sources), [`docs/environment-profiles.md`](environment-profiles.md) (secure profile),
[`docs/certificate-lifecycle.md`](certificate-lifecycle.md) (TLS keys, issue #47).

## 1. Purpose and issue mapping

Issue #16 asks for an at-rest protection mechanism for each protected data class (PostgreSQL, Kafka volumes, SeaweedFS data, Kubernetes Secrets, backups), a documented key lifecycle,
encrypted and access-controlled backups, repeatable rotation/revocation, and secure-profile verification. This document inventories what exists, records what could be measured, and proposes a layered model. It does not implement anything.

## 2. Current state (verified)

### 2.1 What the repository defines

| Data class | Fact | Source |
|---|---|---|
| PostgreSQL (all application databases: shop, lakekeeper, keycloak, openfga, openmetadata, `beluga_meta`) | CNPG PVC, 5Gi, default StorageClass: No encryption setting in the Cluster spec; instance count 1 | [`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7), [`:16-17`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L16-L17), [`:27-31`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L27-L31) |
| Kafka | 3 persistent-claim volumes of 5Gi (JBOD, `deleteClaim: false`): No at-rest setting | [`03-strimzi-kafka.yaml:25-31`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L25-L31) |
| SeaweedFS (lakehouse data, Postgres backups) | StatefulSet PVC 5Gi: Started as `weed server -s3 ... -dir=/data` with no `-encryptVolumeData` or SSE setting | [`01-seaweedfs.yaml:143-150`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L143-L150), [`:185-191`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L185-L191) |
| OpenLDAP, APISIX etcd | PVCs 2Gi/1Gi and 1Gi | [`openldap.yaml:55-74`](../gitops/charts/beluga-platform/templates/openldap.yaml#L55-L74), [`apisix-infra.yaml:10-19`](../gitops/charts/beluga-platform/templates/apisix-infra.yaml#L10-L19) |
| PostgreSQL backups | S3 bucket `beluga-postgres-backups` on the same SeaweedFS, over plain `http://`; gzip compression only; retention 30d; `barmanObjectStore`; no `encryption` field | [`02-cnpg.yaml:56-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L56-L71) |
| Backup credential scope | S3 identity limited to the backup bucket | [`01-seaweedfs.yaml:37`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L37) |
| Kubernetes Secrets | k3s server flags contain no `--secrets-encryption` | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| Node disks | VM box `dasomel/ubuntu-26.04-xfs` (filesystem choice only) | [`Vagrantfile:51`](../Vagrantfile#L51) |
| Data sensitivity declared | Registry classification values are `internal` and `pii`; columns such as `email`, `name` are `pii` | [`policies/data-standards.yaml:28`](../policies/data-standards.yaml#L28), [`:39`](../policies/data-standards.yaml#L39), [`:45-46`](../policies/data-standards.yaml#L45-L46) |
| PostgreSQL wire | `pg_hba` uses `host` (not `hostssl`) and the manifest comment accepts plaintext inside the cluster | [`02-cnpg.yaml:38`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L38), [`:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |

Searched `scripts/`, `Vagrantfile`, `gitops/`, `docs/*.md` (case-insensitive) for `secrets-encryption`, `encryption-provider`, `EncryptionConfiguration`, `luks`, `cryptsetup`, `dm-crypt`, `kms`:
**no match**. So the repository declares no at-rest encryption or key-management mechanism in those paths; it does not follow that none exists on a given host.

### 2.2 Live state (measured 2026-10-07)

| Measurement | Command | Result |
|---|---|---|
| StorageClass | `kubectl get sc` | single default `local-path` (`rancher.io/local-path`), reclaimPolicy `Delete`, no parameters: volumes are directories on the node's own filesystem |
| PVCs | `kubectl get pvc -A` | 8, all `local-path`: `postgres-main-1`, `openldap-config`, `openldap-data`, `apisix-etcd-data`, `seaweedfs-data-seaweedfs-0`, `data-0-beluga-kafka-mixed-{0,1,2}` |
| k3s server flags | `kubectl get node master-1 -o jsonpath='{.metadata.annotations.k3s\.io/node-args}'` | `server --flannel-backend none --disable-network-policy --disable traefik --disable servicelb --disable-kube-proxy --egress-selector-mode cluster --node-ip ...`: no `--secrets-encryption`. A k3s `config.yaml` on the host would not be excluded by this annotation alone: **not verified** |
| Secrets | `kubectl get secrets -A` | 63 Opaque, 9 TLS, 3 Helm release, 4 node-password |
| PostgreSQL parameters | `kubectl get cluster.postgresql.cnpg.io -n database postgres-main -o jsonpath=...` | `ssl_min_protocol_version: TLSv1.3`, `shared_preload_libraries: ""` |
| Backup state | `kubectl get backup -n database` | scheduled backups of 2026-10-05 and 2026-10-06 are in phase `failed` ("instance manager was restarted during backup"); a successful recent backup is therefore not shown by these two objects |
| Node disk encryption | not measurable with `kubectl` | **not verified live** (node shell access is out of scope for this lane) |

### 2.3 Upstream facts used

- PostgreSQL 17: storage encryption is done at file-system or block level (dm-crypt + LUKS on Linux); it protects against theft of drives, **not** against attacks while the file system is mounted;
  the page read does not describe built-in transparent data encryption [S1].
- k3s: enable with the `--secrets-encryption` flag; commands `k3s secrets-encrypt status`, `rotate-keys`, `rotate`; on an existing cluster, enabling needs a key rotation and a server restart before it is fully in effect [S2].
- SeaweedFS: `weed filer -encryptVolumeData` encrypts volume data with AES256-GCM using a per-chunk random key stored as metadata in the filer store; the page states no key-rotation or lost-key recovery procedure [S3].
  S3 server-side encryption modes SSE-KMS, SSE-C, SSE-S3 are described (KMS providers listed: AWS KMS, Google Cloud KMS, OpenBao/Vault, Azure Key Vault experimental); applicability to the pinned 4.41 and to Iceberg/Trino traffic is **not verified** [S4].
- CloudNativePG v1.30.0: `barmanObjectStore` is deprecated since v1.26 in favor of the Barman Cloud plugin; the backup page read contains no statement about backup encryption options [S5].
- Kafka and Strimzi: no official at-rest statement was researched in this pass; **no official recommendation recorded here**.

## 3. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| All protected data classes have an identified at-rest mechanism | **Not met** | No mechanism declared for any class (2.1); node-level state unknown (2.2) |
| Key lifecycle and ownership documented | **Not met** | No key exists to own; the only keys are TLS keys (issue #47) and S3/DB credentials (privileged-access inventory) |
| Backup artifacts encrypted and access-controlled | **Partial** | Access control: dedicated S3 identity (2.1). Encryption: none declared; transport is plain `http://` |
| Key rotation/revocation repeatable | **Not met** | Nothing to rotate; credential rotation is not established per the privileged-access inventory |
| Secure-profile verification confirms encryption controls | **Not met** | No check in `make validate` or tests references encryption (search in 2.1); the profile design lists no encryption check |

## 4. Proposal (all items Proposed)

### 4.1 Layered model

| Layer | Covers | Mechanism candidate | Residual plaintext after this layer |
|---|---|---|---|
| L1 node/volume | All PVCs at once (PostgreSQL, Kafka, SeaweedFS, OpenLDAP, etcd), because `local-path` volumes are node directories | Block-level encryption of the data disk (dm-crypt + LUKS) [S1], or encrypted volumes of the underlying platform | Data is readable by anything on a running node [S1] (including a compromised workload with host access) |
| L2 Kubernetes Secrets | 63 Opaque Secrets (credentials, keystore passwords) | k3s `--secrets-encryption` and `secrets-encrypt rotate-keys` [S2] | Secrets are plaintext in memory and in any backup of the API server data taken without the key; env/volume copies in pods |
| L3 object store | Lakehouse data and backup bucket | SeaweedFS `-encryptVolumeData` [S3] or S3 SSE [S4], only after compatibility is tested | The key material lives in the filer store (S3) or a KMS (S4) |
| L4 backups | `beluga-postgres-backups` | SSE at bucket/object level and/or L1 on the SeaweedFS volume; migration to the Barman Cloud plugin is already a pending decision (data lifecycle D10) [S5] | Backup traffic is `http://` until the endpoint is changed |
| L5 database/Kafka native | PostgreSQL, Kafka | No built-in transparent encryption described for PostgreSQL [S1]; Kafka not researched | n/a |

Development profile: no change (practical local use, issue #16 requirement). Production profile: **Proposed** minimum is L1 + L2; L3/L4 after compatibility tests.

### 4.2 Key lifecycle (table to be filled by the owner; nothing here is a number)

| Key | Owner | Stored in | Rotation | Revocation | Recovery |
|---|---|---|---|---|---|
| Disk (LUKS) key | **D1** | **D1** (passphrase, TPM, or network-bound) | **D2** | re-encrypt or destroy volume | **D3** |
| k3s Secrets-encryption key | **D1** | k3s server data directory | `rotate-keys` [S2]; period **D2** | rotate then restart [S2] | included in server-state backup; **D3** |
| SeaweedFS data/SSE keys | **D1** | filer store or KMS [S3, S4] | not documented for `-encryptVolumeData` [S3] | not documented | not documented |
| Backup key | **D1** | same as the backup store policy | **D2** | **D2** | **D3** |

Rotation periods: **no official figure was read** (NIST SP 800-57 was not consulted in this pass); the number is an owner decision.
Separation requirement from the issue: key-management credentials must not reuse application credentials; **Proposed**: dedicated Secrets/namespace for key material, excluded from the `beluga-credentials` projection described in the privileged-access inventory.

## 5. Verification and test ideas

1. Static: a gate that, for a production render, fails when any PVC is not on a StorageClass annotated as encrypted (annotation convention is **Proposed**) and when the Cluster `backup` has no encryption declaration.
2. Live read-only: `kubectl get node -o jsonpath` of `k3s.io/node-args` asserts `--secrets-encryption`; `k3s secrets-encrypt status` (node access, outside this lane) asserts Enabled.
3. Live: write a Secret, read the backing store on a disposable cluster and assert the stored value is not the plaintext (confirms L2).
4. Backup: take a backup to the encrypted bucket on a disposable cluster, restore it, and compare row counts; confirm the object is unreadable without the key.
5. Negative: a restore attempt with the wrong or revoked key fails closed.
6. Revocation drill: rotate the key, confirm old backups remain restorable per D3.

## 6. Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Key owner, store and custody model per key class | Platform owner for L1/L2 keys; separate role for backup keys |
| D2 | Rotation periods | No official figure; choose after reading NIST SP 800-57 and the organization's policy |
| D3 | Recovery and escrow procedure | Document offline escrow for L1/L2 keys before enabling either |
| D4 | Which layers are mandatory for the production profile | L1 + L2 mandatory; L3/L4 after tests |
| D5 | SeaweedFS option: `-encryptVolumeData` vs SSE-KMS vs none (rely on L1) | Rely on L1 first; test SSE with Trino/Lakekeeper on a disposable cluster before choosing |
| D6 | Backup path: plugin migration, bucket on separate failure domain, `https` endpoint | Combine with data lifecycle D10 |
| D7 | Whether `pg_hba` should require `hostssl` for application roles | Separate transport issue; mention here only so the decision is not lost |

## 7. Follow-up implementation tasks (ordered)

1. Record the live node-level state (disk encryption yes/no) per node via an approved procedure; acceptance: table in this document with command and output.
2. Add a read-only check that reports `--secrets-encryption` from `k3s.io/node-args`; acceptance: exit 1 under the production profile when absent (fixture-tested).
3. Enable and test k3s Secrets encryption on a disposable cluster, including `rotate-keys`; acceptance: test 5.3 passes.
4. Test SeaweedFS SSE/`-encryptVolumeData` against Trino and Lakekeeper on a disposable cluster; acceptance: Iceberg read/write E2E still passes.
5. Encrypt the backup path and add a restore drill; acceptance: tests 5.4 and 5.5.
6. Add the production-profile static gate (5.1).

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | PostgreSQL 17, Encryption Options: https://www.postgresql.org/docs/17/encryption-options.html |
| S2 | K3s, secrets-encrypt: https://docs.k3s.io/cli/secrets-encrypt |
| S3 | SeaweedFS wiki, Filer Data Encryption: https://github.com/seaweedfs/seaweedfs/wiki/Filer-Data-Encryption |
| S4 | SeaweedFS wiki, Server-Side Encryption: https://github.com/seaweedfs/seaweedfs/wiki/Server-Side-Encryption |
| S5 | CloudNativePG v1.30.0, Backup: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/backup.md |
