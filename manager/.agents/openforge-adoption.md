# OpenForge adoption

Follow the canonical OpenForge standards:
- https://github.com/dasomel/openforge/blob/main/docs/model-agnostic-agent-instructions.md
- https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
- https://github.com/dasomel/openforge/blob/main/docs/user-centric-validation.md

Keep Beluga Manager domain/API/correlation/upstream-adapter invariants local. Model/tool files are thin adapters. For upstream integration, correlation, auth/RBAC, UI/API, install/configuration, and upgrade changes, use risk-proportional validation and verify the real producer/consumer path where unit tests cannot prove it. Confirmed user-visible defects become regression evidence.

Safe local/disposable work within scope may proceed autonomously. Shared/production mutation, destructive external actions, release/publish, credential/permission widening, or unrelated external mutation requires explicit authorization unless already granted.
