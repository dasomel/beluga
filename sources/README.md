# Source registration preflight — shop CDC (#71 slice)

`shop/shop-cdc.json` is the executable example for the existing PostgreSQL source.
JSON keeps the manifest and validator readable with Python's standard library;
this is a scoped implementation of the registration proposal in
[source onboarding and intake](../docs/source-onboarding-and-intake.md), not its
complete schema or a new deployment input.

Run from the repository root (also run by `make validate`):

```sh
python3 scripts/ci/check-source-onboarding.py
python3 tests/test_source_onboarding.py
```

The manifest records source identity, owner, class/mode, database, topic prefix,
freshness/retention targets, source/table/column classifications and key fields.
Values follow [data standards](../docs/data-standards.md) (#33): `internal` or
`pii`; source/table classifications must cover their PII children. Owner and
classification values initially mirror `policies/data-standards.yaml`; this
validator checks presence and coverage, not synchronization with that YAML policy
or a runtime catalog. Duration targets accept positive `PnD` or `PTnH/M/S` only.

Preflight reads the **actual** JSON heredoc and PUT connector name in
`gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`. Tables and topic prefix
must match exactly (table order is ignored). Default Debezium record keys come
from inline primary keys in `gitops/charts/beluga-data/files/shop-schema.sql`;
the manifest must match those keys and classify every selected DDL column.
Missing files/fields, unknown fields/classifications, duplicate JSON keys, key overrides,
transforms and unsupported DDL/heredoc forms fail with exit 1. Exit 0 means a
static contract match. Bad-case fixtures apply mutations to the good manifest
or actual repository inputs; every case must exit 1 with its expected diagnostic.

The manifest contains no credentials. The existing registration Job obtains its
password from `postgres-admin-credential/password` via `PGPASSWORD`; its current
admin user and injection mechanism are unchanged and are not security-certified
by this check. Secrets must remain in the governed Kubernetes Secret path, never
in a registration manifest. This slice does not validate credential privileges,
rotation, or live connectivity.

Update the manifest with reviewed connector/DDL changes and rerun preflight.
This adapter supports only shop PostgreSQL CDC; adding a source requires its own
adapter and fixtures. It does not create Bronze datasets, add ingestion metadata,
publish lineage (#19), enforce quality (#20) or PII lifecycle (#30), implement
replay/backfill, or complete the heterogeneous framework (#71). The existing
Silver-like pipeline remains as described in [Medallion architecture](../docs/medallion-architecture.md)
(#70); ownership here is visible in Git only.
