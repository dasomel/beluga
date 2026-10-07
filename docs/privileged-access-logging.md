# Privileged Access and Database Activity Logging (Proposal)

English | [한국어](privileged-access-logging-ko.md)

Refs issue [#44](https://github.com/dasomel/beluga/issues/44) ("Define privileged access and database activity logging controls").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed by this
> document. Every statement about the repository carries a `file:line` read at commit `9f74c2b`. Every statement about
> the live cluster comes from a read-only `kubectl` command run on 2026-10-07 ([section 2.2](#22-live-state-measured-2026-10-07)) or is marked
> **not verified live**. External facts cite [Sources](#sources) (accessed 2026-10-07); where no official recommendation was found it says so.
> Numbers marked **Proposed** or **Owner decision** have no repository or upstream basis.

This document continues [`docs/privileged-access-inventory.md`](privileged-access-inventory.md), which already satisfies acceptance criterion 1 (inventory) and lists which systems log where.
This document addresses criteria 2-5 as a design. Related: [`docs/audit-retention.md`](audit-retention.md) (storage, immutability, issue #35),
[`docs/time-synchronization.md`](time-synchronization.md) (timestamps, issue #45), [`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (row C10 "Logging and audit trail" is a `gap`).

## 1. Purpose and issue mapping

| Issue #44 criterion | Where addressed |
|---|---|
| Privileged access paths inventoried | Existing inventory; not repeated |
| Security-relevant privileged actions generate structured records | Sections 3, 4.1, 4.2 |
| Database access logging policy documented and enforced | Sections 4.3 |
| Retention/review rules defined | Section 4.5 (values are owner decisions; storage is in the audit-retention document) |
| Periodic privileged-access evidence report can be generated | Section 4.6 |

## 2. Current state (verified)

### 2.1 What the repository defines

| System | Fact | Source |
|---|---|---|
| Kubernetes API (k3s) | Server started with flags that contain no audit option | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| PostgreSQL | `postgresql.parameters` sets only `wal_level`, `max_wal_senders`, `max_replication_slots`; no `pgaudit.*`, `log_connections`, `log_disconnections` or `log_statement` | [`02-cnpg.yaml:48-51`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L48-L51) |
| PostgreSQL authentication | `pg_hba` entry is `host ... ldap` for the three application login roles; the cluster superuser path is not declared there | [`02-cnpg.yaml:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |
| APISIX gateway | Access log to `/dev/stdout`, format `$remote_addr - $remote_user [$time_local] $http_host "$request" $status $body_bytes_sent $request_time`: no request id or authenticated identity beyond `$remote_user`. Admin-change auditing is not established | [`apisix-gateway.yaml:52-60`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L52-L60) |
| OPA (Trino authorization) | Decision logs are enabled to the console | [`opa.yaml:10-11`](../gitops/charts/beluga-platform/templates/opa.yaml#L10-L11) |
| Kafka | Authorizer is OPA (`OpaAuthorizer`) or Strimzi `simple` ACL depending on values | [`03-strimzi-kafka.yaml:49`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L49), [`:51-55`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L51-L55) |
| Other systems | Searched `gitops/` and `scripts/` (excluding the CI/release/agent/research tooling) for `audit` (case-insensitive): no match. Searched `gitops/` for `accesslog`, `slapo`, `loglevel`, `eventsEnabled`, `adminEventsEnabled`, `jboss-logging`: no match | search on this commit |
| Existing records elsewhere | The operations agent writes structured records with UTC timestamps and requires a correlation id (agent tooling, not platform audit) | [`operations_agent.py:96`](../scripts/agent/operations_agent.py#L96), [`:123`](../scripts/agent/operations_agent.py#L123) |
| Verifier | Evidence-map row C10 "Logging and audit trail" is `gap`: no verifier | [`security-control-evidence-map.md`](security-control-evidence-map.md) |
| Log destination | No log shipper or log store is deployed from this repository (live check in 2.2) | live |

### 2.2 Live state (measured 2026-10-07)

| Measurement | Command | Result |
|---|---|---|
| k3s server arguments | `kubectl get node master-1 -o jsonpath='{.metadata.annotations.k3s\.io/node-args}'` | no `audit-log-path`, `audit-policy-file`, or `kube-apiserver-arg`. API audit is therefore off unless set through a `config.yaml` this annotation does not show (**not verified**) |
| PostgreSQL parameters (Cluster spec) | `kubectl get cluster.postgresql.cnpg.io -n database postgres-main -o jsonpath='{.spec.postgresql.parameters}'` | `log_destination: csvlog`, `logging_collector: on`, `log_rotation_age: 0`, `log_rotation_size: 0`, `shared_preload_libraries: ""`, no `pgaudit.*`, no `log_connections`: **pgaudit is not loaded**. Effective values were not queried with SQL |
| Log pipeline | `kubectl get pods -A \| grep -E "prom\|graf\|loki\|alert\|fluent\|vector\|otel\|falco"` | no match: no collector or store is running; container logs exist only on the nodes |
| Admin/audit events of Keycloak, ArgoCD, LDAP, SeaweedFS, Lakekeeper | needs application credentials/API | **not verified live** |

Cluster age is 3 days, so no retained history exists to review.

### 2.3 Upstream facts used

- Kubernetes: auditing is not enabled by default; a policy file (`--audit-policy-file`) is required; levels `None`, `Metadata`, `Request`, `RequestResponse`; log and webhook backends; flags `--audit-log-path`, `--audit-log-maxage`, `--audit-log-maxbackup`, `--audit-log-maxsize`; Secrets and ConfigMaps best logged at `Metadata` only [S1].
- k3s: does not enable auditing by default and does not create the log directory or policy; shows `kube-apiserver-arg` entries for the audit flags and a minimal `Metadata` policy. The sample numbers in that page (30 days, 10 backups, 100 MB) are an example, not a recommendation [S2].
- pgAudit: loaded via `shared_preload_libraries`; classes READ, WRITE, FUNCTION, ROLE, DDL, MISC, MISC_SET, ALL; parameter logging is **off by default** and may expose sensitive values when enabled; `pgaudit.log_catalog` reduces catalog noise; object-level auditing through `pgaudit.role`; entries go to the standard PostgreSQL log; pgAudit v17.X targets PostgreSQL 17 [S3].
- CloudNativePG v1.30.0: the operator manages `shared_preload_libraries` and extension creation automatically when `pgaudit.*` parameters are present; pgaudit records appear in the JSON log with `logger: pgaudit` and an `audit` object [S4]. The page read says nothing about `log_connections`.
- PostgreSQL 17: `log_connections` default `off`, `log_disconnections` default `off`, `log_statement` default `none`, `log_line_prefix` default `'%m [%p] '`, `log_timezone` built-in default `GMT` [S5].
- Keycloak: the Server Administration Guide has user-event auditing and admin-event auditing, event listeners (`jboss-logging` named), event expiration and database event storage; the detailed settings were not read [S6].
- Minimum retention period and review frequency for privileged-access records: **no official recommendation** in the sources read; this is an owner decision.

## 3. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| Privileged access paths inventoried | **Complete** | [`privileged-access-inventory.md`](privileged-access-inventory.md) |
| Security-relevant privileged actions generate structured records | **Not met** (partial for OPA decisions and the APISIX access log) | API audit off, pgaudit not loaded, no Keycloak event or admin-event setting found, no LDAP/ArgoCD/APISIX-admin audit established; OPA decision logs and the gateway access log exist but go to container stdout |
| DB access logging policy documented and enforced for protected data paths | **Not met** | Not documented before this proposal; nothing enforced; "protected data paths" are not yet defined (see 4.3) |
| Retention/review rules defined | **Not met** | No rule; no store |
| Periodic evidence report can be generated | **Not met** | No source of records to report from; the inventory itself is static |

## 4. Proposal (all items Proposed)

### 4.1 Common record content

Each privileged-action record carries: actor (identity and authentication method), timestamp (UTC RFC 3339 with `Z`, see the time document), source (address/host), target (system and object), action, outcome (success/denied/error),
and a correlation id that is propagated across gateway, application and database where the system allows it. Request or row payloads are not logged by default (issue requirement); Secrets and ConfigMaps at metadata level only [S1].

### 4.2 Per-system capture mechanisms

| System | Privileged operations (from the inventory) | Mechanism candidate | Notes |
|---|---|---|---|
| Kubernetes | cluster-admin kubeconfig use, RBAC changes, Secret reads | k3s audit policy and log/webhook backend [S1, S2] | Starter policy `Metadata`; Secrets/ConfigMaps at `Metadata`; secure profile needs a rotation setting (**D2**) |
| PostgreSQL | superuser/owner connections, role/DDL changes, access to protected tables | pgaudit with classes `ROLE`, `DDL` and object auditing (`pgaudit.role`) for protected tables; `log_connections`/`log_disconnections` on [S3, S4, S5] | Keep parameter logging off [S3]; set `log_timezone` explicitly [S5] |
| Keycloak | admin console/REST actions, login events | admin events and login events with a logging listener [S6] | Exact settings need a read of the Keycloak page |
| APISIX | admin API key use, route changes | access log with a request id field and identity; admin-API access log | Format change in `apisix-gateway.yaml:60` |
| ArgoCD | sync/delete, admin login | not researched in this pass | owner follow-up |
| Kafka | ACL/authorization decisions | authorizer logging | not researched in this pass |
| OPA / Trino authz | allow/deny decisions | existing decision logs (console) [`opa.yaml:10-11`] | Collect them; confirm content |
| SeaweedFS, Lakekeeper/OpenFGA, OpenLDAP, Superset, Airflow | admin identities in the inventory | not researched in this pass | owner follow-up |

### 4.3 Database activity policy (protected data paths)

**Proposed definition**: a protected data path is any table whose registry classification is `pii` ([`policies/data-standards.yaml:28`](../policies/data-standards.yaml#L28), [`:39`](../policies/data-standards.yaml#L39)) plus every role-management and DDL action on any database.
Policy: administrative and role/DDL activity is always recorded; read/write access to protected tables is recorded by object auditing; statement text is recorded, bind parameters are not [S3]; superuser and `beluga_admin` sessions are always recorded. Scope for READ/WRITE auditing on non-protected tables is an owner decision (**D3**) because of volume.

### 4.4 Separation of routine logs and audit evidence

Audit records are tagged at source (pgaudit `logger`, Kubernetes audit file/webhook, Keycloak event type) and routed to a destination that ordinary operators cannot modify; the storage and immutability design is in [`audit-retention.md`](audit-retention.md). Routine application logs stay in container stdout.

### 4.5 Retention and review

Minimum retention and review frequency are owner values (**D1**; no official figure). Review means a named reviewer signs off on a periodic report (4.6); the sign-off is itself retained as evidence.

### 4.6 Periodic privileged-access evidence report

Read-only generator input: the inventory (system, principal, source), the per-system audit status (enabled/disabled, from live reads such as 2.2), and counts of privileged events per actor and system per period from the audit store.
Output: a deterministic report with period, UTC timestamps, per-system status, event counts, and a list of inventory rows with no audit source ("unaudited path"). This list is also the negative test of 5.2.

## 5. Verification and test ideas

1. Static: a gate that parses the inventory table and a new machine-readable audit-source map and fails when an inventory row has no audit-source entry or an entry names a setting that the render lacks.
2. Negative (secure profile): remove the pgaudit parameters or the k3s audit flags from a render and assert the gate fails.
3. Live (disposable cluster): perform a privileged action in each system and assert a structured record with all fields of 4.1 appears in the audit store.
4. Live: assert pgaudit is loaded (`SHOW shared_preload_libraries`) and that a `SELECT` on a protected table yields a `READ` record without bind values.
5. Report: golden-file test of the report generator over a fixture event set.

## 6. Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Minimum retention and review frequency | Decide with audit-retention D1; no official figure |
| D2 | Kubernetes audit policy level and rotation parameters | Start `Metadata`, Secrets/ConfigMaps `Metadata` [S1]; rotation values owner-chosen |
| D3 | READ/WRITE auditing scope beyond `pii` tables | `pii` tables and all DDL/ROLE; widen after measuring volume |
| D4 | Log pipeline/store (shared with certificate, time, audit-retention issues) | One shared decision; the five documents all depend on it |
| D5 | Whether superuser access should be break-glass only | Yes for production; record each use |
| D6 | Systems not researched here (ArgoCD, Kafka, SeaweedFS, Lakekeeper, LDAP, Superset, Airflow) | Add per-system rows after reading each official page |

## 7. Follow-up implementation tasks (ordered)

1. Enable `log_connections`/`log_disconnections` and pgaudit `ROLE`,`DDL` on a disposable cluster; acceptance: records visible with the CNPG JSON `pgaudit` logger and no bind values.
2. Add the k3s audit policy and log file on a disposable cluster; acceptance: a `kubectl get secret` yields a `Metadata` event and no payload.
3. Create the machine-readable audit-source map and the static gate (5.1) with negative fixtures (5.2).
4. Keycloak admin/login events configuration; acceptance: an admin action yields a record.
5. APISIX log format with request id and admin-API logging; acceptance: request id appears end to end.
6. Report generator (4.6) with golden-file test.
7. Research and add the unresearched systems (D6).

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Kubernetes, Auditing: https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/ |
| S2 | K3s, Hardening guide (audit logging): https://docs.k3s.io/security/hardening-guide |
| S3 | pgAudit README: https://github.com/pgaudit/pgaudit |
| S4 | CloudNativePG v1.30.0, Logging: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/logging.md |
| S5 | PostgreSQL 17, Error Reporting and Logging: https://www.postgresql.org/docs/17/runtime-config-logging.html |
| S6 | Keycloak, Server Administration Guide (auditing and events): https://www.keycloak.org/docs/latest/server_admin/#auditing-and-events |
