# ADR-0004: DuckDB as a complementary lightweight analytics engine

- Status: Accepted
- Date: 2026-10-07
- Supersedes: —
- Superseded by: —

Refs #61. Owner decision: adopt DuckDB **alongside** Trino, not as a replacement.
This ADR records the decision and the adoption plan only; it changes no manifest, code
or `VERSIONS.md`.

## Context

Trino is Beluga's only SQL engine for the Iceberg data plane (`06-trino.yaml`). It is the
right tool for shared, concurrent, federated and BI workloads, but it is an always-on
distributed JVM service. For local, ad-hoc, notebook, CI-validation and small ETL/ELT
work that cost is disproportionate, especially on the small profiles.

How the current path is secured matters for this decision:

- **Catalog**: Trino authenticates to Lakekeeper with its own OIDC client
  (`iceberg.rest-catalog.security=OAUTH2`, client-credentials against Keycloak, scope
  `lakekeeper`; principal `service-account-trino`). Lakekeeper authorizes every catalog call
  through OpenFGA (`lakekeeper.openfga.enabled: true` in `values.yaml`; D14 keeps `allowall`
  only as the opt-out).
- **Storage**: Trino additionally holds a static S3 key (`trino-s3-credential`,
  `s3.aws-access-key` in `06-trino.yaml`). That key is a bypass of the catalog authorization
  for any holder. DuckDB must **not** copy that pattern.
- **Network**: `04b-lakehouse-network-policy.yaml` allows Lakekeeper `:8181` ingress only from
  Trino, Flink, APISIX and the bootstrap job. Airflow is deliberately absent (no
  Lakekeeper reference in `07-airflow.yaml`).

## What the official documentation says (accessed 2026-10-07)

