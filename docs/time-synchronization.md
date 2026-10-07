# Time Synchronization and Trusted Event Timestamps (Proposal)

English | [한국어](time-synchronization-ko.md)

Refs issue [#45](https://github.com/dasomel/beluga/issues/45) ("Establish platform time synchronization and trusted event timestamps").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed by this
> document. Every statement about the repository carries a `file:line` read at commit `9f74c2b`. Every statement about
> the live cluster comes from a read-only `kubectl` command run on 2026-10-07 ([section 2.2](#22-live-state-measured-2026-10-07)) or is marked
> **not verified live**. Node shell access (`vagrant ssh`) was deliberately not used, so node-level time-sync state could **not** be measured.
> External facts cite [Sources](#sources) (accessed 2026-10-07). Numbers marked **Proposed** or **Owner decision** have no repository or upstream basis.

Related: [`docs/audit-retention.md`](audit-retention.md) (issue #35, time requirements for retained evidence),
[`docs/privileged-access-logging.md`](privileged-access-logging.md) (issue #44), [`docs/certificate-lifecycle.md`](certificate-lifecycle.md) (issue #47, validity windows depend on clocks),
[`docs/environment-profiles.md`](environment-profiles.md).

## 1. Purpose and issue mapping

Issue #45 asks for approved time sources, node synchronization, an acceptable skew, drift detection and alerting, a documented timestamp and time-zone convention,
and preflight/release clock checks. This document records what the repository and the live cluster show, and proposes a baseline.

## 2. Current state (verified)

### 2.1 What the repository defines

| Area | Fact | Source |
|---|---|---|
| Time-sync configuration | Searched `Vagrantfile`, `scripts/`, `gitops/`, `tests/`, `policies/`, `docs/*.md` (case-insensitive) for `chrony`, `ntp`, `timesyncd`, `timedatectl`, `clock skew`, `clock drift`, `time sync`, `leeway`, `timezone`, `TZ`, `log_timezone`, `default_timezone`, `local-time-zone`: **no configuration match** (only Python `datetime.timezone` usages and argparse noise). The repository declares no time source, no daemon setting and no skew threshold in those paths | search on this commit |
| Node image | VM box `dasomel/ubuntu-26.04-xfs`; time-sync behavior depends on the image, not on anything in this repository | [`Vagrantfile:51`](../Vagrantfile#L51) |
| k3s start | k3s is installed with no time-related option | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| Workload time zone | No pod in the cluster sets a `TZ` environment variable (live, 2.2) | live |
| Timestamp convention in code | Two Python tools already emit UTC with `Z`: the operations agent and the research evidence recorder | [`operations_agent.py:96`](../scripts/agent/operations_agent.py#L96), [`record-evidence.py:117`](../scripts/research/record-evidence.py#L117) |
| Schedule time basis | PostgreSQL backup cron is documented as UTC (02:00) | [`02-cnpg.yaml:79-81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L79-L81) |
| Release evidence | Searched `scripts/release/evidence_bundle.py` (case-insensitive) for `time`, `date`, `SOURCE_DATE`: only unrelated matches; no timestamp or trusted-time field was found in the bundle builder | [`evidence_bundle.py:10`](../scripts/release/evidence_bundle.py#L10) (an unrelated match: inventory is not regenerated at verify time) |
| Clock-dependent features present | cert-manager validity windows (see the certificate document), OIDC tokens via Keycloak, and CNPG/Kafka/Flink timeouts all depend on consistent clocks; their tolerance is not configured in this repository | analysis, no repository setting found |
| Monitoring | No Prometheus/Grafana workload is deployed from this repository; see [`certificate-lifecycle.md`](certificate-lifecycle.md) section 2.1 | [`platform-services.yaml:8-23`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L23) |

### 2.2 Live state (measured 2026-10-07)

| Measurement | Command | Result |
|---|---|---|
| Nodes | `kubectl get nodes -o wide` | 4 nodes (`master-1`, `worker-1..3`), Ubuntu 26.04 LTS, kernel 7.0.0-22-generic |
| API server clock vs operator workstation | `date -u` then `kubectl get --raw /readyz -v=9` (response `Date` header) then `date -u` | workstation 14:13:17Z / API server `Date: ... 14:13:18 GMT` / workstation 14:13:18Z: agree to the 1 s resolution of the header. The workstation is **not** a platform node and its own sync state is unknown |
| Node Lease renewTime | `kubectl get lease -n kube-node-lease -o custom-columns=...` | all four renewTimes were 5-8 s before the sample (`leaseDurationSeconds` 40) |
| Pod time zone env | `kubectl get pods -A -o jsonpath` for `TZ` | none of 76 pods sets it |
| Per-node sync daemon and offset | not measurable with `kubectl` | **not verified live** |

What these measurements prove: gross drift (more than about a lease interval) between the API server host and the observer is absent right now. What they do **not** prove: sub-second skew between nodes, the sync daemon, the
configured sources, or any drift history. The Lease/`Date` checks have a resolution of seconds and are not a skew measurement.

### 2.3 Upstream facts used

- JWT (RFC 7519, sections 4.1.4 and 4.1.5): implementers MAY provide "some small leeway, usually no more than a few minutes, to account for clock skew" [S1]. This is the only skew figure from a standard that applies to Beluga's OIDC flows; it is a tolerance, not a target.
- RFC 3161: a time-stamping service supports assertions of proof that a datum existed before a particular time; it defines the request/response to a Time Stamping Authority [S2].
- Prometheus node_exporter has `timex` (adjtimex statistics, enabled by default, Linux) and `time` collectors [S3]. The README table read does not list metric names; they must be confirmed from a running exporter.
- Ubuntu's default time-sync daemon for 26.04: **not verified** (the official page was unavailable at fetch time, HTTP 503) [S4].
- Acceptable skew for audit, tracing, SLA correlation: **no official recommendation** found in the sources read.

## 3. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| Approved time sources and synchronization policy documented | **Not met** | No source or policy in the repository (2.1) |
| Node clock skew measurable and within a defined threshold | **Not met** | No threshold defined; per-node offset not measured (2.2); no collector deployed |
| Excessive drift generates an operational alert | **Not met** | No monitoring stack, no rule |
| Security/audit evidence uses a documented timestamp convention | **Partial** | Two tools emit UTC `Z` (2.1); no written convention covering logs, evidence and displays |
| Preflight can detect unacceptable time skew | **Not met** | No clock check in the preflight/validate paths searched |

## 4. Proposal (all items Proposed)

### 4.1 Time sources and node policy

- Authoritative source: an organization-approved NTP source list, plus a fallback; the list itself is **Owner decision D1** (no source is chosen here).
- Nodes and supporting VMs synchronize to the approved list using the OS time daemon; **verify which daemon the image ships** before writing configuration (S4 unavailable).
- In-cluster workloads inherit the node clock; no per-pod time daemon.
- Keep the cluster's API server host and all nodes on the same list so the skew between them is bounded by the daemon, not by different sources.

### 4.2 Skew thresholds (owner values)

| Threshold | Purpose | Value |
|---|---|---|
| Warn / critical node offset | audit and trace correlation | **Owner decision D2**, to be chosen after the baseline measurement in follow-up task 1 |
| Upper bound relative to token leeway | OIDC validation | must be well below the JWT leeway the applications configure (a few minutes is the standard's wording [S1]); the applications' actual leeway is **not verified** |
| Drift persistence before alert | avoid flapping | **Owner decision D3** |

### 4.3 Detection

Preferred: node_exporter `timex` collector [S3] scraped by a Prometheus stack, alert on offset and on sync status (metric names to be confirmed from the running exporter). This requires the monitoring-stack decision (D4).
Without a stack: a preflight script on the operator side that reads each node's sync state through an approved channel (node access is **not** used in this proposal's research). A kubectl-only check (API `Date` header against Lease `renewTime`) can only detect gross drift of the order of seconds and should be labelled as such.

### 4.4 Timestamp convention

**Proposed**: all machine-written evidence and logs use UTC, RFC 3339 / ISO 8601 with a `Z` suffix and at least millisecond precision (as the two existing tools already do, 2.1); schedules are documented in UTC;
human-facing displays may use a local zone but must show the zone; every audit record carries the source host clock reading and a correlation id (shared with issues #44 and #35).

### 4.5 Trusted timestamps for evidence

For retained evidence (issue #35) a trusted external timestamp is optional: an RFC 3161 TSA token over the evidence manifest hash [S2]. Whether the organization needs it, and which TSA, is **Owner decision D5**; without it, evidence time rests on the platform's own clocks and the object-store retention clock.

## 5. Verification and test ideas

1. Baseline: record `chronyc tracking`-equivalent offset for each node on a disposable cluster (via the approved channel) for a defined period; acceptance: table of observed offsets.
2. Skew injection on a disposable cluster: step one node's clock by a known amount and assert (a) the alert fires and (b) the preflight fails.
3. Token tolerance: with a skew just below and just above the configured OIDC leeway, assert login success and failure respectively.
4. Convention check: a static test that new evidence-producing scripts emit UTC `Z` timestamps (grep-based fixture).
5. Release preflight: negative fixture where the clock-report input exceeds the threshold exits non-zero.

## 6. Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Approved time sources and fallback | Use the organization's internal NTP where one exists; otherwise a public pool decided by the owner |
| D2 | Warn/critical offset thresholds | Measure the baseline first (task 1), then choose with audit correlation needs in view |
| D3 | Drift persistence before alerting | Short enough to catch step changes; value after baseline |
| D4 | Monitoring stack vs script-only detection | Stack, shared with certificate, audit and privileged-access alerts |
| D5 | RFC 3161 trusted timestamping for evidence | Defer until the audit-retention decisions; low cost to add later |
| D6 | UTC `Z`/millisecond as the written convention | Accept |

## 7. Follow-up implementation tasks (ordered)

1. Measure and document the per-node sync daemon, sources and offset via an approved procedure; acceptance: table with command and output per node.
2. Write the convention (4.4) into a short normative doc and link it from the evidence docs; acceptance: docs-check passes, pair exists.
3. Add the offset/sync-status rules once D4 is decided; acceptance: skew-injection test 5.2.
4. Add a preflight clock check with a negative fixture; acceptance: test 5.5.
5. Verify applications' effective token leeway (Keycloak, Lakekeeper, Trino, Superset, Airflow); acceptance: table of values and test 5.3.
6. Optional TSA step for the evidence bundle (D5).

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | RFC 7519, JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519.html |
| S2 | RFC 3161, Time-Stamp Protocol: https://www.rfc-editor.org/rfc/rfc3161.html |
| S3 | Prometheus node_exporter README (collectors): https://github.com/prometheus/node_exporter |
| S4 | Ubuntu Server docs, chrony: https://ubuntu.com/server/docs/how-to/networking/serve-ntp-with-chrony/ (HTTP 503 at fetch time; not read) |
