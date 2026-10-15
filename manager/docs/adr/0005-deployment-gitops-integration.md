# ADR-0005: Deployment & GitOps Integration with Beluga

- **Status**: Proposed — design direction only; no chart, Application, or API is implemented by this ADR.
  Phase 1 (container images, commit `37e8507`) is already shipped.
- **Date**: 2026-10-01
- **Issue**: [#25 \[ROADMAP\]\[ARCH\] Deployment & GitOps Integration with Beluga](https://github.com/dasomel/beluga-manager/issues/25)
- **Parent epic**: #1
- **Related**: [ADR-0002](0002-backend-api-technology.md) (backend stack), `packages/domain-api`
  (code: reads `PORT`, serves `GET /api/v1/health`), root workspace `AGENTS.md` (Seam: `*.local.beluga.internal` HTTPS 443 boundary)
- **Deciders**: dasomel

## Context

Beluga (`beluga/`) owns cluster provisioning and GitOps: an ArgoCD app-of-apps
(`gitops/apps/app-of-apps.yaml`, `beluga-root`, automated prune + selfHeal) that renders one
`Application` per chart (`beluga-platform`, `beluga-data`) from `gitops/charts/<name>` of
`https://github.com/dasomel/beluga.git`, with `CreateNamespace=true` and `ServerSideApply=true`.
Component versions are pinned in `beluga/VERSIONS.md`. ArgoCD itself is reachable at
`https://argocd.local.beluga.internal`.

Beluga Manager ships two images (`ghcr.io/dasomel/*`): `domain-api` (port 8787, non-root `node`
user, `HEALTHCHECK` on `/api/v1/health`) and `web` (nginx, port 80). The issue's principle is that
the Manager must not duplicate Beluga's deployment/IaC and must be deployable as an independent
component following Beluga's GitOps pattern, including air-gapped/self-hosted environments.

## Decision Drivers

- Single owner for cluster state: Beluga's GitOps repo.
- Independent release cadence for the Manager.
- No registry or cluster credentials in this repository.
- Air-gapped operation: images and charts mirrorable; no runtime pull of external manifests.

## Considered Options

1. **Chart in beluga-manager, Application in beluga** — chart is versioned with the code it deploys;
   Beluga's app-of-apps only references it.
2. **Chart and Application both in beluga** (`gitops/charts/beluga-manager`) — matches the two
   existing charts exactly; Manager repo only publishes images.
3. **Kustomize overlays in beluga-manager** — extra rendering path not used anywhere in Beluga.

## Decision Outcome

**Proposed choice: Option 1** (chart here, Application in Beluga), wired per Beluga's pattern. Acceptance by dasomel is pending and tracked as Open Question 1.

- **Chart**: `charts/beluga-manager` in this repository (Helm, no Kustomize; Beluga uses Helm only).
  Two Deployments (`domain-api`, `web`), Services, ConfigMap; image tags pinned, no `latest`.
- **Registration**: a third `Application` (`beluga-manager.yaml`) added to `beluga/gitops/apps/`,
  same `syncPolicy` as the existing two, destination namespace `beluga-manager`. This is the only
  change Beluga owns; the Manager never edits Beluga's repo or calls ArgoCD write APIs.
- **Namespace / identity**: dedicated namespace and one ServiceAccount per Deployment with
  `automountServiceAccountToken: false` until a feature needs the Kubernetes API (none today).
- **Config / secrets**: non-secret config via ConfigMap; secrets only via references to
  pre-existing Kubernetes Secrets (e.g. Keycloak client). No secret values in chart values.
- **Ingress**: exposed through Beluga's APISIX gateway under the `*.local.beluga.internal`
  convention; the route manifest lives with the other routes in Beluga, not in the Manager chart.
- **Health**: readiness/liveness probe `GET /api/v1/health` (domain-api) and `/` (web), matching
  the image `HEALTHCHECK`s.
- **Upgrade / rollback**: Git revert of the image tag in the owning chart; ArgoCD selfHeal performs
  the rollback. No Manager-initiated sync.
- **Read-only boundary**: if the Manager later shows deployment/GitOps status, it does so as a
  read-only domain resource following the adapter model (Domain API -> ArgoCD read API), never
  triggering sync, rollback, or any write. Sync status is an upstream fact, not an inferred one.

## Consequences

- Positive: one source of cluster truth; Manager release independent of Beluga core.
- Negative: two repos change per deployment-shape change (chart here, Application there); version
  skew must be tracked through `VERSIONS.md`.
- Phase 2 work (chart, Application, registry push, live-cluster verification) is not done here:
  no registry credentials, and cluster access could not be verified.

## Open Questions

1. Chart location: Option 1 (here) versus Option 2 (in Beluga). Needs dasomel's decision.
2. Image mirroring procedure for air-gapped sites (registry hostname override value).
3. Whether Keycloak OIDC for the Manager is part of this chart or of `beluga-platform`
   (`keycloak-clients.yaml`).
4. Whether a read-only ArgoCD status adapter is in MVP scope (would be a new issue and a design
   change per `AGENTS.md`).
