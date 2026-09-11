# Research Evidence

Beluga Manager follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect sanitized machine-readable evidence during normal development when practical. Useful evidence includes verify/test/integration duration and results, upstream API/correlation outcomes, runtime/performance measurements where relevant, failures/retries/recovery, and agent-assisted attempts, elapsed time, human interventions, review corrections, CI retries, and final verification.

Preserve failed and partial runs. Distinguish local/static evidence from live upstream integration evidence.

## Public-data rule

Only sanitized records may be committed publicly. Never publish credentials/tokens, private URLs/IPs/hostnames, personal/customer/employer/tenant data, proprietary payloads, confidential prompts/source, raw upstream responses, arbitrary environment dumps, or security-sensitive infrastructure details. Raw CI logs, API traces, screenshots, and security output are sensitive-by-default.

Before public storage: validate against the OpenForge schema, run secret/pattern checks, review free-form fields, normalize environment labels, and publish only aggregate or categorized measurements when raw artifacts cannot be proven safe.
