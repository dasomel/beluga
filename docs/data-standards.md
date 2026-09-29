# Data Standards Baseline

English | [한국어](data-standards-ko.md)

This bounded Issue #33 slice makes five persistent, access-policy-visible tables conformant and measurable. The authoritative, machine-readable contract is [`policies/data-standards.yaml`](../policies/data-standards.yaml); this document explains it and does not duplicate its values.

## Scope and representative schemas

| Estate | Representative tables | Authoritative DDL |
|---|---|---|
| PostgreSQL source | `public.customers`, `public.orders` | `gitops/charts/beluga-data/files/shop-schema.sql` |
| Iceberg canonical | `lake.customers`, `lake.orders`, `lake.events_enriched` | `gitops/charts/beluga-data/files/flink-sql/*.sql` |

These are the persistent tables declared in `policies/resources.yaml` and used by platform access policy. Flink connector-local tables (`cdc_*_source`, `kafka_clickstream`) and the derived Kafka topics are transport schemas, not durable governed datasets in this slice. A future expansion must add them deliberately rather than treating their wire encoding as canonical data metadata.

## Naming and domains

Schema, table, and column identifiers use lower `snake_case`, begin with a lower-case letter, and contain only lower-case letters, digits, and underscores. The existing representative DDL establishes these terms: `_id` denotes an entity identifier; `_at` denotes an instant and must use a timestamp type; `_date`, when introduced, denotes a calendar date and must use `DATE`. No representative field currently uses `_date`.

New reserved SQL identifiers are prohibited. No deliberate exception exists in the persistent representative scope. The quoted Flink transport field ``timestamp`` remains out of scope because it mirrors the producer payload; it is not a precedent for durable datasets.

## Required metadata

Every table must declare `owner`, `classification`, `description`, `retention`, and `freshness`; every column must declare `description` and `classification`. Values live in the YAML registry. `classification` is one of the policy's allowed values; `retention` and `freshness` must match its ISO-8601 duration pattern. This baseline treats each selected persistent dataset as applicable for both values. Physical enforcement of retention or freshness is not implied by declaring a target.

## Conformance and completeness

`python3 scripts/ci/check-data-standards.py` strips SQL comments before parsing every non-temporary `CREATE TABLE` statement in each selected DDL file, including column-list, `IF NOT EXISTS`, CTAS, and `LIKE` forms. Temporary tables and temporary views are explicitly excluded because they are non-durable execution objects, not governed datasets. Every in-scope created table requires a one-to-one registry entry, so new unregistered durable DDL (including CTAS) and stale registry entries fail. When a form does not declare columns that the checker can validate (for example CTAS or `LIKE`), it also fails closed with an explicit `unsupported DDL form` diagnostic rather than being ignored. The checker then checks naming, suffix types, and metadata. It prints per-table completeness as present required fields divided by all required table and registered-column fields; it fails below the YAML threshold.

The YAML `baselines` list is a ratchet for genuine existing violations: every entry requires an issue and reason, must still match exactly one observed violation, and cannot suppress a new violation. It is empty because all five selected schemas conform. The checker is part of `make validate`.

Approval history, source-to-canonical mapping catalogues, compatibility approvals, and OpenMetadata integration remain out of scope for this slice.
