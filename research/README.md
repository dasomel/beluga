# Research Evidence

Beluga follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect sanitized machine-readable evidence during normal development when practical. Useful project evidence includes cluster install/deploy duration and result, component/E2E checks, resource usage and latency where relevant, failures/recovery/retries, release/upgrade outcomes, and agent-assisted task attempts, elapsed time, human interventions, review corrections, CI retries, and final verification.

Preserve failed/partial runs as well as successes and distinguish static/manifest validation from live-cluster evidence.

## Public-data rule

Only sanitized records may be committed publicly. Never publish credentials/tokens, private URLs/IPs/hostnames, real cluster/node names, personal/customer/employer/tenant data, proprietary datasets, confidential prompts/source, raw kubectl/Helm output, arbitrary environment dumps, firewall/topology details for real environments, or other security-sensitive infrastructure data. Raw CI logs, traces, screenshots, and security output are sensitive-by-default.

Before public storage: validate against the OpenForge schema, run secret/pattern checks, normalize environment labels, review free-form fields, and publish aggregate measurements when raw artifacts cannot be proven safe.
