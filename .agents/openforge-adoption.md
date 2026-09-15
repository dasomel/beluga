# OpenForge adoption

Follow the canonical OpenForge standards:
- https://github.com/dasomel/openforge/blob/main/docs/model-agnostic-agent-instructions.md
- https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
- https://github.com/dasomel/openforge/blob/main/docs/user-centric-validation.md

Keep Beluga GitOps, version-source, namespace, gateway/auth, and shared-cluster invariants local. Model/tool files are thin adapters. For cluster install/configuration, GitOps, data services, gateway/auth, upgrade, and user-facing changes, use risk-proportional validation against the documented user entry path and clean/fresh state where practical. Static/manifest green does not prove live cluster behavior. Confirmed user-visible defects become regression evidence.

Safe local/disposable work within scope may proceed autonomously. Shared/production cluster mutation, destructive external actions, release/publish, credential/permission widening, or unrelated external mutation requires explicit authorization unless already granted.
