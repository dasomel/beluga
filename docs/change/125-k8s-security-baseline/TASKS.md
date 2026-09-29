# Tasks: Adopt the OpenForge Kubernetes Zero Trust security baseline (production profile)

Linked Change Package: `docs/change/125-k8s-security-baseline/CHANGE.md` (dasomel/beluga#125).
No task below is executed by this PR — this checklist is scoped for the implementation PR(s)
that follow acceptance of the Change Package.

## Inspect and establish evidence

- [x] `T-001` (`REQ-001`..`REQ-015`) Confirm source of truth: dasomel/openforge#77,
      ADR-0014, `docs/kubernetes-zero-trust-security-baseline.md`,
      `docs/kubernetes-zero-trust-adoption-2026-09.md` (Beluga = production, P1); reviewed
      Narwhal's bounded-slice precedent (dasomel/narwhal#190 / PR #200) for the control
      objectives, not cluster specifics.
- [x] `T-002` (`AC-001`..`AC-012`) Capture the pre-change baseline with
      `python3 scripts/ci/check-k8s-security-baseline.py` against the default `helm
      template` render of both charts: 8/10 namespaces missing full default-deny, 6/28
      workloads with a runtime-security gap, 4 operator-managed workloads needing live
      review, `grafana-external` NodePort exposure, 6 candidate external hostnames. Full
      JSON retained as this PR's evidence artifact.
- [x] `T-003` Reviewed dependencies/affected workflows: k3s with
      `--disable-network-policy` (Cilium owns enforcement), Cilium as CNI
      (`scripts/cluster/03-cni-metallb.sh`), Ubuntu 26.04 Vagrant nodes (AppArmor-native),
      cert-manager using only the internal CA issuer (no ACME/public-CA egress), single
      Unified Gateway (`apisix-gateway`, MetalLB `LoadBalancer`) fronting every
      `*.local.beluga.internal` host in `AGENTS.md`'s domain registry.
- [ ] `T-004` (`REQ-008`, `REQ-011`, `REQ-012`, `AC-007`, `AC-009`) Before any implementation,
      run the read-only node inventory (no mutation) from `T-016` and record the live
      effective securityContext / Cilium config baseline, so the render-based claims ported
      from #138 (not live facts) are confirmed or corrected.

## Implement (follow-up PR(s), after acceptance)

Egress ordering (revised): `T-011` (egress/east-west allow-list) is a prerequisite of
`T-015` (default-deny), per namespace, never the reverse. IDs were swapped from the first
revision of this package (formerly `T-015` = allow-list, `T-011` = default-deny).

- [ ] `T-010` (`REQ-001`, `REQ-013`) Add `pod-security.kubernetes.io/enforce|audit|warn:
      restricted` labels to every Beluga namespace in `00-namespaces.yaml` (both charts),
      `audit`/`warn` first and `enforce` only at zero violations. System namespaces per
      `REQ-013`: `kube-system`/`metallb-system` `enforce=privileged` +
      `audit`/`warn=restricted` (permanent exception, annual review); `argocd`,
      `cert-manager`, `cnpg-system` `audit`/`warn=restricted`, enforce only at zero
      violations. Namespaces still depending on an operator stay at `baseline` enforce with
      an exception (operator-rendered pods are not fully controlled by Beluga).
- [ ] `T-011` (`REQ-006`, `REQ-015`) Confirm and allow-list real egress and east-west
      dependencies per namespace, **before** that namespace's default-deny (`T-015`):
      start from `T-002`'s 6 candidate hostnames (expect most to be documentation-comment
      noise except the Flink JAR fetch from `repo1.maven.org`; verify each on a live cluster
      rather than trusting the static heuristic; #138 also lists PyPI for Airflow/Superset/
      clickstream-gen at pod start and `github.com` for `argocd-repo-server`); add `toFQDNs`
      allows (validate one workload first, since FQDN policy depends on the Cilium DNS
      proxy), `toEntities: [kube-apiserver]` where a pod needs the API server, and the
      `sso.local.beluga.internal` VIP-hairpin allow to `platform-system` `app=apisix`
      (not an `ipBlock`; unverified until live evidence). For `governance`, resolve whether
      OpenMetadata initiates internet egress before finalizing its allow set. Verify each
      allow with `kubectl exec`/`curl`/Hubble before `T-015`.
