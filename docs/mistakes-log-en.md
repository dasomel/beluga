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

