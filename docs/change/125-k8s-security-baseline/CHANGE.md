# Change: Adopt the OpenForge Kubernetes Zero Trust security baseline (production profile)

- Change class: `D` — alters security controls (NetworkPolicy default-deny, Pod Security
  posture, exposure model) for Beluga's Kubernetes namespaces. See "Architecture and
  decisions" for the classification rationale.
- Owner: dasomel
- Related issue: dasomel/beluga#125
- Status: `Draft`
- Accepted by / date: _pending human review_
- Revision note: the owner accepted the scope of the competing package (dasomel/beluga#138,
  not merged) in addition to this package's original scope. Items marked "(#138)" below are
  ported from that text; its render-based claims were made against `2f78873` and are **not**
  live-cluster facts. Where the two inventories differ (e.g. workload counts), re-run
  `scripts/ci/check-k8s-security-baseline.py` before relying on either.

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
- Management surfaces share the single gateway VIP with user UIs (#138): all ten domains
  carry only `response-rewrite` plugins, and Flink REST (job submission), the SeaweedFS filer
  UI, and Lakekeeper (`openfga.enabled: false`) rely only on backend auth (or none).
- Kafka's Strimzi `external` listener is a plaintext NodePort (`30094`, `tls: false`,
  `aclAuthorizer: false`) reachable on every node IP outside the gateway (#138).
- The Superset `install-authlib` init container runs as UID 0; Airflow
  KubernetesPodOperator pods (`files/dags/iceberg_maintenance.py`) and the operator-rendered
  Flink/Strimzi pod templates set no `securityContext` (#138).
- Nodes have no managed host OS firewall (no ufw/nftables/firewalld in
  `scripts/cluster/01-node-prep.sh`), and Cilium Host Firewall and Hubble are not enabled
  (`scripts/cluster/03-cni-metallb.sh`); AppArmor state on the nodes has never been measured
  (#138).
- Bootstrap-installed system namespaces (`argocd`, `cert-manager`, `cnpg-system`,
  `metallb-system`, `kube-system`) have no scoped Pod Security / policy decision (#138).
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
- Beluga owns the nodes and the CNI, so node-layer controls are Beluga's, not another
  project's: AppArmor confinement is verified read-only, the host OS firewall is a
  time-bounded exception (not a silent skip), and Cilium Host Firewall runs in **audit**
  mode with a named owner and deadline for the enforce follow-up;
- controls that genuinely do not apply to Beluga's topology (service-mesh
  mTLS/AuthorizationPolicy, SELinux, public/private Gateway separation) are recorded as N/A
  with a topology-based rationale **and a review trigger or expiry**, per
  `docs/kubernetes-zero-trust-adoption-2026-09.md`'s "Beluga and KubeMetal adaptation"
  guidance, rather than silently skipped;
- every enforcement change is staged (allows and observability before enforcement) and
  reversible through GitOps, with a documented out-of-band recovery path.

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
  - AppArmor confirmation on the Ubuntu 26.04 Vagrant nodes, including read-only sampling of
    per-container-PID confinement (do not disable it; no custom profiles are known to be
    required today) (#138).
  - Node layer (#138): read-only inventory of the host OS firewall state, and Cilium Host
    Firewall enabled in **audit** mode only, with Hubble for evidence.
  - Exposure ownership (#138): the Kafka NodePort `30094` and every unauthenticated
    management route behind the gateway (Flink REST, SeaweedFS filer UI, Lakekeeper) get an
    auth control or a time-bounded exception with an owner.
  - Bootstrap-installed system namespaces `argocd`, `cert-manager`, `cnpg-system`,
    `metallb-system`, `kube-system` (#138): a scoped decision (policy, exception, or N/A)
    each, not blind hardening.
  - Airflow KubernetesPodOperator DAG pods and the Superset root init container (#138).
  - Regression evidence: required-allow and required-deny connectivity checks, and a
    durable static check that can run as part of `make validate`/`make test`.
  - Operator-managed workloads (CNPG `Cluster`, Strimzi `Kafka`/`KafkaNodePool`,
    `FlinkDeployment`): live-cluster verification of the security posture the operator
    actually applies (static Helm inspection cannot see it).
- Affected users/systems: every Beluga platform/data namespace; ArgoCD-managed
  `beluga-platform`/`beluga-data` Applications (self-heal); anyone using the domain
  registry entry points in `AGENTS.md`.

## Non-goals

- Enabling a host OS firewall (`nftables`/`ufw`/`firewalld`) on the nodes — recorded as a
  time-bounded exception (`REQ-011`), not enabled here: a second, uncoordinated host packet
  filter next to the Cilium eBPF datapath is the blind firewall mutation the baseline
  forbids (#138).
- Cilium Host Firewall **enforce** mode — this package covers audit only (`REQ-012`).
  Enforcement is a separate, re-reviewed follow-up owned by @dasomel with the deadline in
  `REQ-012`. It is not "another project's scope": Beluga provisions the nodes and installs
  the CNI (`k3s --flannel-backend=none`, `scripts/cluster/03-cni-metallb.sh`).
- Service mesh identity/mTLS (Istio Ambient `PeerAuthentication`/`AuthorizationPolicy`) —
  no service mesh is deployed in Beluga today; out of scope until a mesh adoption decision
  is made separately.
- SELinux — the Vagrant box is Ubuntu 26.04 (AppArmor-native); the SELinux column of the
  baseline table is N/A by host OS, not a gap. Review trigger: `BOX_NAME` changes OS family.
- Closing identity-plaintext paths (Postgres→LDAP plaintext, Kafka `plain` listener) — tracked
  by #2 and open PR #132; this package only records them (#138).
- Baking PyPI/Maven dependencies into images (#103, PR #133) — this package only constrains the
  egress they need today (#138).
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
  Job/CronJob) container and init container (including the Superset `install-authlib` init
  container, which currently runs as UID 0 and is replaced with a non-root equivalent, and
  `governance` OpenSearch/OpenMetadata when `openmetadata.enabled=true`, #138) sets `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `seccompProfile.type: RuntimeDefault`, and `capabilities.drop: [ALL]`, unless a
  documented, time-bounded exception exists.
- `REQ-004` — Operator-managed workloads (CNPG `Cluster`, Strimzi `Kafka`/`KafkaNodePool`,
  `FlinkDeployment`) and Airflow KubernetesPodOperator DAG pods have their actual
  live-cluster pod security posture recorded, with any gap either fixed via the operator's
  supported configuration surface (Strimzi `template.pod`/`template.*Container`, Flink
  `podTemplate`, KPO `security_context`/`container_security_context`) or recorded as an
  exception (#138).
- `REQ-005` — `grafana-external` (or any future non-`ClusterIP` Service) is either removed,
  routed through the Unified Gateway, or documented as an explicit, owner-approved,
  time-bounded exception in `docs/security-exceptions.md`.
- `REQ-006` — Required outbound (egress) dependencies are enumerated with evidence (not
  guessed), and every default-deny-egress namespace has an explicit allow rule limited to
  those dependencies (FQDN-aware where the destination is external). Per namespace, the
  egress/east-west allows are created and verified **before** that namespace's default-deny
  is applied, never the reverse (missed flows under default-deny broke OpenMetadata twice,
  `docs/mistakes-log.md` 2026-09-19 and 2026-09-22).
- `REQ-007` — A durable, repeatable regression check proves both required-allow and
  required-deny connectivity after the change (static preflight at minimum; live
  Hubble/connectivity evidence where a booted cluster is available, consistent with
  `docs/development.md`'s three verification levels).
- `REQ-008` — AppArmor remains enabled/enforcing on the Ubuntu 26.04 Vagrant nodes; the
  change does not disable or bypass it for any workload without a documented exception. The
  AppArmor state is recorded per node from a read-only inspection, container confinement is
  sampled per PID (`/proc/<pid>/attr/current` in `enforce` mode), and no workload uses
  `Unconfined` (#138).
- `REQ-009` — Every control this package marks N/A (service mesh mTLS/authorization,
  SELinux, public/private Gateway separation) or excepts (host OS firewall, permanent
  system-namespace exceptions) is recorded in `docs/security-exceptions.md` with an
  explicit topology-based rationale, an owner, and either an expiry or a review trigger
  (e.g. any public VIP, cloud mode, port forward beyond the host-only network, or a
  `BOX_NAME` OS-family change), not silently dropped from the adoption record. The
  #138 proposals — public/private separation N/A re-review by 2027-03-31; host OS firewall
  exception expiry 2027-03-31, owner @dasomel — are pending owner confirmation.
- `REQ-010` — Exposure ownership is recorded for every entry point (gateway VIP, Kafka
  NodePort `30094`, `grafana-external`, kube-apiserver, node SSH). Kafka `:30094` (plaintext,
  no ACLs) and every management route without authentication (Flink REST, SeaweedFS filer
  UI, Lakekeeper with OpenFGA off) has either an auth control or a time-bounded exception
  entry with an owner, and Kafka `:30094` consumers and `beluga-manager` are notified before
  any change to it (#138).
- `REQ-011` — The host OS firewall state (ufw/nftables/firewalld) is inventoried read-only
  on every node. Not enabling one is a **time-bounded exception** (owner @dasomel, expiry
  2027-03-31 per #138, pending owner confirmation): Cilium Host Firewall is the intended node
  firewall. Before expiry the owner reviews whether `REQ-012` has reached enforce; if not,
  the exception is extended with evidence of the residual risk and the host-only vmnet12
  boundary, and if enforce has landed the exception is closed instead (#138).
- `REQ-012` — Cilium Host Firewall runs in **audit** mode (`hostFirewall.enabled=true`, a
  host `CiliumClusterwideNetworkPolicy` in audit) with Hubble enabled for evidence; the
  observed flows cover kube-apiserver, kubelet, VXLAN node-to-node, DNS, MetalLB L2
  announcements, NodePorts and SSH, with no enforcement. The **enforce** follow-up is owned
  by @dasomel and is due for review by 2027-03-31 (tied to the `REQ-011` exception expiry);
  it needs its own re-reviewed change package and SSH plus kube-apiserver must be allowed
  in the host policy before any enforce (#138).
- `REQ-013` — Bootstrap-installed system namespaces get a scoped Pod Security decision, not
  blind hardening: `kube-system` and `metallb-system` (host networking and capabilities by
  design) use `enforce=privileged` with `audit`/`warn=restricted` as permanent exceptions
  with an annual review and evidence the upstream component still needs the privilege;
  `argocd`, `cert-manager` and `cnpg-system` use `audit`/`warn=restricted` and enforce only
  once audit shows zero violations (#138).
- `REQ-014` — Every enforcement step has a documented, tested rollback that works with
  ArgoCD `selfHeal: true`, defined per enforcement type (Pod Security label, securityContext,
  NetworkPolicy/CiliumNetworkPolicy, Cilium Helm values, host-firewall audit) with an
  out-of-band recovery path if the API is unreachable (see "Rollback by enforcement type").
- `REQ-015` — Where the portable `NetworkPolicy` cannot express a rule, `CiliumNetworkPolicy`
  is used: API-server egress uses `toEntities: [kube-apiserver]` (plain `ipBlock` does not
  select that identity); internet egress uses `toFQDNs`; and the in-cluster
  `sso.local.beluga.internal` VIP hairpin (CoreDNS→dnsmasq returns the APISIX VIP for
  Trino/Superset/Airflow) is allowed by selecting `platform-system` `app=apisix`, not an
  `ipBlock` of the VIP, because Cilium socket-LB translates the VIP to pod endpoints before
  policy evaluation. The socket-LB behavior is **unverified** until live evidence exists
  (#138).

## Acceptance scenarios

### `AC-001` — Default-deny with required connectivity intact

- Covers: `REQ-001`, `REQ-002`, `REQ-006`, `REQ-007`, `REQ-015`
- Given a namespace receives default-deny ingress and egress NetworkPolicy plus explicit
  DNS/dependency allow rules that were created and verified before the deny,
- When the regression check exercises every documented required flow (e.g. APISIX →
  Keycloak, Trino → Lakekeeper/SeaweedFS, Airflow → Postgres, Superset/Trino →
  `https://sso.local.beluga.internal` through the VIP hairpin) and every documented
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
- Given service-mesh mTLS, SELinux and public/private Gateway separation do not apply to
  Beluga's current topology, and the host OS firewall and system-namespace privileges are
  accepted exceptions,
- When `docs/security-exceptions.md` is reviewed,
- Then each entry has an explicit rationale, an owner, and an expiry or review trigger,
  distinguishing "not applicable to this topology" from "accepted risk with expiry." No
  entry is recorded as "another project's scope" for a control Beluga owns (nodes, CNI).

### `AC-007` — LSM posture

- Covers: `REQ-008`
- Given all four nodes,
- When read-only evidence is collected per node (`sudo aa-status --json`; for at least one
  container PID per node, `crictl inspect <id> | jq .info.pid` then
  `cat /proc/<pid>/attr/current`; the effective `securityContext.appArmorProfile` of at least
  one Beluga pod per node),
- Then AppArmor is enabled with at least one enforce-mode profile on every node, every
  sampled PID reports a profile in `(enforce)` mode, and `grep -r Unconfined gitops/` finds
  no `appArmorProfile.type: Unconfined`. The expected runtime-default profile name
  (`cri-containerd.apparmor.d`) is unconfirmed for Ubuntu 26.04 + k3s containerd; a mismatch
  is recorded with the observed value and is a failure unless the owner establishes the
  observed name is the correct default. (#138)

### `AC-008` — Exposure ownership

- Covers: `REQ-005`, `REQ-010`
- Given the rendered charts and a booted cluster,
- When Services are listed and the management routes are inspected,
- Then the only non-`ClusterIP` Services are `apisix-gateway` and the recorded Kafka
  NodePort `30094`; `grafana-external` is gone or gated (`nc -z <node-ip> 30000` fails from
  the host); and every management route in the exposure-ownership table has an auth control
  or an exception entry with an owner. (#138)

### `AC-009` — Host OS firewall inventory and exception

- Covers: `REQ-011`
- Given all four nodes,
- When ufw/nftables/firewalld state is read (read-only),
- Then the state per node is recorded and `docs/security-exceptions.md` holds a
  time-bounded exception (owner, expiry, renewal rule) instead of a silent non-goal. (#138)

### `AC-010` — Host firewall audit

- Covers: `REQ-012`
- Given Cilium with `hostFirewall.enabled=true` and a host policy in audit mode,
- When normal operation runs for at least 24 hours, including a full `make test`,
- Then Hubble shows audit verdicts only with no drops caused by the host policy, the
  observed flow set is attached, and SSH plus kube-apiserver stay reachable. (#138)

### `AC-011` — Rollback works under selfHeal

- Covers: `REQ-014`
- Given the `lakehouse` default-deny/allow rollback drill (lowest blast radius),
- When the documented rollback for that enforcement type is executed,
- Then connectivity is restored within one ArgoCD sync and the restored state is not silently
  reverted by `selfHeal`; the other enforcement types are verified as listed in "Rollback by
  enforcement type". (#138)

### `AC-012` — Scoped Pod Security on system namespaces

- Covers: `REQ-013`
- Given the five bootstrap-installed system namespaces,
- When their labels and violations are reviewed (`kubectl label --dry-run=server`),
- Then `kube-system`/`metallb-system` carry `enforce=privileged` with `audit`/`warn=restricted`
  and a permanent-exception entry with annual review; `argocd`/`cert-manager`/`cnpg-system`
  carry `audit`/`warn=restricted` and enforce only at zero violations. (#138)

## Architecture and decisions

- Relevant ADR/design links: dasomel/openforge#77, ADR-0014
  (`docs/adr/0014-standardize-kubernetes-zero-trust-security-baseline.md`), the baseline
  standard (`docs/kubernetes-zero-trust-security-baseline.md`), and the portfolio adoption
  record (`docs/kubernetes-zero-trust-adoption-2026-09.md`), all in `dasomel/openforge`.
- ADR threshold result: **required** (revised; the original conclusion of "not required"
  is superseded). The change crosses a security boundary and introduces Cilium-specific
  policy CRDs (`CiliumNetworkPolicy` for FQDN/entity/hairpin rules, `CiliumClusterwideNetworkPolicy`
  for the host policy) that reduce portability. Cilium is already a hard dependency
  (kube-proxy-free), so the trade-off is acceptable, but it must be recorded as
  `docs/adr/0003-kubernetes-security-baseline.md` with its `-ko` pair, indexed in
  `docs/adr/README.md` and `README-ko.md` (`docs-check.yml` enforces the pairing and index).
  Portable `NetworkPolicy` alone cannot express FQDN egress or apiserver/host entities and
  would force `0.0.0.0/0` egress. (#138)
- Alternatives and important trade-offs:
  - **Zero-trust profile instead of production** — rejected for this issue: the portfolio
    adoption plan assigns Beluga `production` at P1; zero-trust (mesh mTLS, node-aware host
    firewall) is Narwhal's P0 scope. Revisit only via a separate issue if reassigned.
  - **Per-namespace default-deny NetworkPolicy vs. a single cluster-wide `CiliumClusterwideNetworkPolicy`**
    — this package defaults to the existing per-namespace `NetworkPolicy` pattern already
    used in `storage`/`governance`, for consistency and because it needs no
    Cilium-CRD-specific tooling in `make validate`. A cluster-wide policy is an
    implementation-time alternative to evaluate, not pre-decided here. Cilium-specific
    CRDs are still required where the portable resource cannot express the rule
    (`REQ-015`); the ADR records that cost.
  - **Cluster-wide `policyAuditMode` staging vs. per-namespace allows-first** — cluster-wide
    audit mode gives observable default-deny before enforcement but temporarily disables
    the already-enforced `apisix-admin-restrict` and `seaweedfs-data-plane-restrict`
    policies (tests 08 and 09 would fail in the window); per-endpoint audit is not
    GitOps-declarable. Default here: per-namespace allows-first plus Hubble evidence (#138).
  - **ufw/firewalld on nodes** — rejected in favor of Cilium Host Firewall (`REQ-011`).
  - **Fixing `grafana-external` vs. formally excepting it** — this package does not
    pre-decide the outcome; it requires the implementation to choose and document one.

## Change impact

| Area | Impact / evidence needed |
|---|---|
| Source / API / command | New default-deny `NetworkPolicy` resources, `pod-security.kubernetes.io/*` namespace labels, and `securityContext` edits in `gitops/charts/beluga-platform` and `gitops/charts/beluga-data` templates (implementation phase only). |
| Dependencies / lockfiles | N/A — no dependency/version change. |
| Runtime / toolchain | Cilium (already the CNI) enforces the new policies. Enabling Hubble and `hostFirewall` (audit) changes Cilium Helm values and restarts the agent; known hazard: stale socket-LB/conntrack after an agent restart hangs TLS on older pods (`docs/mistakes-log.md` 2026-09-08), so dependent pods are roll-restarted in a planned window (#138). |
| CI / CD | `make validate`/`make lint` continue to pass against the current (pre-implementation) manifests; implementation must keep `helm template`/`helm lint` green and should extend static preflight coverage (see `REQ-007`). |
| Release / packaging | N/A — no release/packaging surface change. |
| Generated output | The inventory script's JSON output is not checked in (regenerated on demand); no other generated artifact changes. |
| Security / supply chain | This is a security-boundary change (Class D) — NetworkPolicy default-deny, Pod Security enforcement, and exposure/egress control are the entire point of the change; see Requirements/Acceptance above. |
| Offline / air-gap | N/A — no new external dependency is being introduced by this package; egress allow rules only cover dependencies that already exist today. |
| Documentation / operations | `docs/security-exceptions.md` (new, English + Korean per repo convention) for N/A controls and exceptions; ADR `docs/adr/0003-kubernetes-security-baseline{,-ko}.md` indexed in both ADR READMEs; `docs/access-guide*.md` if NodePorts change; `AGENTS.md`/`docs/development.md` updated if the implementation adds a new `make` target or CI stage. |
| Portfolio / downstream repositories | Adoption evidence should be reported back to `dasomel/openforge#77`/`docs/kubernetes-zero-trust-adoption-2026-09.md` per its "Adoption evidence contract," and any reusable gap (e.g. a missing template) fed back to OpenForge. |

## Verification plan

| Acceptance ID | Verification method | Environment | Expected evidence |
|---|---|---|---|
| `AC-001` | Static: NetworkPolicy render/lint. Live: connectivity check (`curl`/`nc` from a debug pod, or Hubble flow query) for each required and denied path. | Static: CI (`make validate`). Live: booted Vagrant cluster. | Static: `scripts/ci/check-k8s-security-baseline.py` reports 0 namespaces without default-deny. Live: per-flow allow/deny transcript. |
| `AC-002` | Static: inventory script gap count. Live: attempt to apply a non-compliant Pod spec and observe admission rejection. | Static: CI. Live: booted cluster. | Static: 0 workloads with a runtime gap in the inventory JSON. Live: `kubectl` admission error captured. |
| `AC-003` | Static: Service-type scan (same inventory script). | Static: CI. | 0 unresolved non-`ClusterIP` Services, or each has a `docs/security-exceptions.md` entry. |
| `AC-004` | Live: egress attempt to a documented dependency vs. an undocumented host from a pod in a default-deny-egress namespace. | Booted cluster. | Two captured command transcripts: allowed and denied. |
| `AC-005` | Live: `kubectl get pod <cnpg/kafka/flink pod> -o yaml` `securityContext` inspection. | Booted cluster. | Recorded `securityContext` per operator-managed workload against the `restricted` baseline. |
| `AC-006` | Documentation review. | N/A (docs). | `docs/security-exceptions.md` entries for host firewall, mesh mTLS, SELinux, gateway separation and system namespaces, each with rationale, owner, and expiry or review trigger. |
| `AC-007` | Read-only `aa-status --json`; `/proc/<pid>/attr/current` sampling; `grep -r Unconfined gitops/`. | Live nodes. | Per-node table: AppArmor enabled, sampled profile name and mode. |
| `AC-008` | Static: rendered Service types. Live: `kubectl get svc -A`, `nc -z <node-ip> 30000`. | CI + live. | Service inventory; closed port; per-route auth/exception mapping. |
| `AC-009` | Read-only ufw/nftables/firewalld state on each node. | Live nodes. | Per-node state table; exception entry. |
| `AC-010` | `cilium status`; `hubble observe --verdict AUDIT` over at least 24 h including `make test`. | Live. | Flow set; zero host-policy drops; SSH and API reachable. |
| `AC-011` | Rollback drill on `lakehouse` under selfHeal; per-type checks. | Live. | Timeline: break, rollback, restored, ArgoCD revision. |
| `AC-012` | `kubectl label --dry-run=server` on the system namespaces; label review. | Live. | Labels and warnings captured; exception entries. |

Distinguishes static/CI evidence (available without a cluster) from live-cluster evidence
(requires a booted Vagrant environment, per `docs/development.md`'s verification levels);
this Change Package's own verification (the inventory script) is static only — see
"Evidence and durable synchronization" below.

## Rollout, rollback and recovery

- Rollout sequence (implementation phase, not this PR): (0) read-only inventory of node
  LSM/firewall state, live effective securityContext and Cilium config; (1) workload runtime
  security defaults + Pod Security namespace labels first (`audit`/`warn` before `enforce`),
  since they are least likely to break existing traffic; (2) exposure remediation
  (`grafana-external`, Kafka `:30094` notice) is the most user-visible surface change, so it
  follows the workload steps; (3) per namespace, one at a time: **first** create and verify
  the egress allow-list and east-west allows (FQDN allows for E-01..E-04 style external
  dependencies, `toEntities` for the API server, the VIP-hairpin allow), **then** apply
  default-deny ingress+egress, then verify denied flows and re-confirm allowed flows; order
  by blast radius (mirrors the baseline's own "Rollout order" and Narwhal's PR #200
  bounded-slice precedent), gateway (`platform-system`) last; (4) Cilium Host Firewall in
  audit mode (no enforce). Each step is pushed, synced by ArgoCD and verified before the
  next; unpushed fixes are reverted by selfHeal (`docs/mistakes-log.md` 2026-09-20).
- Rollback trigger and procedure: any namespace losing required connectivity (ArgoCD
  Application `Degraded`, ordinary workload `CrashLoopBackOff`/readiness failure, or a
  documented user-facing endpoint becoming unreachable) triggers `git revert` of the
  offending commit; because `beluga-platform`/`beluga-data` `selfHeal: true`, the revert
  must be committed and pushed — an ad-hoc `kubectl delete networkpolicy` is reverted by
  ArgoCD on its next sync (`AGENTS.md` cluster-verification rule).
### Rollback by enforcement type (#138)

| Change | Fail mode | Rollback | Recovery if the API is unreachable |
|---|---|---|---|
| Pod Security `enforce` label | New pods rejected; running pods unaffected | `git revert` the label commit, push, ArgoCD sync. Break-glass: disable auto-sync on the owning Application (`argocd app set <app> --sync-policy none`), set `enforce=privileged`, then fix forward. | n/a — PSA does not affect running pods or API reachability |
| `securityContext` | CrashLoop (ROFS/UID, e.g. Keycloak/APISIX 2026-09-19) | `git revert` the per-workload commit (one workload per commit), push, sync, `rollout restart` | n/a |
| Namespace default-deny / allows | Timeouts on a missed flow (OpenMetadata 2026-09-19/22) | Preferred: add the missing allow once Hubble shows the dropped flow. Otherwise `git revert` the namespace commit, push, sync. Break-glass: disable auto-sync on `beluga-data`/`beluga-platform`, `kubectl delete netpol default-deny-all -n <ns>`, fix forward, re-enable. A plain `kubectl delete` alone is re-applied by selfHeal. | Pod-level policies do not select host-network processes: k3s and sshd are unaffected, so the API and node SSH stay reachable |
| FQDN egress (`CiliumNetworkPolicy`) | Pod start fails on pip/maven download | As above; running pods are unaffected until restart | same |
| Cilium Helm values (Hubble, `hostFirewall`) | Agent restart; stale TLS sockets | `helm rollback cilium -n kube-system`; roll-restart pods started before the agent restart | VMware console on master-1, then `k3s kubectl` on loopback |
| Host firewall **audit** | None expected (audit never drops); a drop means the mode was wrong | `kubectl delete ccnp <host-policy>`; `helm rollback cilium` | VMware console or `vagrant ssh` (SSH must be allowed in the host policy **before** any future enforce) |

No step flushes or enables a host firewall, changes an LSM mode, or replaces the CNI.

- Data/configuration recovery: N/A — NetworkPolicy, Pod Security labels, and
  `securityContext` are stateless declarative config; no data migration is involved. No step
  touches PVC data (CNPG/SeaweedFS volumes are kept; the `fsGroup` retrofit hazard applies).
- Compatibility or migration obligations: none across repositories; this is Beluga-local,
  except that `beluga-manager` and any external Kafka client on `:30094` need notice before
  the exposure step. Downstream: report adoption evidence to OpenForge per the adoption
  contract.

## Evidence and durable synchronization

- Evidence location/format: this PR's description and `scripts/ci/check-k8s-security-baseline.py`
  stdout (deterministic JSON) for the static inventory; a follow-up implementation PR
  records live-cluster evidence (connectivity transcripts, `kubectl` output) per
  `docs/development.md`'s verification-level distinction.
- Tests or checks that become durable regression controls:
  `scripts/ci/check-k8s-security-baseline.py` (read-only inventory, added by this PR) and
  `tests/15-k8s-security-baseline-inventory.py` (offline unit tests for its parsing
  logic). The script is report-only by default and gains an explicit `--strict` flag that
  exits non-zero on any gap (namespace without full default-deny, or workload with a runtime
  gap). The implementation phase wires `--strict` into `make validate` once the target state
  holds; the flip criterion and owner are in `TASKS.md` (`T-020`), analogous to
  `scripts/ci/check-certificate-inventory.py`.
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