- [ ] `T-012` (`REQ-003`) Fix the 6 workloads (and their init containers) with a runtime
      gap: `apisix`, `keycloak` (add `readOnlyRootFilesystem: true`); `airflow-webserver`,
      `superset`, `clickstream-gen`, `flink-sql-submit` (+ `build-ca-bundle`/
      `install-authlib` init containers) (full `restricted` set). Replace Superset's root
      (`runAsUser: 0`) `install-authlib` init container with a non-root equivalent. One
      workload per commit. Re-run the inventory with `openmetadata.enabled=true` and harden
      `governance` OpenSearch/OpenMetadata if it reports gaps (prove OpenSearch starts
      without a privileged sysctl init).
- [ ] `T-013` (`REQ-004`) On a booted cluster, inspect live `securityContext` for
      `postgres-main` (CNPG), `beluga-kafka`/`mixed` (Strimzi), `flink-cluster`
      (FlinkDeployment) and one Airflow KubernetesPodOperator pod
      (`files/dags/iceberg_maintenance.py`); apply the operator's supported configuration
      surface (Strimzi `template.pod`/`template.*Container`, Flink `podTemplate` incl. the
      `download-connectors` init container, KPO `security_context`/
      `container_security_context`) for any gap, or file a time-bounded exception.
- [ ] `T-014` (`REQ-005`, `REQ-010`) Decide and implement the `grafana-external` outcome:
      route through `apisix-gateway` with a new `*.local.beluga.internal` subdomain, remove
      the direct NodePort (#138 reports no Grafana is installed, so its selector matches
      nothing; confirm), or add a dated, owner-approved exception to
      `docs/security-exceptions.md`. In the same task record Kafka `:30094` (plaintext, no
      ACLs) with its client scope, and give each unauthenticated management route (Flink REST,
      SeaweedFS filer UI, Lakekeeper) an auth control or a time-bounded exception. Notify
      `beluga-manager` and `:30094` consumers first (`T-034`).
- [ ] `T-015` (`REQ-001`, `REQ-002`, `REQ-014`) Depends on `T-011` for the same namespace.
      Add default-deny ingress+egress `NetworkPolicy` plus DNS allow rules to the 8
      namespaces currently missing them (`platform-system`, `iam`, `cert-manager`,
      `database`, `streaming`, `lakehouse`, `analytics`, `orchestration`), one namespace at
      a time per the rollout order in `CHANGE.md` (blast-radius order, gateway last), one
      namespace per commit, reusing the `storage`/`governance` default-deny pattern already
      in this repo (not the OpenForge template verbatim). After each: verify denied flows
      and re-confirm allowed flows.
- [ ] `T-016` (`REQ-008`, `REQ-011`) Read-only node inventory (OpenForge
      `check-host-security.sh` where available): AppArmor enabled/enforcing (`aa-status`),
      a sampled container profile per node from `/proc/<pid>/attr/current` (resolve the
      unconfirmed expected name `cri-containerd.apparmor.d` for Ubuntu 26.04 + k3s), and
      the ufw/nftables/firewalld state; do not disable AppArmor to unblock any of the above
      and do not enable a host firewall.
