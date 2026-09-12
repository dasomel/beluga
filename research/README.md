# Research Evidence

Beluga follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect machine-readable evidence during normal development when practical. Useful evidence includes cluster install/deploy duration/results, component/E2E checks, resource usage/latency, failures/recovery/retries, release/upgrade outcomes, and agent-assisted attempts/interventions/review corrections/CI retries/final verification. Preserve failed/partial runs and distinguish static/manifest validation from live-cluster evidence.

## Legacy evidence on discovery

During implementation, fixes, verification, releases, upgrades, or documentation work, also catalog existing install reports, cluster verification results, test/CI outputs, upgrade/recovery records, benchmarks, dated implementation evidence, and lessons encountered from earlier work. Preserve originals and classify them instead of rewriting history.

Use `dasomel/openforge#89` as the portfolio-level legacy catalog source of truth. Record source/path, known date, evidence class/strength, environment scope, metrics/facts, limitations, and likely paper use. Never infer measurements that were not recorded. Keep failed, partial, superseded, and older-version results when they provide longitudinal evidence.

## Public-data rule

This is a personal OSS/test environment. RFC1918 test addresses, `*.local.*` domains, cluster/node/pod/namespace names, local topology, component versions, and reproducibility-relevant runtime details may remain when intentionally part of the public project.

Never publish actual secrets/credentials/tokens/private keys/kubeconfig credentials or accidental personal data. Review future third-party/non-public environment artifacts separately. Validate structured evidence against the OpenForge schema and run secret/pattern checks before publication.