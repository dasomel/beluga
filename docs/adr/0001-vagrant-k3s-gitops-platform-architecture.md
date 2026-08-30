# ADR-0001: Vagrant + k3s + ArgoCD GitOps platform architecture

- Status: Accepted
- Date: 2026-08-09
- Supersedes: —
- Superseded by: —

## Context

Beluga needs an independent, reproducible local Kubernetes cluster to host a full data
platform (Kafka/CDC, Flink, Iceberg, Trino, Airflow) without building or vendoring any
binary, and without depending on a shared/managed cluster that other concurrent
sessions on the same host could disturb.

## Decision

Provision 4 VMs (1 master + 3 workers) via `Vagrantfile`, install k3s on them via
`scripts/cluster/*.sh`, and deploy the entire application stack through ArgoCD
app-of-apps GitOps (`gitops/apps/` -> `gitops/charts/beluga-platform` +
`gitops/charts/beluga-data`) rather than direct `helm install`/`kubectl apply`. Every
component image is pulled at deploy time from its own upstream registry; versions are
tracked centrally in `VERSIONS.md`.

## Alternatives considered

- **Managed/shared cluster** (e.g. a single shared kind/k3d cluster reused across
  concurrent sessions) — rejected: this host runs 20+ concurrent Claude sessions across
  other repos; a shared cluster context is a proven source of state-clobbering
  confusion (see the 2026-08-25 `harness` entry in `docs/mistakes-log.md`).
- **Direct `helm install`/`kubectl apply` without GitOps** — rejected: no reconciliation
  or drift detection; manual imperative changes silently diverge from the committed
  source of truth over a multi-week project.
- **Docker Compose instead of Kubernetes** — rejected: several target components
  (Strimzi, Flink Kubernetes Operator, cert-manager) are Kubernetes-operator-native and
  do not have an equivalent non-Kubernetes deployment model this project wants to
  maintain.

## Rationale

Vagrant VMs give each session/host an isolated cluster boundary. k3s is a lightweight,
well-supported distribution that starts fast on a laptop-class host. ArgoCD GitOps
makes "what is actually running" reconstructible from the committed manifests alone,
and its `selfHeal: true` behavior converts accidental manual drift into a visible,
correctable event rather than a silent one.

## Consequences

### Positive

- Cluster state is reproducible from `git clone` + `make up`.
- GitOps self-heal catches accidental imperative drift.
- No shared-cluster interference with other concurrent sessions on the host.

### Negative / trade-offs

- 4-VM footprint requires 32GB+ host RAM — not a lightweight local dev experience.
- `selfHeal: true` means a `kubectl apply` used only for quick verification is silently
  reverted within minutes unless followed by a real commit+push — this has repeatedly
  cost debugging time (see `docs/mistakes-log.md`, 2026-08-25 `gitops` entry) and is a
  documented gotcha in `CLAUDE.md` as a direct consequence of this decision.

## Affected standards, templates, and projects

- `Vagrantfile`, `scripts/cluster/`, `scripts/gitops/`, `gitops/`
- `docs/architecture.md`, `CLAUDE.md`

## Migration / adoption

N/A — this is the original architecture, recorded retroactively as part of the
OpenForge compliance baseline adoption (2026-08).

## Evidence and references

- Design record: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md`
- Operational evidence: `docs/mistakes-log.md` (multiple `gitops`/`harness` entries)
- Related ADRs: ADR-0002
