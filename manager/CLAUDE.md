@AGENTS.md

> This thin adapter is intentionally retained because the repository verification contract currently expects it. Keep portable policy in `AGENTS.md`; remove this file only together with the verifier requirement.

# Beluga Manager Claude adapter

The project skill is intentionally `draft`; its promotion bar lives in the skill itself. Do not compensate by adding prompt-only completion rules.

Keep Claude-specific orchestration in runtime-specific rules/harness files if added later; repository architecture and access boundaries remain in `AGENTS.md`.
