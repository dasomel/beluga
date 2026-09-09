@AGENTS.md

# Beluga Manager Claude adapter

For upstream OSS adapters, discovery/correlation, Beluga domain/API, or Manager UI integration work, load `.agents/skills/beluga-manager-integration-contract/SKILL.md`.

The project skill is intentionally `draft` until Beluga Manager has a stable repository-owned deterministic verification entrypoint and the workflow is replayed from a fresh context. Do not compensate by adding prompt-only completion rules.

Keep Claude-specific orchestration in runtime-specific rules/harness files if added later; repository architecture and access boundaries remain in `AGENTS.md`.
