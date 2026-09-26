# Change: Adopt the OpenForge Kubernetes Zero Trust security baseline (production profile)

- Change class: `D` — alters security controls (NetworkPolicy default-deny, Pod Security
  posture, exposure model) for Beluga's Kubernetes namespaces. See "Architecture and
  decisions" for the classification rationale.
- Owner: dasomel
- Related issue: dasomel/beluga#125
- Status: `Draft`
- Accepted by / date: _pending human review_

**This document is a Change Package only — it fixes intent, requirements, and acceptance
scenarios before implementation.** No Kubernetes manifest, Helm value, NetworkPolicy, or
securityContext in this repository is changed by this PR. Implementation begins only after
a human accepts this package (`docs/change-management.md`, `AGENTS.md` risk-scaled change
workflow).

## Problem

dasomel/openforge#77 defines a cross-project Kubernetes Zero Trust security baseline
(`docs/kubernetes-zero-trust-security-baseline.md`, ADR-0014) and the portfolio adoption
plan (`docs/kubernetes-zero-trust-adoption-2026-09.md`) assigns Beluga the **production**
profile at P1, scoped to workload segmentation/runtime, internal/external exposure where
Beluga owns both paths, and controlled egress — not the full zero-trust stack that Narwhal
(P0 reference) and kube-ready-box (P0 foundation) own.

The read-only inventory produced for this package (`scripts/ci/check-k8s-security-baseline.py`,
run against the default `helm template` render of both charts on 2026-09-24) shows Beluga does
not yet meet the production profile:

- 8 of 10 namespaces (`platform-system`, `iam`, `cert-manager`, `database`, `streaming`,
  `lakehouse`, `analytics`, `orchestration`) have **no default-deny NetworkPolicy** at all.
  Only `storage` and `governance` do (`storage` via existing per-namespace default-deny +
  DNS-allow; `governance` via `gitops/charts/beluga-data/templates/00b-network-baseline.yaml`,
  currently a zero-risk pre-stage because the namespace's only workloads are gated behind
  `openmetadata.enabled: false`).
- No namespace carries a `pod-security.kubernetes.io/*` label — Pod Security Admission is not
  enforced anywhere, even though most workloads already happen to run close to `restricted`.
- 6 of 28 statically-inspectable workloads (Deployment/StatefulSet/Job) have a runtime
  security gap against `restricted` (missing `runAsNonRoot`, `allowPrivilegeEscalation: false`,
  `readOnlyRootFilesystem`, `seccompProfile: RuntimeDefault`, or `capabilities.drop: [ALL]`):
  `apisix` and `keycloak` (missing only `readOnlyRootFilesystem`), and `airflow-webserver`,
  `superset`, `clickstream-gen`, `flink-sql-submit` (missing the full set, including their
  `build-ca-bundle`/`install-authlib` init containers). The other 22 already comply.
- `grafana-external` is a `NodePort` Service in `platform-system`, **enabled by default**
  (`prometheusGrafana.enabled: true`), that bypasses the single documented Unified Gateway
  (`apisix-gateway`, `LoadBalancer`, `*.local.beluga.internal`) entirely — an undocumented,
  ungated direct exposure path.
- 4 operator-managed workloads (CloudNativePG `Cluster/postgres-main`, Strimzi
  `Kafka/KafkaNodePool beluga-kafka`/`mixed`, `FlinkDeployment/flink-cluster`) do not expose a
  standard `PodSpec` in the chart source; their actual runtime security posture is set by the
  operator and needs live-cluster confirmation, not static Helm inspection.
- 6 external hostnames are statically referenced from rendered manifests as literal
  `http(s)://` URLs (documentation comments and runtime fetches mixed together — see
  "Egress" below); there is no egress policy of any kind in any namespace except the
  DNS-only egress-allow already present in `storage`/`governance`.

## Intent

Bring Beluga's Kubernetes namespaces to the OpenForge **production** profile from
`docs/kubernetes-zero-trust-security-baseline.md`, adapted to Beluga's actual topology
(single-VM Vagrant cluster, k3s + Cilium CNI, one Unified Gateway), by the end of
implementation:

- every application namespace has default-deny ingress **and** egress, with explicit
  allow rules for DNS and every real dependency (same-namespace, cross-namespace, and
  external);
