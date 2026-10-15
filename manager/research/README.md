# Research Evidence

Beluga Manager follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect machine-readable evidence during normal development when practical. Useful evidence includes verify/test/integration duration/results, upstream API/correlation outcomes, runtime/performance measurements, failures/retries/recovery, and agent-assisted attempts/interventions/review corrections/CI retries/final verification. Preserve failed/partial runs and distinguish local/static evidence from live integration evidence.

## Legacy evidence on discovery

During implementation, fixes, verification, releases, or documentation, catalog existing verification reports, integration/API results, CI outputs, runtime measurements, failure/recovery records, and dated implementation evidence encountered from earlier work. Preserve the original artifact and classify it instead of rewriting it.

Use `dasomel/openforge#89` as the portfolio-level legacy catalog source of truth. Record source/path, known date, evidence class/strength, environment scope, metrics/facts, limitations, and likely paper use. Do not infer missing historical values. Retain negative, partial, and superseded evidence when it remains useful longitudinally.

## Public-data rule

This is a personal OSS/test project. Public local API endpoints, RFC1918 addresses, service/pod/node names, local topology, and reproducibility-relevant runtime details may remain when intentionally part of the project.

Never publish actual secrets/credentials/tokens/private keys or accidental personal data. Review future third-party/non-public artifacts separately. Validate structured evidence against the OpenForge schema and run secret/pattern checks before publication.