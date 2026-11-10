# ADR-0008: Dedicated Iceberg maintenance service identity

English | [한국어](0008-iceberg-maintenance-service-identity-ko.md)

- Status: Accepted
- Date: 2026-11-10
- Supersedes: —
- Superseded by: —

Decision IDs: D-MAINT-1 (identity), D-MAINT-2 (procedure grants), D-MAINT-3 (pod/TLS),
D-MAINT-4 (missing tables), D-MAINT-5 (live procedure input). Owner: dasomel, 2026-11-10, issue #387.

## Context

The hourly `iceberg_table_maintenance` DAG used an unauthenticated HTTP Trino CLI
against an OAuth2/PASSWORD server and had no table-procedure authorization. It had
never run. Copy the service-identity contract from [ADR-0007](0007-dbt-core-transformation-layer.md)
D-DBT-9–15 without borrowing dbt's data privileges or changing browser authentication.

## Decision

### D-MAINT-1: Dedicated principal, group and credential

Keycloak confidential client `maintenance` enables service accounts only, with no
login flows, redirects, full scope or linked shared scopes. Dedicated mappers emit
`preferred_username=svc-maintenance` in access tokens and UserInfo and audience
`trino`. The existing subset mapper comparison and scope reconciliation iterate a
small service-identity table shared with dbt; dbt's declared settings stay identical.
LDAP seeds/resyncs passwordless `svc-maintenance` in `maintainers`; LDAP remains the
group source. There are no role inheritance edges or human memberships.

Bootstrap `ensure_cred client-secret-maintenance` supplies fresh and existing clusters
from `platform-system/beluga-credentials`, then copies only to
`iam` and `analytics` as `keycloak-maintenance-client-secret/maintenance`.
The credential never enters shared `keycloak-client-secrets` or logs.
Cost: one identity and two Secret copies. Escape hatch: retire these together.

### D-MAINT-2: Explicit table AND procedure allowlists

`procedureGrants` names catalog `iceberg`, tables `lake.orders`, `lake.customers`,
`lake.events_enriched`, `silver_shop.orders`, `gold_shop.daily_revenue`, and procedures
`optimize`, `expire_snapshots`. Wildcards are rejected. The generated OPA
`ExecuteTableProcedure` rule requires both the exact table and procedure; it examines
`resource.table.{catalogName,schemaName,tableName}` and
`lower(resource.function.functionName)` (live input corrected in D-MAINT-5).
Only `ExecuteQuery`, `AccessCatalog` and `FilterCatalogs` for `iceberg` accompany it.
No table SELECT, INSERT, DELETE, CREATE or DROP is granted, including PII customers.
The direct Python client does not require adapter metadata queries, so fixed system
metadata grants are omitted. Manager's overview lists exact table/procedure pairs.
Cost: explicit inventory maintenance. Escape hatch: separately reviewed grants based
on observed operations; never pre-grant extra data privileges.

### D-MAINT-3: Airflow pod, verified TLS and private token bootstrap

Keep the hourly DAG ID, `catchup=False`, paused on creation, `max_active_runs=1`.
KubernetesPodOperator in `analytics` uses the same tag+digest `beluga-dbt` image as
dbt. Python pops the Secret from its environment, requests `client_credentials` with
`scope=openid` from the internal Keycloak token URL, and connects as `svc-maintenance`
with JWT authentication to `https://trino.analytics.svc.cluster.local:8443`, verifying
`/etc/internal-ca/ca.crt` from read-only `beluga-internal-ca`. Trino OAuth2/UserInfo
configuration remains unchanged. Each table runs optimize then expire_snapshots with
`retention_threshold => '7d'`, consuming results. Pod specs are not logged on failure;
pods are deleted on finish. No token/secret is printed.
Cost: one token must outlive the run (realm default 300 seconds).
Escape hatch: reviewed refresh if runs exceed that lifetime, never disable TLS checks.

### D-MAINT-4: Skip only missing tables

A fresh cluster may lack dbt output tables. Catch only Trino `TABLE_NOT_FOUND` per
table, skip its remaining procedures and continue; every other error fails the task.
Cost: an absent table waits until the next run. Escape hatch: require output presence
once all producers are operational.

### D-MAINT-5: Match the captured live procedure input

On 2026-11-10, the first colima run with Trino 483 + OPA authenticated
`svc-maintenance` with groups `[maintainers]`, passed TLS and `ExecuteQuery`, then
received `PERMISSION_DENIED: Cannot execute table procedure OPTIMIZE on iceberg.lake.orders`.
The captured decision-log `input.action` was:

```json
{"operation":"ExecuteTableProcedure","resource":{"function":{"functionName":"OPTIMIZE"},"table":{"catalogName":"iceberg","schemaName":"lake","tableName":"orders"}}}
```

Reason: documentation-derived `function.name` fixtures hid the real serialized field
and uppercase procedure name. Compile `lower(input.action.resource.function.functionName)`
against the declared lowercase names; retain exact table and group checks. Missing
`functionName`, including the old `.name` shape, is denied without a fallback.
Cost: maintain fixtures captured from live decision logs and replay upper/lowercase
allow cases and deny boundaries with OPA. Escape hatch: review a new captured input
when Trino changes its contract, then update compiler and fixtures atomically;
never broaden grants to bypass a shape mismatch.

## Consequences and verification

Offline compilation, OPA allow/deny cases, three-profile identity renders and synthetic
DAG execution verify the declared contract, not live deployment. Additional operations
for `ALTER TABLE ... EXECUTE optimize` (e.g. InsertIntoTable or SelectFromColumns):
**to be confirmed from live OPA decision log**. No such privilege is pre-granted.
The supplied colima evidence confirms token acceptance, `maintainers` groups, TLS
and `ExecuteQuery` before the procedure denial. The corrected procedure rule, gateway
path, compaction and snapshot effects remain unverified live in this change.

On an authorized rollout, populate the dedicated Secrets before syncing the client
Job/DAG; verify the Keycloak and LDAP reconcile Jobs. Restart Airflow after its DAG
ConfigMap changes. Unpause and manually trigger `iceberg_table_maintenance`, then run
`MAINT_RUN_ID=<run-id> bash tests/28-iceberg-maintenance.sh` with an isolated kubeconfig.
It observes run success and gateway SELECT denial on `iceberg.lake.orders`;
without MAINT_RUN_ID it skips before cluster access. Inspect live OPA decisions before
changing privileges. Rollback: revert source, keep the DAG paused, and remove unused
credential copies/identity only through an authorized rollout.