| Topic | Documented | Source |
|---|---|---|
| Catalog attach | `ATTACH 'warehouse' AS x (TYPE ICEBERG, SECRET s, ENDPOINT 'url')`; catalog-attached tables unlock the full feature set | [catalogs](https://duckdb.org/docs/current/core_extensions/iceberg/catalogs.html), [overview](https://duckdb.org/docs/current/core_extensions/iceberg/overview) |
| Auth | `CREATE SECRET (TYPE ICEBERG, CLIENT_ID, CLIENT_SECRET, OAUTH2_SERVER_URI[, OAUTH2_SCOPE])` for OAuth2 client credentials; `TOKEN` for a bearer token; `sigv4` for AWS | same catalogs page |
| Lakekeeper | The catalogs page contains a Lakekeeper example using the OAuth2 secret above. Lakekeeper lists DuckDB among supported engines | catalogs page; [Lakekeeper docs](https://docs.lakekeeper.io/), [engines](https://docs.lakekeeper.io/docs/latest/engines/) |
| Vended credentials | DuckDB documents `ACCESS_DELEGATION_MODE 'vended_credentials'` in a Polaris example. The Lakekeeper engines page, as read, "doesn't explicitly discuss vended credentials for DuckDB" and implies separate S3 credentials | catalogs page; Lakekeeper engines page |
| Storage backends | "DuckDB supports Iceberg REST Catalogs backed by S3, S3 Tables, and Google Cloud Storage (GCS). Support for other storage backends is not yet available." | catalogs page |
| S3-compatible | S3 secret has `ENDPOINT`, `URL_STYLE` (`path`), `USE_SSL`; SeaweedFS is listed as "should also work, but not all features may be supported" | [S3 API](https://duckdb.org/docs/current/core_extensions/httpfs/s3api) |
| Writes | Supported via an attached REST catalog: INSERT/UPDATE/DELETE/MERGE, DDL, schema evolution; Iceberg format v2 and v3. Merge-on-read only (positional deletes); fails on tables with other `write.update.mode`/`write.delete.mode`; some target-size properties unsupported on partitioned tables. Concurrency/commit semantics are not detailed | [writing](https://duckdb.org/docs/current/core_extensions/iceberg/writing.html) |
| Direct reads | Read-only; need a version hint or explicit `version`; only gzip metadata | overview |
| Compatibility flags | `STAGE_CREATE_TABLES`, `DISABLE_MULTI_TABLE_COMMIT`, ... for catalogs with partial REST support | catalogs page |
| License | MIT (Copyright Stichting DuckDB Foundation) | [LICENSE](https://github.com/duckdb/duckdb/blob/main/LICENSE) |
| Releases | Feature releases with tentative dates; every other version from 1.4.0 is LTS (1.4.0 LTS community support to 2026-11-17); latest listed 1.5.6 (2026-09-28); 2.0.0 tentatively 2026-10-21 | [release calendar](https://duckdb.org/release_calendar.html) |

**Experimental status.** The overview page, as read, carries no experimental warning for
the iceberg extension. That absence is not a stability guarantee. Not verified from
documentation, therefore treated as **unproven for Beluga** until the PoC (task 5):
(a) the Lakekeeper + OAuth2 attach against Beluga's Keycloak; (b) vended credentials
against Lakekeeper with SeaweedFS (the SeaweedFS S3 note is "not all features may be
supported", and the storage-backend limitation names S3/S3 Tables/GCS only); (c) write
commits against Lakekeeper under concurrency. The 2.0.0 release is imminent, so the
extension's behavior may change; pin the version.

## Decision

1. Adopt DuckDB as a **complementary** embedded query engine. Trino stays the supported
   centralized engine; nothing is removed or deprecated.
2. DuckDB runs **embedded in clients and jobs**, not as an always-on service. DuckDB/Quack
   server mode is out of scope and is evaluated separately after the embedded path is proven.
3. DuckDB accesses Iceberg **only through Lakekeeper** (`ATTACH ... TYPE iceberg`), so
   OpenFGA authorizes it exactly like Trino and Flink.
4. **Read-only first.** Writes are enabled per use case only after the write limitations
   and concurrency behavior are evidenced (task 8).
5. Workload selection follows the table below. When in doubt, Trino.

### DuckDB vs Trino

| Workload | Engine | Why |
|---|---|---|
| Notebook / ad-hoc exploration of one user | DuckDB | no shared cluster needed |
| CI validation of Iceberg data / schema contracts | DuckDB | startup in seconds, no Trino worker |
| Airflow task, small transform on a table that fits one node | DuckDB | no Trino dependency for the DAG |
| Local / smallest Beluga profile without Trino workers | DuckDB | lets the profile drop an always-on JVM service |
| BI dashboards (Superset), many concurrent users | Trino | concurrency and shared governance |
| Federated queries across catalogs/sources | Trino | connectors |
| Tables or scans beyond one node's memory/disk | Trino | distributed execution |
| Row/column policies enforced by the Trino OPA layer | Trino | DuckDB is not covered by that layer (see Security) |
| Streaming writes, high-frequency commits | Flink | not a DuckDB use case |

## Security requirements (normative)

1. DuckDB clients authenticate as **their own OIDC client** (a distinct Keycloak
   client-credentials client per operational form, e.g. `duckdb-airflow`, `duckdb-ci`), never
   by reusing the Trino or Flink client. Human notebook use should use a user-scoped token
   (bearer `TOKEN`) so OpenFGA sees the real user; the choice is Q2.
2. Authorization is decided by **OpenFGA via Lakekeeper**. Each DuckDB principal gets
   explicit **table-level** read grants in the same model as the existing principals; no
   warehouse- or namespace-level grants, because Lakekeeper inherits `select` downward to
   every child table ([authorization-openfga](https://docs.lakekeeper.io/docs/latest/authorization-openfga/))
   and the `lake` namespace holds PII tables (`lake.customers` is `classification: pii` in
   `policies/resources.yaml`, masked or denied by Trino OPA by role). PII tables are
   excluded. No `allowall` fallback.
3. **No static admin S3 keys** in DuckDB jobs, notebooks or CI. Storage access must come from
   Lakekeeper-vended credentials. Today the `lake` warehouse is created with
   `"sts-enabled": false` and a static access key (`12-lakekeeper-bootstrap.yaml`), and
   Lakekeeper documents vending as STS-based, with "not all S3 compatible object stores
   support AssumeRole" ([storage](https://docs.lakekeeper.io/docs/latest/storage/)). Vending is
   therefore **not available today**. If SeaweedFS cannot vend scoped credentials (decided in task 1),
   DuckDB stays blocked for production and PII-bearing data rather than falling back to a
   static key (a bucket-scoped key can read PII files in the same `beluga-lake` bucket without
   Lakekeeper authorization, defeating table-level grants). The only permitted static key is
   one scoped to a **dedicated non-PII test warehouse/bucket with synthetic data**, used for
   the PoC and CI validation only; any other exception requires a new ADR. Note the existing Trino static key is a known gap that this
   ADR does not widen.
4. Secrets are delivered the same way as other client secrets (`keycloak-client-secrets`
   pattern, ADR-0002); never committed, never in notebook outputs.
5. Network: a DuckDB client pod needs ingress to `lakekeeper:8181` (policy
   `lakekeeper-ingress` currently names only trino, flink, apisix, bootstrap), egress to
   Keycloak for tokens, and egress to `seaweedfs-s3:8333`. Each in-cluster form needs its
   own explicit allow rule; do not open the namespace.
6. DuckDB sits outside the Trino OPA layer (`trino.rego`). Anything enforced only there
   (row filters, column masks) is **not** enforced for DuckDB. Until equivalent controls are
   proven, DuckDB principals get grants only on data without such policies.
7. Regression tests (task 7): an unauthorized principal is denied at the catalog; the PII
   table `lake.customers` is **denied** to the DuckDB client (not merely other namespaces);
   a read-only principal cannot write; no admin S3 key is present in the client environment.
   The real-`lake.customers` DENY test is required (table-level grants exclude PII)
   **independent of credential vending**; the PII test table of task 2 only substitutes for
   it in the exception PoC, never as completion evidence for production access.

## Operational forms

| Form | Phase 1 | Notes |
|---|---|---|
| CLI / Python on a developer machine against the cluster | Phase 2 | not phase 1: the warehouse S3 endpoint is cluster-internal DNS (`seaweedfs-s3.storage.svc.cluster.local:8333`, `12-lakekeeper-bootstrap.yaml`), so a laptop may reach the catalog but not the data files. Needs a designed path (S3 endpoint reachability or a vended endpoint override) first |
| CI validation | Yes (read-only), in-cluster or against a test stack | the runner must reach both Lakekeeper and the S3 endpoint; ephemeral client; test warehouse |
| Notebook | Phase 2 | no notebook service exists in Beluga today |
| Airflow task | Phase 2 | needs a Lakekeeper ingress rule and a dedicated client; blocked on credential vending proof and, by default, on #70 (Q5) |
| Small ETL/ELT writes | Phase 3 | only after task 8 |
| DuckDB/Quack server mode | Out of scope | separate evaluation |

Dependency on #70 (medallion): which layers DuckDB may read or write (for example read bronze/
silver, write only designated sandbox or gold namespaces) is defined by the medallion
namespace layout. Tasks 1-7 do not depend on #70; task 8 and the Airflow form do. Default: the Airflow form
waits for #70 unless the owner answers Q5 "sandbox first".

## Alternatives considered

- **Do nothing** — rejected by the owner decision; light profiles keep paying for Trino.
- **Replace Trino with DuckDB** — rejected: DuckDB runs concurrent queries within one
  process but has no shared multi-user server/BI service model, no federation and no
  distributed execution; breaks Superset and the OPA enforcement path.
- **DuckDB reading Parquet/Iceberg directly with a static S3 key** — rejected: bypasses
  Lakekeeper/OpenFGA and the credential model of ADR-0002.
- **DuckDB server mode as a shared service** — deferred: re-creates an always-on service and
  needs its own authn/authz story.
- **PyIceberg / Spark local mode** — not evaluated here; heavier or less SQL-oriented. Can be
  revisited if the PoC fails.

## Consequences

- Light profiles and CI can run analytics without a Trino worker.
- A second engine to document, pin and test, and a decision table users must follow.
- Governance coverage is uneven: Lakekeeper/OpenFGA applies to both engines, the Trino OPA
  policies only to Trino (security item 6).
- A new `VERSIONS.md` row (DuckDB and the pinned `iceberg` extension, MIT) is required at
  implementation time. Not edited in this PR.
- The extension may break across the imminent 2.0.0; pinning and a regression test are
  mandatory.

## Risks

| Risk | Mitigation |
|---|---|
| iceberg extension maturity / Lakekeeper interoperability unproven in Beluga | PoC first (task 5); pin versions |
| Vended credentials with SeaweedFS may not work | prove before any in-cluster form on production/PII paths; otherwise stay blocked (security item 3). The only exception is the non-PII test-bucket key (task 1) |
| Write limits: merge-on-read only, fails on other write modes, undocumented concurrency | read-only first; evidence before enabling writes |
| Bypass via raw S3 keys by convenience | CI check that production/PII-path DuckDB clients carry no S3 secret; the documented non-PII test-key exception is exempt from that check but a CI check must verify the key is scoped to the test bucket only; docs |
| Users pick DuckDB for the wrong workload | decision table in user docs |
| Lakekeeper ingress opening widens the attack surface | one rule per client; reviewed like the existing ones |

## Follow-up implementation tasks (ordered)

1. **Storage credential decision (prerequisite to the PoC)**: determine whether SeaweedFS
   supports STS/AssumeRole so a warehouse can enable `sts-enabled` and vend scoped
   credentials. If not, record the Q1 decision: the PoC and CI use only a static key scoped to
   the dedicated non-PII test bucket (task 2); production/PII data stays blocked until vending
   exists. Acceptance: recorded owner decision plus evidence (STS call result against
   SeaweedFS, or the test key's bucket/prefix limits).
2. **Dedicated non-PII test warehouse/bucket** with synthetic data (including an
   `customers`-like table marked PII to prove denial). Acceptance: the warehouse exists in
   Lakekeeper; its bucket holds no production data.
3. **Keycloak client + OpenFGA grants** for the `duckdb-*` test principal: read-only,
   **table-level**, PII tables excluded. Acceptance: the principal reads a granted test table;
   the PII test table and other warehouses/namespaces are denied by Lakekeeper.
4. **Network policy** (rules live where the enforced pod runs; the DuckDB client may sit
   outside `lakehouse`): (a) **ingress** on `lakehouse/lakekeeper:8181`, added to
   `lakekeeper-ingress` in `04b-lakehouse-network-policy.yaml`, allowing the DuckDB client's
   namespace/pod selector; (b) **egress** from the client pod's namespace to `iam/keycloak:8080`
   for tokens; (c) **egress** from the client pod's namespace to `storage/seaweedfs-s3:8333`
   (plus any ingress policy the `storage` namespace enforces). Acceptance: `make validate`
   passes and a connection from an unlisted pod is refused.
5. **PoC attach** (all prerequisites in tasks 1-4 done): DuckDB CLI attaches Lakekeeper with the
   dedicated client and reads one test table, with vended credentials if task 1 proved them,
   otherwise the test-bucket-scoped key. Acceptance: row count equals the Trino result on the
   same data; exact DuckDB and extension versions recorded.
6. **VERSIONS.md row + docs**: version pin, decision table in user docs (en/ko), usage recipe.
7. **Security regression tests**: unauthorized denied, the real `lake.customers` PII table
   denied to the DuckDB client **regardless of whether vending exists** (the task 2 PII test
   table is only the substitute inside the exception PoC), read-only cannot write, no admin S3
   key in the client environment, and the test-bucket key (if used) verified scoped to the test
   bucket only. Acceptance: tests run in CI.
8. **Write evidence**: INSERT/MERGE against a sandbox namespace, concurrent commit with Trino
   or Flink reading. Acceptance: documented outcome and limits; depends on #70 for namespace.
9. **CI validation job** using DuckDB read-only on the test warehouse. Acceptance: a
   schema-contract check passes without a Trino worker.
10. **Benchmark** (issue #61 criterion): same workloads on DuckDB vs Trino on supported
    profiles: CPU, memory, I/O, startup, latency, concurrency. Acceptance: report with
    sizing targets.
11. **Local CLI path design, then Airflow task form** (phase 2; the Airflow form waits for #70
    unless Q5 is answered "sandbox first"). Acceptance: a laptop reaches both catalog and data
    files by a documented path; a DAG task reads a table through its own client.
## Open owner questions

| ID | Question | Why it matters |
|---|---|---|
| Q1 | Can SeaweedFS be made to support STS/vended credentials? If not, confirm that DuckDB is limited to a dedicated non-PII test warehouse/bucket (static scoped key) and is held for production/PII data until vending exists. | Security item 3: production/PII data requires vended credentials; any other exception needs a new ADR. |
| Q2 | Human notebook/CLI auth: user bearer tokens (real user in OpenFGA) or a shared per-team client? | Audit attribution. |
| Q3 | Which Trino-OPA row/column policies exist today that DuckDB would bypass, and which datasets are therefore off-limits? | Security item 6. |
| Q4 | Pin to 1.4 LTS (support to 2026-11-17) or move to 2.x after 2.0.0? | Release cadence vs extension stability. |
| Q5 | Default: the Airflow form waits for #70. Answer "sandbox first" to let it proceed earlier on a sandbox namespace. | Scoping of phase 2. |