- ordinary workloads meet Pod Security `restricted` (`runAsNonRoot`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem`, `seccompProfile:
  RuntimeDefault`, capability drop `ALL`), enforced by `pod-security.kubernetes.io/enforce:
  restricted` namespace labels, not only by convention;
- the platform's exposure model (one Unified Gateway for `*.local.beluga.internal`) is the
  only sanctioned direct-exposure path, or any exception is explicit and documented;
- required outbound dependencies are documented and covered by egress policy;
- required and denied connectivity are both proven by a regression check, not assumed;
- controls that do not apply to Beluga's topology (host OS firewall ownership,
  Cilium Host Firewall audit/enforce staging, service-mesh mTLS/AuthorizationPolicy) are
  explicitly recorded as N/A with a topology-based rationale, per
  `docs/kubernetes-zero-trust-adoption-2026-09.md`'s "Beluga and KubeMetal adaptation"
  guidance, rather than silently skipped.

## Scope

- In scope:
  - `gitops/charts/beluga-platform` and `gitops/charts/beluga-data` NetworkPolicy coverage
    for every namespace (`platform-system`, `iam`, `cert-manager`, `database`, `storage`,
    `streaming`, `lakehouse`, `analytics`, `orchestration`, `governance`).
  - Pod Security Admission namespace labels and per-workload `securityContext` for the 6
    workloads (plus their init containers) with a runtime gap.
  - `grafana-external` NodePort exposure: bring under the Unified Gateway, remove, or
    document as an explicit, owner-approved exception.
  - Egress allow-list for the real dependencies uncovered by inventory and live-traffic
    review (DNS, in-cluster service dependencies, and any confirmed external host such as
    the Flink JAR fetch from `repo1.maven.org`).
  - AppArmor confirmation on the Ubuntu 26.04 Vagrant nodes (do not disable it; no custom
    profiles are known to be required today).
  - Regression evidence: required-allow and required-deny connectivity checks, and a
    durable static check that can run as part of `make validate`/`make test`.
  - Operator-managed workloads (CNPG `Cluster`, Strimzi `Kafka`/`KafkaNodePool`,
    `FlinkDeployment`): live-cluster verification of the security posture the operator
    actually applies (static Helm inspection cannot see it).
- Affected users/systems: every Beluga platform/data namespace; ArgoCD-managed
  `beluga-platform`/`beluga-data` Applications (self-heal); anyone using the domain
  registry entry points in `AGENTS.md`.

## Non-goals

- Host OS firewall configuration/ownership (`nftables`/`ufw`/`firewalld`) — Beluga's single
  shared Vagrant VM has no separate public/private network plane; this is kube-ready-box's
  P0 foundation scope, not Beluga's.
- Cilium Host Firewall audit→enforce staging — Beluga uses Cilium as the CNI (`k3s
  --flannel-backend=none`, `scripts/cluster/03-cni-metallb.sh`) but adopting node-aware
  host-firewall policy is Narwhal's P0 reference scope; revisit only if OpenForge later
  assigns it to Beluga.
- Service mesh identity/mTLS (Istio Ambient `PeerAuthentication`/`AuthorizationPolicy`) —
  no service mesh is deployed in Beluga today; out of scope until a mesh adoption decision
  is made separately.
- SELinux — the Vagrant box is Ubuntu 26.04 (AppArmor-native); the SELinux column of the
  baseline table is N/A by host OS, not a gap.
- External/public vs. internal/private **Gateway/LB separation** beyond what already
  exists — every current domain (`AGENTS.md` registry) resolves only via `/etc/hosts` on
  the single `apisix-gateway` LoadBalancer VIP; there is no real public internet exposure
  to separate from it. `grafana-external` is the one exception and is explicitly in scope
  (see above), not treated as a second gateway class.
- Any actual manifest/Helm/policy change — this PR only. Implementation is a separate,
  reviewed follow-up once this package is accepted.

## Requirements

- `REQ-001` — Every namespace in `gitops/charts/beluga-platform` and
  `gitops/charts/beluga-data` has a default-deny NetworkPolicy for both `Ingress` and
  `Egress` (`podSelector: {}`, no rules), plus `pod-security.kubernetes.io/enforce:
  restricted` (and matching `audit`/`warn`) labels.
- `REQ-002` — Every default-deny namespace has explicit allow rules for cluster DNS and
  every real same-namespace/cross-namespace dependency identified by inventory and/or live
  traffic review; no namespace loses required connectivity.
- `REQ-003` — Every statically-inspectable workload (Deployment/StatefulSet/DaemonSet/
  Job/CronJob) container and init container sets `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `seccompProfile.type: RuntimeDefault`, and `capabilities.drop: [ALL]`, unless a
  documented, time-bounded exception exists.
- `REQ-004` — Operator-managed workloads (CNPG `Cluster`, Strimzi `Kafka`/`KafkaNodePool`,
  `FlinkDeployment`) have their actual live-cluster pod security posture recorded, with any
  gap either fixed via the operator's supported configuration surface or recorded as an
  exception.
- `REQ-005` — `grafana-external` (or any future non-`ClusterIP` Service) is either removed,
  routed through the Unified Gateway, or documented as an explicit, owner-approved,
  time-bounded exception in `docs/security-exceptions.md`.
- `REQ-006` — Required outbound (egress) dependencies are enumerated with evidence (not
  guessed), and every default-deny-egress namespace has an explicit allow rule limited to
  those dependencies (FQDN-aware where the destination is external).
- `REQ-007` — A durable, repeatable regression check proves both required-allow and
  required-deny connectivity after the change (static preflight at minimum; live
  Hubble/connectivity evidence where a booted cluster is available, consistent with
  `docs/development.md`'s three verification levels).
- `REQ-008` — AppArmor remains enabled/enforcing on the Ubuntu 26.04 Vagrant nodes; the
  change does not disable or bypass it for any workload without a documented exception.
- `REQ-009` — Every control this package marks N/A (host firewall, Cilium Host Firewall,
  service mesh mTLS/authorization, SELinux, public/private Gateway separation) is recorded
  with an explicit topology-based rationale in `docs/security-exceptions.md`, not silently
  dropped from the adoption record.

## Acceptance scenarios

### `AC-001` — Default-deny with required connectivity intact

- Covers: `REQ-001`, `REQ-002`, `REQ-007`
- Given a namespace receives default-deny ingress and egress NetworkPolicy plus explicit
  DNS/dependency allow rules,
- When the regression check exercises every documented required flow (e.g. APISIX →
  Keycloak, Trino → Lakekeeper/SeaweedFS, Airflow → Postgres) and every documented
  non-required flow (e.g. a pod in `analytics` reaching `database` directly, bypassing the
  allow-listed path),
- Then every required flow succeeds and every non-required flow is denied, with command
  output captured as evidence.

### `AC-002` — Namespace-wide restricted Pod Security enforcement

- Covers: `REQ-001`, `REQ-003`
- Given a namespace is labeled `pod-security.kubernetes.io/enforce: restricted`,
- When any workload manifest in that namespace is rendered/applied without
  `runAsNonRoot`/`allowPrivilegeEscalation: false`/`seccompProfile.type: RuntimeDefault`/a
  full capability drop,
- Then the Pod is rejected by admission (live-cluster evidence) or, statically, the
  inventory check in this PR (`scripts/ci/check-k8s-security-baseline.py`) reports zero
  workloads with a runtime gap.

### `AC-003` — No undocumented direct exposure path

- Covers: `REQ-005`
- Given the Unified Gateway is the only sanctioned entry point for `*.local.beluga.internal`,
- When the rendered manifests are inspected for non-`ClusterIP` Services,
- Then either none remain outside the gateway, or each one has a matching, dated entry in
  `docs/security-exceptions.md` naming an owner and expiry/review date.

### `AC-004` — Egress limited to documented dependencies

- Covers: `REQ-006`, `REQ-007`
- Given a default-deny-egress namespace with dependency-scoped allow rules,
- When a pod in that namespace attempts to reach cluster DNS and every documented
  dependency, and separately attempts to reach an undocumented external host,
- Then the documented attempts succeed and the undocumented attempt is denied, both with
  captured evidence.

### `AC-005` — Operator-managed workloads verified live

- Covers: `REQ-004`
- Given CNPG/Strimzi/Flink-operator workloads cannot be statically inspected from the
  chart source,
- When their live Pod specs are inspected on a booted cluster (`kubectl get pod ... -o
  yaml`),
- Then their actual `securityContext` is recorded against the `restricted` baseline, and
  any gap is either fixed through the operator's configuration surface or filed as a
  time-bounded exception.

### `AC-006` — N/A controls are recorded, not silent

- Covers: `REQ-009`
- Given host firewall, Cilium Host Firewall, service-mesh mTLS, and SELinux do not apply to
  Beluga's current topology,
- When `docs/security-exceptions.md` is reviewed,
- Then each N/A control has an explicit rationale, distinguishing "not applicable to this
  topology" from "deferred to another OpenForge project" from "accepted risk with expiry."

## Architecture and decisions

- Relevant ADR/design links: dasomel/openforge#77, ADR-0014
  (`docs/adr/0014-standardize-kubernetes-zero-trust-security-baseline.md`), the baseline
  standard (`docs/kubernetes-zero-trust-security-baseline.md`), and the portfolio adoption
  record (`docs/kubernetes-zero-trust-adoption-2026-09.md`), all in `dasomel/openforge`.
- ADR threshold result: **not required** — per `docs/decision-management.md`, this is
  "routine implementation work fully determined by an accepted decision" (ADR-0014 already
  made the cross-project Zero Trust decision); Beluga is adapting an existing OpenForge
  default to its own topology, not proposing a new cross-project default.
- Alternatives and important trade-offs:
  - **Zero-trust profile instead of production** — rejected for this issue: the portfolio
    adoption plan assigns Beluga `production` at P1; zero-trust (mesh mTLS, node-aware host
    firewall) is Narwhal's P0 scope. Revisit only via a separate issue if reassigned.
  - **Per-namespace default-deny NetworkPolicy vs. a single cluster-wide `CiliumClusterwideNetworkPolicy`**
    — this package defaults to the existing per-namespace `NetworkPolicy` pattern already
    used in `storage`/`governance`, for consistency and because it needs no
    Cilium-CRD-specific tooling in `make validate`. A cluster-wide policy is an
    implementation-time alternative to evaluate, not pre-decided here.
  - **Fixing `grafana-external` vs. formally excepting it** — this package does not
    pre-decide the outcome; it requires the implementation to choose and document one.

## Change impact

| Area | Impact / evidence needed |
|---|---|
| Source / API / command | New default-deny `NetworkPolicy` resources, `pod-security.kubernetes.io/*` namespace labels, and `securityContext` edits in `gitops/charts/beluga-platform` and `gitops/charts/beluga-data` templates (implementation phase only). |
| Dependencies / lockfiles | N/A — no dependency/version change. |
| Runtime / toolchain | N/A — no runtime/toolchain change; Cilium (already the CNI) enforces the new NetworkPolicies. |
| CI / CD | `make validate`/`make lint` continue to pass against the current (pre-implementation) manifests; implementation must keep `helm template`/`helm lint` green and should extend static preflight coverage (see `REQ-007`). |
| Release / packaging | N/A — no release/packaging surface change. |
| Generated output | The inventory script's JSON output is not checked in (regenerated on demand); no other generated artifact changes. |
| Security / supply chain | This is a security-boundary change (Class D) — NetworkPolicy default-deny, Pod Security enforcement, and exposure/egress control are the entire point of the change; see Requirements/Acceptance above. |
| Offline / air-gap | N/A — no new external dependency is being introduced by this package; egress allow rules only cover dependencies that already exist today. |
| Documentation / operations | `docs/security-exceptions.md` (new, English + Korean per repo convention) for N/A controls and exceptions; `AGENTS.md`/`docs/development.md` updated if the implementation adds a new `make` target or CI stage. |
| Portfolio / downstream repositories | Adoption evidence should be reported back to `dasomel/openforge#77`/`docs/kubernetes-zero-trust-adoption-2026-09.md` per its "Adoption evidence contract," and any reusable gap (e.g. a missing template) fed back to OpenForge. |

## Verification plan

| Acceptance ID | Verification method | Environment | Expected evidence |
|---|---|---|---|
| `AC-001` | Static: NetworkPolicy render/lint. Live: connectivity check (`curl`/`nc` from a debug pod, or Hubble flow query) for each required and denied path. | Static: CI (`make validate`). Live: booted Vagrant cluster. | Static: `scripts/ci/check-k8s-security-baseline.py` reports 0 namespaces without default-deny. Live: per-flow allow/deny transcript. |
| `AC-002` | Static: inventory script gap count. Live: attempt to apply a non-compliant Pod spec and observe admission rejection. | Static: CI. Live: booted cluster. | Static: 0 workloads with a runtime gap in the inventory JSON. Live: `kubectl` admission error captured. |
| `AC-003` | Static: Service-type scan (same inventory script). | Static: CI. | 0 unresolved non-`ClusterIP` Services, or each has a `docs/security-exceptions.md` entry. |
| `AC-004` | Live: egress attempt to a documented dependency vs. an undocumented host from a pod in a default-deny-egress namespace. | Booted cluster. | Two captured command transcripts: allowed and denied. |
| `AC-005` | Live: `kubectl get pod <cnpg/kafka/flink pod> -o yaml` `securityContext` inspection. | Booted cluster. | Recorded `securityContext` per operator-managed workload against the `restricted` baseline. |
| `AC-006` | Documentation review. | N/A (docs). | `docs/security-exceptions.md` entries for host firewall, Cilium Host Firewall, mesh mTLS, SELinux, each with a stated rationale. |

Distinguishes static/CI evidence (available without a cluster) from live-cluster evidence
(requires a booted Vagrant environment, per `docs/development.md`'s verification levels);
this Change Package's own verification (the inventory script) is static only — see
"Evidence and durable synchronization" below.

## Rollout, rollback and recovery

- Rollout sequence (implementation phase, not this PR): (1) workload runtime security
  defaults + Pod Security namespace labels first, since they are least likely to break
  existing traffic; (2) default-deny NetworkPolicy with explicit allows, one namespace at a
  time, each verified before moving to the next (mirrors the baseline's own "Rollout order"
  and Narwhal's PR #200 bounded-slice precedent); (3) `grafana-external` remediation last,
  since it is the most user-visible surface change.
- Rollback trigger and procedure: any namespace losing required connectivity (ArgoCD
  Application `Degraded`, ordinary workload `CrashLoopBackOff`/readiness failure, or a
  documented user-facing endpoint becoming unreachable) triggers `git revert` of the
  offending commit; because `beluga-platform`/`beluga-data` `selfHeal: true`, the revert
  must be committed and pushed — an ad-hoc `kubectl delete networkpolicy` is reverted by
  ArgoCD on its next sync (`AGENTS.md` cluster-verification rule).
- Data/configuration recovery: N/A — NetworkPolicy, Pod Security labels, and
  `securityContext` are stateless declarative config; no data migration is involved.
- Compatibility or migration obligations: none across repositories; this is Beluga-local.
  Downstream: report adoption evidence to OpenForge per the adoption contract.

## Evidence and durable synchronization

- Evidence location/format: this PR's description and `scripts/ci/check-k8s-security-baseline.py`
  stdout (deterministic JSON) for the static inventory; a follow-up implementation PR
  records live-cluster evidence (connectivity transcripts, `kubectl` output) per
  `docs/development.md`'s verification-level distinction.
- Tests or checks that become durable regression controls:
  `scripts/ci/check-k8s-security-baseline.py` (read-only inventory, added by this PR) and
  `tests/15-k8s-security-baseline-inventory.py` (offline unit tests for its parsing
  logic). The implementation phase should add a fail-closed static gate (e.g. "0 namespaces
  without default-deny, 0 workloads with a runtime gap") once the target state is reached,
  analogous to `scripts/ci/check-certificate-inventory.py`.
- Documentation to update (implementation phase): `docs/security-exceptions.md` (new,
  bilingual), `AGENTS.md` Source Map if a new durable script/target is added,
  `docs/development.md` if `make validate`/CI gains a new stage.
- ADR/evidence/portfolio records to update: report the completed adoption back to
  `dasomel/openforge#77`/`docs/kubernetes-zero-trust-adoption-2026-09.md`'s adoption
  evidence contract; feed back any reusable template/standard gap found during
  implementation.

## Review record

- Accepted scope/requirements: _pending human acceptance_.
- Material changes after acceptance and re-review: _none yet_.
- Open questions or blockers: see `TASKS.md` "Open questions for the human."
