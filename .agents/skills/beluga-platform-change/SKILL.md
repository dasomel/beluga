---
name: beluga-platform-change
description: Change or debug Beluga data-platform components while preserving VERSIONS.md ownership, GitOps/self-heal behavior, shared kubeconfig safety, namespace/service contracts, and direct plus user-entry-path verification. Use for component versions, GitOps manifests, cluster configuration, gateway/auth, or live platform fixes.
license: Apache-2.0
compatibility: Requires the Beluga checkout and project validation tools; live verification requires access to the Beluga Kubernetes cluster.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/beluga
  openforge-maturity: verified
  openforge-version: "1"
---

# Beluga Platform Change

## Use When

- Changing a platform component, image/version, GitOps manifest, cluster configuration, namespace/service wiring, gateway, or auth behavior.
- Diagnosing a Beluga live-cluster issue whose fix belongs in repository configuration.

## Do Not Use When

- The task is only documentation prose unrelated to platform behavior.
- The work belongs to Beluga Manager's unified domain/control-plane repository rather than the Beluga data platform.

## Inputs

- Relevant issue/spec and platform design.
- Current component/version entry in `VERSIONS.md`.
- Target cluster context and affected user-facing domain, if any.

## Workflow

1. Read `AGENTS.md`, `VERSIONS.md`, the matching section of `docs/mistakes-log.md`, and the relevant platform design/plan.
2. Create an isolated kubeconfig from the `beluga` context before live work; do not mutate the shared `~/.kube/config`.
3. Treat `VERSIONS.md` as the component/image version source of truth and update every repository reference that must move with it.
4. Determine GitOps ownership before applying a live change. `beluga-platform` / `beluga-data` self-heal, so persistent fixes must be committed to the owning source and verified through ArgoCD rather than relying on ad-hoc `kubectl apply`.
5. Preserve namespace/service boundaries and use service FQDNs for cross-namespace references.
6. For ConfigMap-driven runtime changes, explicitly verify whether the workload requires a rollout restart.
7. Run the project's static/manifest gates such as `make lint` / `make validate` and the relevant real-state tests under `tests/` or `make test`.
8. For gateway/auth changes, test both the component directly and the documented domain-registry entry path. Do not infer user-path success from Pod or ArgoCD health.
9. Record a new discriminator in `docs/mistakes-log.md` when the task exposes a reusable failure pattern.

## Verification

Report evidence by class: static/lint, manifest/render, live cluster, and manual gateway/auth entry path. Never imply that a lower class proves a higher one.

## Stop / Escalate When

- The change widens RBAC/permissions, changes GitOps ownership, or introduces destructive cluster behavior without an approved design.
- The shared environment cannot be safely isolated or the active cluster context is uncertain.
- The intended gateway/auth behavior cannot be measured from the actual entry point.

## References

- `AGENTS.md`
- `VERSIONS.md`
- `configs/cluster.env`
- `docs/mistakes-log.md`
- `tests/`
