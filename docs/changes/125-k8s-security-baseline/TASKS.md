# Tasks: Adopt the OpenForge Kubernetes security baseline (`production` profile)

This checklist belongs to [`CHANGE.md`](CHANGE.md), issue #125. No task below may start before
the Change Package is **Accepted**, except the read-only tasks T-001 to T-004.

Every live task follows the rules in `AGENTS.md`:

- Use an isolated kubeconfig (`KUBECONFIG=/tmp/beluga-kubeconfig.yaml`).
- Push before claiming a fix, because selfHeal reverts anything that is not pushed.
- Put one enforcement change in each commit.
- Report static evidence and live evidence separately.

## Inspect and establish evidence (read-only)

- [ ] `T-001` (`REQ-005`, `AC-005`) Run OpenForge `check-host-security.sh` read-only on master-1 and worker-1 to worker-3. Record for each node:
  - the AppArmor state and the `aa-status` summary;
  - a sampled container profile from `/proc/<pid>/attr/current`;
  - the ufw/nftables/firewalld state.
- [ ] `T-002` (`REQ-002`, `AC-002`) Record the live effective securityContext for every pod in the 9 Beluga namespaces. Include the CNPG, Strimzi, and Flink operator-rendered pods and one Airflow KubernetesPodOperator pod.
- [ ] `T-003` (`REQ-001`) Label every namespace with `kubectl label --dry-run=server ... enforce=restricted` and capture the warnings as the PSA baseline.
- [ ] `T-004` (`REQ-003`) Capture a live flow baseline to validate the east-west inventory. Hubble is not enabled yet, so use `cilium-dbg monitor` briefly. Also run tests 08 and 09 once to get pre-change evidence for the policies that commit `2479723` already added.
- [ ] `T-005` Rebase onto the merged #132 and #136 before touching `Makefile` or `apisix-gateway.yaml`.

## Implement

- [ ] `T-010` (`REQ-007`) Enable Hubble in the Cilium values in `scripts/cluster/03-cni-metallb.sh`. Then:
  - add the Hubble images to `VERSIONS.md`;
  - apply the change during a maintenance window;
  - roll-restart the pods that started before the agent restart.

  Rollback: `helm rollback cilium`.
- [ ] `T-011` (`REQ-002`) Add a restricted securityContext to `07-airflow.yaml`, both containers.
- [ ] `T-012` (`REQ-002`) Replace the root `install-authlib` init container in `08-superset.yaml` with a non-root one, and harden all three containers.
- [ ] `T-013` (`REQ-002`) Harden `13-clickstream-gen.yaml` and `14-flink-jobs.yaml` (`flink-sql-submit`).
- [ ] `T-014` (`REQ-002`) Harden the FlinkDeployment `podTemplate` (JobManager, TaskManager, and the `download-connectors` init container) and the Strimzi `Kafka`/`KafkaNodePool` `template.pod`/`template.*Container` securityContext.
- [ ] `T-015` (`REQ-002`) Harden the Airflow KubernetesPodOperator pods in `files/dags/iceberg_maintenance.py` with `security_context` and `container_security_context`.
- [ ] `T-016` (`REQ-002`) Harden OpenMetadata and OpenSearch in `11-openmetadata.yaml`. Prove that OpenSearch starts without privileged sysctl init.
- [ ] `T-017` (`REQ-001`) Add the PSA labels `audit=restricted` and `warn=restricted` to the Namespace objects in both charts. Label the system namespaces as described in CHANGE C-02x.
- [ ] `T-018` (`REQ-001`) Set `enforce=restricted` one namespace at a time, and only after its T-003 warnings reach zero. Leave namespaces that still depend on an operator at `baseline` and record an exception (R4).
- [ ] `T-019` (`REQ-006`) Remove or gate `grafana-external` in `platform-services.yaml`. Record Kafka `:30094` according to the Q-06 decision. Add auth to the management routes, or record exceptions, according to Q-04.
- [ ] `T-020` (`REQ-003`) Add default-deny with explicit allows, one namespace per commit, allows before the deny, in this order:
  1. `lakehouse`
  2. `iam`
  3. `analytics`
  4. `orchestration`
  5. `streaming`
  6. `database`
  7. `platform-system`

  Use `CiliumNetworkPolicy` `toEntities: [kube-apiserver]` where a pod needs the API server. Allow the sso VIP hairpin to `platform-system/app=apisix` according to Q-03.
