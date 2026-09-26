# Beluga Mistakes Log

Records failures, misconceptions, configuration errors, and debugging experience to prevent recurrence.

## Principles

1. Read existing records for the relevant area before starting work.
2. Add a row below when a new error occurs.

---

## Log

| Date | Area | Cause / symptom | Resolution / prevention |
|---|---|---|---|
| 2026-08-10 | docs | Artifact metadata caused a write path error. | Exclude it for project code and docs. |
| 2026-08-10 | lake | Documented Lakekeeper did not match the unpinned deployed image. | Use VERSIONS.md as deployment truth and test values drift. |
| 2026-08-10 | k8s | Rendered manifests did not guarantee component startup. | Require clean-install E2E, preserve errors, and wait for readiness. |
| 2026-08-10 | ingest | Kafka deployment combined namespace, compatibility, CRD, and API-version failures. | Use server-side CRD installation, pinned versions, and CR-status checks. |
| 2026-08-10 | ingest | CDC image, heap, privileges, publication, and seeding were incomplete. | Use an independent deployment and verify end-to-end rows. |
| 2026-08-10 | gitops | nginx-to-APISIX migration stopped half-complete. | Scope the conversion and record unfinished work. |
| 2026-08-11 | gitops | LDAP federation created duplicates and used incorrect assumptions. | Test existence checks and endpoint/tree behavior. |
| 2026-08-11 | harness | A dependent lane ran before its producer merged. | Merge dependencies first or provide them in the prompt. |
| 2026-08-10 | harness | Parallel workers shared a worktree and erased uncommitted work. | Isolate worktrees and prohibit revert/checkout/restore. |
| 2026-08-10 | stream | apache/flink was amd64-only. | Verify image repository, tag, and arm64 support. |
| 2026-08-10 | gitops | Fixed credentials were accepted as convention. | Generate credentials during bootstrap. |
| 2026-08-10 | harness | Worker image-verification claims were false. | Verify directly with docker manifest inspect. |
| 2026-08-11 | gitops | OpenLDAP emptyDir lost account data on restart. | Use PVCs and restart-aware probes. |
| 2026-08-11 | gitops | A new LDAP image seeded demo identities. | Inspect and suppress default seed data. |
| 2026-08-11 | harness | Web research cited nonexistent sources. | Directly verify registry and repository paths. |
| 2026-08-11 | harness | Another session's changes entered an unrelated commit. | Stage only task paths and stop on unexpected status. |
| 2026-08-11 | harness | grep/head summaries produced false state reports. | Read primary files before judging them. |
| 2026-08-19 | harness | Trino JWT group behavior was assumed, not verified. | Confirm external behavior in official documentation. |
| 2026-08-19 | harness | A bulk rename left a green test without relevant data. | Confirm tests still prove their titles. |
| 2026-08-19 | harness | Automated secret candidates had false positives. | Inspect before irreversible history changes. |
| 2026-08-25 | gitops | Cross-namespace short DNS names failed data paths. | Use service.namespace.svc.cluster.local and real SELECT checks. |
| 2026-08-25 | harness | Shared kubeconfig context raced across sessions. | Use isolated beluga kubeconfig. |
| 2026-08-25 | gitops | ArgoCD selfHeal reverted direct changes. | Push first, then sync and verify. |
| 2026-08-25 | analytics | Trino nextUri included unreachable port 9080. | Strip the port and accumulate all pages. |
| 2026-08-25 | orch | OAuth2 was not tested through the user gateway path. | Verify direct and documented entry paths. |
| 2026-08-26 | lake | SeaweedFS restart erased data without a PVC. | Add persistent storage and recovery checks. |
| 2026-08-26 | harness | Manual hook work raced with ArgoCD sync. | Check operation state before changing hooks. |
| 2026-08-26 | harness | repo-server retained a cached DNS failure. | Restart repo-server when hard refresh is insufficient. |
| 2026-08-26 | harness | RollingUpdate deadlocked under memory pressure. | Ensure capacity; delete old Pod only for demo downtime. |
| 2026-08-30 | gitops | APISIX etcd PVC migration exposed SSA and initialization failures. | Plan delete/recreate and restart sequencing. |
| 2026-09-08 | gitops | CI `sast.yml` `trivy-config` failed: CRITICAL wildcard RBAC (KSV-0046) plus read-only secrets access (KSV-0041) on the apisix-ingress-controller ClusterRole, and 101 HIGH pod-hardening findings. | Scoped the CRD list from the upstream apisix-ingress-controller 1.8.0 RBAC manifest (D1), kept KSV-0041 with a path-scoped `.trivyignore.yaml` wired via the `trivyignores` input since trivy-action does not auto-discover it (D2), and split the job into a blocking CRITICAL scan plus a non-blocking HIGH visibility scan tracked under #117 (D3). |
| 2026-09-24 | ci | (false-green, issue #107) Test 14 (`tests/14-policy-compiler-seam.sh`) step 3/4 is a live drift check that recompiles `policies/` with beluga-manager's `policyctl` and diffs the result against the deployed `trino.rego` / `db-roles.sql` Generated Body / keycloak mapper, but it only ran when `${REPO_ROOT}/../beluga-manager` and npm were present; otherwise it `log_warn`'d and still passed. CI has no sibling checkout, so this live diff never ran there and `make validate` stayed green regardless. | Made `MANAGER_DIR` overridable via `BELUGA_MANAGER_DIR` (local default stays `../beluga-manager`), and made the skip fail-closed (`exit 1` instead of `log_warn`) when `CI=true` (GitHub Actions sets this automatically) or `REQUIRE_POLICY_SEAM_LIVE=1`. Added a pinned checkout of `dasomel/beluga-manager` at commit SHA `406663a8b6946a279455ea3b6cb58b3585424970` (`persist-credentials: false`) plus `actions/setup-node` and `npm ci` to the `validate` job in `.github/workflows/ci.yml`, pointed at via `BELUGA_MANAGER_DIR`. Extended `scripts/ci/check-ci-stage-parity.py`'s setup-step exemptions to cover `actions/setup-node`/`npm ci`, the same category as the existing `azure/setup-helm`/`pip install` exemptions, so no CI-stage-parity doc table update was needed. Verified locally: pointing `BELUGA_MANAGER_DIR` at a checkout pinned to that SHA makes step 3/4 actually run and pass (`trino.rego` 0 diff, Keycloak seam, `db-roles.sql` Generated Body 0 diff, exit 0); `REQUIRE_POLICY_SEAM_LIVE=1`/`CI=true` with the directory missing both exit 1 immediately. Lesson: a drift check gated on "only when the environment is reachable" needs that environment verified present in CI — otherwise the `log_warn` path is an unguarded, permanent CI false-green. |
| 2026-09-27 | ci | `check-version-consistency.py` treated a VERSIONS.md image absent from rendered output as `skipped`, and checked only default Helm values. With no reverse check, shop-seed's `postgresql:17.0` drift passed despite CNPG/another Job and VERSIONS.md specifying 17.6. | Render both charts for every deployed values combination and check VERSIONS.md→render and render→VERSIONS.md repository/tag equality. Fail on missing/unknown images, tag drift, stale/removed allowlist entries, and operator bootstrap pin mismatch; use Helm `# Source:` locations and built-in self-tests. Align shop-seed to PostgreSQL 17.6 and add its engine image row to VERSIONS.md. Allowlist only the intentionally undeployed optional ldapium UI; remove the non-deployed kubectl image entry because the internal CA job uses the Python Kubernetes API client. |

