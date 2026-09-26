# Tasks: Adopt the OpenForge Kubernetes Zero Trust security baseline (production profile)

Linked Change Package: `docs/change/125-k8s-security-baseline/CHANGE.md` (dasomel/beluga#125).
No task below is executed by this PR — this checklist is scoped for the implementation PR(s)
that follow acceptance of the Change Package.

## Inspect and establish evidence

- [x] `T-001` (`REQ-001`..`REQ-009`) Confirm source of truth: dasomel/openforge#77,
      ADR-0014, `docs/kubernetes-zero-trust-security-baseline.md`,
      `docs/kubernetes-zero-trust-adoption-2026-09.md` (Beluga = production, P1); reviewed
      Narwhal's bounded-slice precedent (dasomel/narwhal#190 / PR #200) for the control
      objectives, not cluster specifics.
- [x] `T-002` (`AC-001`..`AC-006`) Capture the pre-change baseline with
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

## Implement (follow-up PR(s), after acceptance)

- [ ] `T-010` (`REQ-001`) Add `pod-security.kubernetes.io/enforce|audit|warn: restricted`
      labels to every namespace in `00-namespaces.yaml` (both charts).
- [ ] `T-011` (`REQ-001`, `REQ-002`) Add default-deny ingress+egress `NetworkPolicy` plus
      explicit DNS/dependency allow rules to the 8 namespaces currently missing them
      (`platform-system`, `iam`, `cert-manager`, `database`, `streaming`, `lakehouse`,
      `analytics`, `orchestration`), one namespace at a time per the rollout order in
      `CHANGE.md`, reusing the `storage`/`governance` default-deny pattern already in this
      repo (not the OpenForge template verbatim).
- [ ] `T-012` (`REQ-003`) Fix the 6 workloads (and their init containers) with a runtime
      gap: `apisix`, `keycloak` (add `readOnlyRootFilesystem: true`); `airflow-webserver`,
      `superset`, `clickstream-gen`, `flink-sql-submit` (+ `build-ca-bundle`/
      `install-authlib` init containers) (full `restricted` set).
- [ ] `T-013` (`REQ-004`) On a booted cluster, inspect live `securityContext` for
      `postgres-main` (CNPG), `beluga-kafka`/`mixed` (Strimzi), `flink-cluster`
      (FlinkDeployment); apply the operator's supported configuration surface for any gap,
      or file a time-bounded exception.
- [ ] `T-014` (`REQ-005`) Decide and implement the `grafana-external` outcome: route through
      `apisix-gateway` with a new `*.local.beluga.internal` subdomain, remove the direct
      NodePort, or add a dated, owner-approved exception to `docs/security-exceptions.md`.
- [ ] `T-015` (`REQ-006`) Confirm and allow-list real egress dependencies per namespace
      (start from `T-002`'s 6 candidate hostnames — expect most to resolve to
      documentation-comment noise except the Flink JAR fetch from `repo1.maven.org`; verify
      each on a live cluster rather than trusting the static heuristic).
- [ ] `T-016` (`REQ-008`) Confirm AppArmor is enabled/enforcing on the Ubuntu 26.04 Vagrant
      nodes (`aa-status` or equivalent); do not disable it to unblock any of the above.
- [ ] `T-017` (`REQ-009`) Create `docs/security-exceptions.md` (+ `-ko.md` per this repo's
      bilingual convention) recording host OS firewall, Cilium Host Firewall, service-mesh
      mTLS/authorization, SELinux, and public/private Gateway separation as N/A with a
      topology-based rationale, plus any exception from `T-013`/`T-014`/`T-015` with owner
      and expiry.

## Verify

- [ ] `T-020` (`AC-002`, `AC-003`) Re-run `scripts/ci/check-k8s-security-baseline.py` after
      `T-010`-`T-012`/`T-014` and confirm 0 namespaces without default-deny, 0 workloads
      with a runtime gap, 0 unresolved non-`ClusterIP` exposures; consider converting it
      into a fail-closed gate once the target state holds (mirrors
      `check-certificate-inventory.py`).
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

## Synchronize durable truth

- [ ] `T-030` Update `AGENTS.md` Source Map / `docs/development.md` if implementation adds a
      new `make` target or CI stage; update `docs/mistakes-log.md` if a reusable failure
      pattern is discovered (e.g. a dependency broken by default-deny that inventory missed).
- [ ] `T-031` No new ADR expected (see `CHANGE.md` "ADR threshold result"); revisit only if
      implementation reveals a genuinely new cross-project default worth proposing back to
      OpenForge.
- [ ] `T-032` Update `docs/security-exceptions.md` if any exception's scope changes during
      implementation; no release/packaging/compatibility notes expected (Class D scope here
      is security-boundary, not release).
- [ ] `T-033` Report the completed adoption back to
      `dasomel/openforge#77`/`docs/kubernetes-zero-trust-adoption-2026-09.md`'s adoption
      evidence contract (profile, inventory, implementation, verification, exceptions), and
      file an OpenForge issue for any reusable gap found (e.g. a missing default-deny
      template variant, or a static-inventory technique worth generalizing).

## Completion review

- [ ] Every requirement (`REQ-001`..`REQ-009`) maps to an acceptance scenario and a
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
   per-namespace `NetworkPolicy` pattern nine more times?
3. **Fail-closed gate timing** — should `scripts/ci/check-k8s-security-baseline.py` stay a
   report-only tool through the whole rollout (per-namespace, incrementally), or should it
   flip to fail-closed (`exit 1` on any residual gap) as soon as the first namespace is
   fully remediated, accepting that CI will show red for namespaces not yet reached?
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