- [ ] `T-021` (`REQ-003`) Add live evidence for the existing `storage` and `governance` default-deny from commit `2479723`: run test 09 and the OpenMetadata entry path.
- [ ] `T-022` (`REQ-004`) Add per-workload `toFQDNs` egress for E-01 to E-04, and for E-05 if Q-05 brings `argocd` into scope. Validate one workload first (R3).
- [ ] `T-023` (`REQ-007`) Enable `hostFirewall.enabled=true` and apply a host `CiliumClusterwideNetworkPolicy` in **audit** only. It must allow SSH, kube-apiserver, kubelet, VXLAN, DNS, MetalLB, and the NodePorts.
- [ ] `T-024` (`REQ-008`) Create `docs/security-exceptions.md` with every N/A item and exception from the CHANGE gap table (owner, rationale, expiry or review trigger).

## Verify

- [ ] `T-030` (`AC-002`, `AC-006`, `REQ-009`) Add `scripts/ci/check-pod-security-posture.py` and a policy-coverage check to `make validate`. The coverage check verifies that every Beluga namespace has `default-deny-all` and `allow-cluster-dns` and that no cross-namespace peer uses an unrestricted selector. Render both value sets.
- [ ] `T-031` (`AC-003`, `AC-004`) Add `tests/15-network-baseline-live.sh` with the allow matrix and the deny matrix, including internet deny and PyPI allow. Wire it into `tests/run-all.sh`.
- [ ] `T-032` (`AC-005`) Add `tests/16-host-security-readonly.sh`, which wraps the T-001 inspection.
- [ ] `T-033` (`AC-001`) Run the PSA negative probe for each enforced namespace.
- [ ] `T-034` (`AC-007`) Run the host-firewall audit for at least 24 h, including a full `make test`. Export the Hubble AUDIT flows.
- [ ] `T-035` (`AC-008`) Run the rollback drill on `lakehouse` under selfHeal.
- [ ] `T-036` Check the domain-registry entry path for all 10 hosts plus the direct component access paths (gateway/auth rule).
- [ ] `T-037` Record passes **and failures** in `research/evidence/`.

## Synchronize durable truth

- [ ] `T-040` Add ADR-0003 `kubernetes-security-baseline` with its `-ko` pair, and index it in both READMEs.
- [ ] `T-041` Update `docs/access-guide*.md` (NodePorts), `docs/development*.md` (new tests), and `docs/architecture*.md` (security section).
- [ ] `T-042` Add the new failure discriminators to `docs/mistakes-log.md`.
- [ ] `T-043` Add the `k8s-security-baseline` capability to `.openforge/status.json`.
- [ ] `T-044` Open an OpenForge feedback issue covering three findings: Cilium `ipBlock` versus entity identities, the VIP hairpin under socket-LB, and staging default-deny under selfHeal.
- [ ] `T-045` Notify beluga-manager and the Kafka `:30094` consumers before T-019 and T-020 land.

## Completion review

- [ ] Every requirement maps to an acceptance scenario and a verification result (CHANGE tables).
- [ ] Material scope changes are reflected in CHANGE.md and re-reviewed.
- [ ] Live evidence is attached. Static evidence alone does not close #125.
- [ ] Incomplete work, such as host firewall **enforce**, has an owner and a tracking issue.
- [ ] The PR states which checks ran and which paths are still unverified.