- [ ] `T-017` (`REQ-009`, `REQ-011`, `REQ-013`) Create `docs/security-exceptions.md` (+
      `-ko.md` per this repo's bilingual convention) recording: mesh mTLS/authorization,
      SELinux, public/private Gateway separation as N/A with topology rationale and a
      review trigger or expiry; the host OS firewall exception (owner @dasomel, expiry
      2027-03-31 per #138, pending owner confirmation); `kube-system`/`metallb-system`
      permanent exceptions (annual review); plus any exception from `T-013`/`T-014`/`T-011`
      with owner and expiry.
- [ ] `T-018` (`REQ-012`) Enable Hubble and `hostFirewall.enabled=true` in the Cilium values
      (`scripts/cluster/03-cni-metallb.sh`) in a maintenance window, apply a host
      `CiliumClusterwideNetworkPolicy` in **audit** only (must allow SSH, kube-apiserver,
      kubelet, VXLAN, DNS, MetalLB, NodePorts), then roll-restart pods that started before
      the agent restart. Rollback: `helm rollback cilium`. Hubble images, if deployed, must
      be listed in `VERSIONS.md` (in that implementation PR, not this one). **Enforce is not
      part of this task**: owner @dasomel; review due by 2027-03-31 (`T-036`).

## Verify

- [ ] `T-020` (`AC-002`, `AC-003`, `AC-008`) Re-run `scripts/ci/check-k8s-security-baseline.py`
      after `T-010`-`T-012`/`T-014`/`T-015` and confirm 0 namespaces without default-deny, 0
      workloads with a runtime gap, 0 unresolved non-`ClusterIP` exposures. **Strict gate
      flip (proposed, pending owner confirmation):** add
      `python3 scripts/ci/check-k8s-security-baseline.py --strict` to `make validate` (and
      keep `.github/workflows` parity) in the same PR that lands the last of `T-012` and
      `T-015`, i.e. when the default run reports 0 namespaces missing default-deny and 0
      workloads with a gap; not earlier, so CI does not go red for namespaces not yet
      reached. Owner: @dasomel. `--strict` counts only those two gap classes; non-`ClusterIP`
      exposures, operator-managed workloads and egress candidates stay report-only because
      they end in documented exceptions. The script already ships `--strict` (default
      report-only) with offline tests in `tests/15-k8s-security-baseline-inventory.py`.
- [ ] `T-021` (`AC-001`, `AC-004`) On a booted cluster, exercise every required flow
      (APISIX→Keycloak, Trino→Lakekeeper/SeaweedFS, Airflow→Postgres, etc.) and at least one
      denied flow per namespace (e.g. `analytics`→`database` direct); capture Hubble or
      `kubectl exec ... curl/nc` transcripts for both.
- [ ] `T-022` (`AC-005`) Capture live `securityContext` evidence for the 4 operator-managed
      workloads.
- [ ] `T-023` Run `make lint` and `make validate` after every implementation commit; run
      `make test` (live E2E) before considering the change complete.
- [ ] `T-024` Add the required-vs-denied connectivity checks as a durable regression check
      (static preflight at minimum, e.g. alongside `tests/11-identity-plaintext-preflight.sh`'s
      pattern; live Hubble/connectivity script if the pattern used by
      `tests/07-trino-authz-live.sh` fits).
- [ ] `T-025` (`AC-007`, `AC-009`) Collect the per-node LSM and host-firewall evidence from
      `T-016` in the implementation PR (`aa-status`, `/proc/<pid>/attr/current`, ufw/nftables/
      firewalld state, `grep -r Unconfined gitops/`).
- [ ] `T-026` (`AC-010`) Run the host-firewall audit (`T-018`) for at least 24 h including a
      full `make test`; export the Hubble AUDIT flows and confirm no host-policy drops.
- [ ] `T-027` (`AC-011`) Run the rollback drill on `lakehouse` under selfHeal (`git revert`,
      push, ArgoCD sync, confirm selfHeal does not revert the restored state); verify the
      other enforcement types per `CHANGE.md` "Rollback by enforcement type".
- [ ] `T-028` (`AC-001`, `AC-012`) Run the PSA negative probe (a pod without a
      securityContext is rejected) per enforced namespace and the `--dry-run=server` label
      review on the system namespaces.

## Synchronize durable truth

- [ ] `T-030` Update `AGENTS.md` Source Map / `docs/development.md` if implementation adds a
      new `make` target or CI stage; update `docs/mistakes-log.md` if a reusable failure
      pattern is discovered (e.g. a dependency broken by default-deny that inventory missed).
- [ ] `T-031` Add ADR `docs/adr/0003-kubernetes-security-baseline.md` and its
      `-ko.md` pair, and index both in `docs/adr/README.md` / `README-ko.md`
      (`docs-check.yml` enforces pairing and index); it records the Cilium-CRD portability
      trade-off (`CiliumNetworkPolicy`/`CiliumClusterwideNetworkPolicy`) and the staging
      decision. See `CHANGE.md` "ADR threshold result".
- [ ] `T-032` Update `docs/security-exceptions.md` if any exception's scope changes during
      implementation; no release/packaging/compatibility notes expected (Class D scope here
      is security-boundary, not release).
- [ ] `T-033` Report the completed adoption back to
      `dasomel/openforge#77`/`docs/kubernetes-zero-trust-adoption-2026-09.md`'s adoption
      evidence contract (profile, inventory, implementation, verification, exceptions), and
      file an OpenForge issue for any reusable gap found (e.g. a missing default-deny
      template variant, or a static-inventory technique worth generalizing). Include the
      three #138 findings: Cilium `ipBlock` vs entity identities, the VIP hairpin under
      socket-LB, and staging default-deny under selfHeal.
- [ ] `T-034` (`REQ-010`) Notify `beluga-manager` and Kafka `:30094` consumers before `T-014`
      changes that exposure.
- [ ] `T-035` Update `docs/access-guide*.md` (NodePorts) and `docs/development*.md` (new
      tests/gates) if the implementation changes them.
- [ ] `T-036` (`REQ-011`, `REQ-012`) Renewal/enforce review, owner @dasomel, due before
      2027-03-31 (pending owner confirmation): confirm whether Cilium Host Firewall reached
      **enforce**. If not, extend the host-firewall exception with evidence of the residual
      risk and the vmnet12 boundary and open the enforce change package; if enforce landed,
      close the exception. Record the outcome in `docs/security-exceptions.md`. Also
      re-review the public/private-separation N/A by the same date or on the first review
      trigger (public VIP, cloud mode, port forward beyond the host-only network).

## Completion review

- [ ] Every requirement (`REQ-001`..`REQ-015`) maps to an acceptance scenario and a
      verification result.
- [ ] Material scope changes were reflected in `CHANGE.md` and re-reviewed.
- [ ] Expected evidence (static inventory JSON, live connectivity transcripts, live
      `securityContext` dumps) is attached or linked in the implementation PR(s).
- [ ] Known incomplete work has an owner and tracking issue.
- [ ] The PR states the checks actually run and any important unverified path.

## Open questions for the human

1. **`grafana-external` outcome** — should it be routed through `apisix-gateway` (new
   subdomain + TLS, following the existing 9-host pattern), removed outright, or kept as a
   documented, time-bounded exception? This affects `T-014` and whether `docs/security
   -exceptions.md` needs an entry at all.
2. **Cluster-wide vs. per-namespace NetworkPolicy** — 8 new namespaces each need a
   default-deny + several allow rules (mirroring `storage`/`governance`). Is a
   `CiliumClusterwideNetworkPolicy` baseline (fewer, DRYer resources, but a Cilium-CRD
   dependency not yet used elsewhere in this repo) preferred over repeating the existing
   per-namespace `NetworkPolicy` pattern nine more times? (Cilium CRDs are needed anyway
   for FQDN/entity/hairpin rules and the host policy; the ADR in `T-031` records the
   portability trade-off. #138's `policyAuditMode` staging alternative would temporarily
   disable `apisix-admin-restrict` and `seaweedfs-data-plane-restrict`; default here is
   per-namespace allows-first plus Hubble.)
3. **Fail-closed gate timing** — `--strict` now exists and the default stays report-only.
   `T-020` proposes flipping it in `make validate` only when the default run reports 0
   namespaces missing default-deny and 0 workloads with a gap (owner @dasomel). Confirm, or
   choose an earlier flip accepting that CI shows red for namespaces not yet reached.
4. **Egress destination confirmation** — `repo1.maven.org` (Flink JAR fetch at pipeline
   submit time, `14-flink-jobs.yaml`) looks like the only genuine external runtime
   dependency found; can the human confirm there is no other external call (e.g. an
   Airflow DAG, a Superset data source, or an OpenMetadata connector once
   `openmetadata.enabled` flips true) before the egress allow-list is finalized?
5. **`docs/security-exceptions.md` bilingual pairing** — this repository's `docs/*.md`
   convention is English-canonical + `-ko.md` sibling (e.g. `docs/architecture.md` /
   `docs/architecture-ko.md`), matching OpenForge's own `docs/security-exceptions.md` /
   `docs/security-exceptions-ko.md` pair. Confirming the human wants the new file to follow
   that same pattern (`docs/security-exceptions.md` + `docs/security-exceptions-ko.md`)
   before implementation creates it, since `.github/workflows/docs-check.yml` today only
   enforces bilingual pairing for the root-level docs it lists (`README.md`,
   `CONTRIBUTING.md`, etc.), not `docs/*.md` — so a mismatch here would not be caught by CI.
6. **`openmetadata.enabled` timing** — `governance`'s default-deny is currently a
   zero-risk pre-stage (no live workloads). Should its explicit allow rules be authored now
   (Class B, in this baseline work) or deferred to whichever issue flips
   `openmetadata.enabled: true`, to avoid maintaining allow rules for a dependency graph
   that isn't live yet?
7. **Exception dates and owners** — the dates `2027-03-31` (host OS firewall exception
   expiry, public/private-separation N/A re-review, Cilium Host Firewall enforce review) and
   owner @dasomel come from #138's proposal, not from an accepted decision. Confirm or
   replace them.
8. **Kafka `:30094`** — who are the external clients? Keep it as a scoped exception,
   restrict the source to `192.168.77.0/24`, or remove it (#138)?
9. **Management surfaces** — accept time-bounded exceptions for Flink REST, the SeaweedFS
   filer UI and Lakekeeper (OpenFGA off), or add gateway auth (`openid-connect` plugin) in
   this change? The latter widens scope into auth/gateway behavior and needs both
   entry-path checks (#138).
10. **System namespaces** — bring `argocd`, `cert-manager`, `cnpg-system` under default-deny
    now, or keep them at `audit`/`warn` with an expiry (#138)?
