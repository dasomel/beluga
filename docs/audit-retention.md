# Immutable Audit and Evidence Retention (Proposal)

English | [한국어](audit-retention-ko.md)

Refs issue [#35](https://github.com/dasomel/beluga/issues/35) ("Enforce immutable audit and evidence retention for security events").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed by this
> document. Every statement about the repository carries a `file:line` read at commit `9f74c2b`. Every statement about
> the live cluster comes from a read-only `kubectl` command run on 2026-10-07 ([section 2.2](#22-live-state-measured-2026-10-07)) or is marked
> **not verified live**. External facts cite [Sources](#sources) (accessed 2026-10-07); where no official recommendation was found it says so.
> Retention periods are **owner decisions**: none is invented here.

Related: [`docs/privileged-access-logging.md`](privileged-access-logging.md) (what is recorded, issue #44), [`docs/time-synchronization.md`](time-synchronization.md) (timestamps, issue #45),
[`docs/encryption-at-rest.md`](encryption-at-rest.md) (keys, issue #16), [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md) (Object Lock mechanics for the backup bucket, D10),
[`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (C10, C14, C17).

## 1. Purpose and issue mapping

Issue #35 asks for retention classes and periods, separation of operational log access from audit-evidence administration, protection against routine modification or deletion, integrity verification, consistent time and correlation metadata,
coverage of authentication, authorization, gateway administration, data-access decisions, backup/restore and DR evidence, and an export/review procedure for an audit period.

## 2. Current state (verified)

### 2.1 What the repository defines

| Area | Fact | Source |
|---|---|---|
| Release evidence integrity (exists) | The release bundle (SBOM, license inventory, asset inventory, NOTICE, LICENSE, `manifest.json`) carries `SHA256SUMS` over every other file; offline `verify` recomputes checksums and fails closed on a missing, extra, altered or unparsable file | [`evidence_bundle.py:2-15`](../scripts/release/evidence_bundle.py#L2-L15) |
| Release evidence attestation (exists) | The release workflow attests build provenance over `SHA256SUMS` and verifies the attestation per file | [`release.yml:167-181`](../.github/workflows/release.yml#L167-L181) |
| Scope of that mechanism | Release artifacts only. It does not cover runtime security events; the bundle builder has no timestamp field (see time document, 2.1) | [`evidence_bundle.py:2-15`](../scripts/release/evidence_bundle.py#L2-L15) |
| Research evidence records | `record-evidence.py` appends one schema-checked record per command; fixed scalar keys keep raw log structures out | [`record-evidence.py:1-3`](../scripts/research/record-evidence.py#L1-L3), [`:55`](../scripts/research/record-evidence.py#L55), [`:137`](../scripts/research/record-evidence.py#L137) |
| QA report | A release QA report requires evidence in five categories and records waivers with approval metadata | [`generate_release_qa_report.py:19-22`](../scripts/generate_release_qa_report.py#L19-L22) |
| Backup protection (static) | The CNPG backup gate checks `barmanObjectStore`, secret-referenced credentials, WAL compression, retention; it checks no immutability | [`check-postgres-backup-config.py:2-16`](../scripts/ci/check-postgres-backup-config.py#L2-L16) |
| Backup bucket | `beluga-postgres-backups`, `retentionPolicy: 30d`, S3 identity `postgres-backup-service` with Read/Write/List/Tagging on that bucket (no `Admin`) | [`02-cnpg.yaml:56-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L56-L71), [`01-seaweedfs.yaml:34-38`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L34-L38) |
| Same storage system as lakehouse data | The backup bucket and `beluga-lake` are served by one SeaweedFS StatefulSet with one 5Gi PVC; identity `lakekeeper-service` has `Admin` only on `beluga-lake` | [`01-seaweedfs.yaml:15-36`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L15-L36), [`:185-191`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L185-L191) |
| Object Lock | Not configured. A repository document states that Object Lock enforcement in SeaweedFS was unverified for the version it names (3.86, while `VERSIONS.md` lists 4.41) | [`configuration-sources.md:47`](configuration-sources.md#L47), [`VERSIONS.md:32`](../VERSIONS.md#L32) |
| Audit sources | No audit records are produced for Kubernetes API, PostgreSQL, Keycloak, ArgoCD, LDAP (see issue #44 document); OPA decision logs go to the console | [`opa.yaml:10-11`](../gitops/charts/beluga-platform/templates/opa.yaml#L10-L11) |
| Log store | None deployed from this repository | live, 2.2 |
| Evidence-map rows | C10 (logging and audit trail), C17 (incident response), C19 (release readiness gated on control evidence) are `gap`; C14 (release evidence) is `partial` (the map notes the bundle is built by the release workflow with build provenance, but there is no security-control section and no gate on control status) | [`security-control-evidence-map.md`](security-control-evidence-map.md) |

### 2.2 Live state (measured 2026-10-07)

| Measurement | Command | Result |
|---|---|---|
| Log collector / store | `kubectl get pods -A \| grep -E "prom\|graf\|loki\|alert\|fluent\|vector\|otel\|falco"` | no match |
| Backup objects | `kubectl get backup -n database` | `postgres-main-backup-20261005020000` and `...20261006020000` in phase `failed` ("instance manager was restarted during backup on pod postgres-main-1"); backup/restore evidence is currently incomplete on this cluster |
| Object Lock on SeaweedFS buckets | needs S3 credentials/API | **not verified live** |
| Existing retained audit history | none can exist: cluster age 3 days, API audit off, pgaudit not loaded (issue #44 document 2.2) | live |

### 2.3 Upstream facts used

- SeaweedFS S3 Object Lock: Governance mode "can be bypassed by users with proper permissions (`s3:BypassGovernanceRetention`)"; Compliance mode "cannot be bypassed by any user, including root/admin"; Object Lock must be enabled when the bucket is created and cannot be added later; versioning is enabled automatically and required [S1]. Behavior on version 4.41 is **not verified** (the page is unversioned).
- NIST SP 800-92 (log management guide): its abstract covers log management infrastructure and processes; **no retention period is stated** on the page read [S2]. No official retention figure was found for Beluga's context.
- Kubernetes audit backends (log file with rotation flags, webhook) are described in the issue #44 document ([`privileged-access-logging.md`](privileged-access-logging.md), sources S1 and S2 there).

## 3. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| Security evidence retention policy documented | **Not met** | No policy; periods undecided; this document proposes the structure |
| Retained evidence cannot be altered through normal operator workflows | **Not met** | No audit store; backup bucket has no Object Lock; the same StatefulSet/PVC and cluster operators control it |
| Integrity verification can detect modification or loss | **Partial (release only)** | Checksums + attestation for the release bundle; nothing for runtime events |
| Time and correlation metadata consistent across sources | **Not met** | See time document: no time source, no convention beyond two tools; no correlation id in the gateway log |
| Audit-period evidence package can be generated and verified | **Not met** | The release-bundle `verify` pattern exists; no runtime package |

## 4. Proposal (all items Proposed)

### 4.1 Evidence classes

| Class | Sources (from the issue) | Currently produced | Retention |
|---|---|---|---|
| E1 authentication | Keycloak login events, Kubernetes/ArgoCD/LDAP logins | no (issue #44 document) | **D1** |
| E2 authorization and data-access decisions | OPA decision logs, OpenFGA/Lakekeeper, Kafka authorizer | OPA console only | **D1** |
| E3 administrative actions | Kubernetes API audit, APISIX admin, Keycloak admin events, pgaudit ROLE/DDL | no | **D1** |
| E4 backup/restore | CNPG `Backup` objects, restore drills | `Backup` objects exist (live, with failures); no drill record | **D1** |
| E5 DR exercise | exercise reports | none | **D1** |
| E6 release evidence | release bundle | yes, attested | already per GitHub release; **D1** for how long |

No official retention period was read; every period is **Owner decision D1**. The longest class sets the minimum capacity and Object Lock retention.

### 4.2 Protected storage design

- A dedicated audit bucket created with Object Lock enabled at creation [S1], with versioning (automatic) and default retention set per class; mode **Compliance** only after a disposable-cluster test, because Compliance cannot be bypassed even by admin [S1] (an error in retention length cannot be corrected). Governance is the reversible alternative (**D2**).
- Writer identity: write-only on that bucket, **no** `Admin`, no `BypassGovernanceRetention`. Reader/exporter identity: read-only. Retention/lock administrator: a third identity not held by lakehouse or platform operators. Mirrors the existing per-bucket identities (`01-seaweedfs.yaml:15-38`).
- Residual risk the lock does not cover: the audit bucket would sit in the same SeaweedFS instance and PVC as lakehouse data, so deleting the StatefulSet/PVC or the node volume destroys it regardless of Object Lock. **Proposed**: place audit evidence on a separate failure and administration domain (a second store or an external WORM-capable target; **D3**). Object Lock is an S3-API-level control only.

### 4.3 Integrity

Writer batches records into segments; each segment gets a SHA-256 and a manifest entry with sequence number and the previous manifest hash (hash chain), so modification (hash mismatch), loss (sequence gap or missing file) and reordering are detectable.
Manifests are signed with a key owned separately from the writer (key custody: encryption document D1). The release bundle's checksum-and-attestation approach [`evidence_bundle.py`, `release.yml:167-181`] is the model; `verify` must be offline and fail closed on missing, extra or altered files, as the release `verify` does.

### 4.4 Time and correlation

All records: UTC RFC 3339 `Z`, millisecond precision, source host, correlation id (time document 4.4, privileged-access document 4.1). Optional RFC 3161 token over each manifest hash (time document D5).

### 4.5 Separation of duties

Three roles: operators (routine logs only), audit writers (automated), audit administrators (retention settings, exports) with reviewers separate from administrators. Access to the audit store itself is recorded as E3.

### 4.6 Audit-period export and review

Package for a period: segments + chained manifests + signature + `SHA256SUMS` + a verification report (counts per class, gaps, unaudited-path list from the issue #44 report) + reviewer sign-off record. Procedure: (1) freeze the period boundary, (2) export read-only, (3) run offline verify, (4) reviewer signs, (5) the signed package is itself stored under retention.

## 5. Verification and test ideas

1. Object Lock (disposable cluster): create a bucket with Object Lock, write an object with a short retention, attempt delete and overwrite with the writer, the lakehouse admin and the root identity; assert all fail; for Governance assert the bypass permission is required [S1].
2. Tamper: alter one byte in a segment, delete one segment, swap two; assert `verify` fails for each with a distinct message.
3. Time/correlation: one request through the gateway produces records in E2 and E3 with the same correlation id and monotonic UTC times.
4. Package: generate a package for a fixture period; verify offline on a clean machine; extra and missing file negatives.
5. Privilege separation: the writer identity cannot list other buckets or change retention.
6. Failure: kill the collector for N minutes; assert a gap is detected in verification (not silently ignored).

## 6. Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Retention period per evidence class; review frequency | No official figure; derive from the organization's compliance obligation |
| D2 | Object Lock mode: Compliance vs Governance | Governance during pilot, Compliance after the test in 5.1 |
| D3 | Audit store location: same SeaweedFS vs separate domain | Separate domain; same-instance storage cannot meet "not alterable by operators" |
| D4 | Signing key owner and custody | Separate from writer; follow the encryption document D1/D3 |
| D5 | Log pipeline/store technology | One shared decision with issues #44, #45, #47 |
| D6 | Who is the reviewer and how often | Named role other than audit administrator |

## 7. Follow-up implementation tasks (ordered)

1. Prove SeaweedFS 4.41 Object Lock behavior on a disposable cluster (test 5.1); acceptance: recorded results, and an update to the stale `configuration-sources.md` statement.
2. Decide D1, D3, D5 and write them into this document.
3. Segment writer with hash-chained manifest and offline `verify` (test 5.2); acceptance: tamper fixtures fail.
4. Wire the E2/E3 sources from the issue #44 document into the writer; acceptance: test 5.3.
5. Package export and review procedure (5.4); acceptance: clean-machine verification.
6. Add a static gate that fails when a production render lacks the audit bucket Object Lock setting or the three identities.
7. Restore-drill record (E4/E5) format and a first recorded drill.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | SeaweedFS wiki, S3 API FAQ (Object Lock, versioning): https://github.com/seaweedfs/seaweedfs/wiki/S3-API-FAQ |
| S2 | NIST SP 800-92, Guide to Computer Security Log Management (abstract page): https://csrc.nist.gov/pubs/sp/800/92/final |
