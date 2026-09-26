# Change: Adopt the OpenForge Kubernetes security baseline (`production` profile)

- Change class: `D` (security boundary: workload admission, network enforcement, host/node firewall, egress)
- Owner: @dasomel
- Related issue: #125
- Source of truth: [dasomel/openforge#77](https://github.com/dasomel/openforge/pull/77) —
  `docs/kubernetes-zero-trust-security-baseline.md`, `templates/kubernetes/security/`
- Status: `Draft` — awaiting acceptance; no implementation is included with this package
- Accepted by / date: _pending_

> Language: this package is a short-lived change contract and follows the English-canonical
> OpenForge `templates/change/CHANGE.md`. It is not a root user-facing doc or an ADR, so the
> bilingual pairing check (`.github/workflows/docs-check.yml`) does not apply. The durable
> decision lands in a paired ADR (see [Architecture and decisions](#architecture-and-decisions)).

## Problem

Beluga provisions and owns its entire Kubernetes stack — Vagrant/VMware Ubuntu 26.04 nodes, k3s
v1.36, Cilium 1.20 (kube-proxy replacement), MetalLB, APISIX, and two GitOps charts — but its
security controls are uneven and were never assessed against one baseline:

- **No Pod Security Admission labels** on any namespace
  (`gitops/charts/beluga-data/templates/00-namespaces.yaml`,
  `gitops/charts/beluga-platform/templates/00-namespaces.yaml`,
  `gitops/charts/beluga-platform/templates/platform-services.yaml`).
- **Default-deny covers 2 of 9 Beluga-owned namespaces** (`storage`, `governance`). The other
  seven accept any in-cluster ingress and allow unrestricted egress, including to the internet.
- **Runtime hardening gaps.** Seven chart-owned pod specs and all operator-rendered data-plane pods
  lack a complete restricted `securityContext`; the Superset init container runs as UID 0.
- **Unauthenticated management surfaces behind the single gateway.** All ten domains share one
  APISIX VIP and carry only `response-rewrite` plugins. Flink REST (job submission), the SeaweedFS
  filer UI, and Lakekeeper (OpenFGA disabled) rely only on backend auth.
- **No node firewall.** The node scripts do not manage ufw, nftables, or firewalld. Cilium Host
  Firewall and Hubble are not enabled (`scripts/cluster/01-node-prep.sh`,
  `scripts/cluster/03-cni-metallb.sh`).
- **Undocumented runtime internet egress.** Workloads call PyPI and Maven Central at pod start.
- **Partial work already landed on `main` before this package.** These commits have no live
  connectivity evidence (see [Pre-package baseline](#pre-package-baseline-already-on-main)).
  `docs/mistakes-log.md` 2026-09-19 and 2026-09-22 show that the governance default-deny broke
  OpenMetadata egress and ingress twice. This is the failure mode this package must prevent.

## Intent

Beluga can show, with render-time and live-cluster evidence, that every applicable OpenForge
`production` control is either applied or recorded as an N/A decision or a time-bounded exception.
Each change to admission, network, egress, or the node firewall must be staged, observable before
enforcement, and reversible through GitOps without a blind firewall, LSM, or CNI mutation.

## Scope

- In scope:
  - Beluga-owned namespaces `platform-system`, `iam`, `database`, `storage`, `streaming`,
    `lakehouse`, `analytics`, `orchestration`, and `governance`. These cover the chart workloads,
    the operator-rendered pods (CNPG, Strimzi, Flink), and the Airflow KubernetesPodOperator pods.
  - Bootstrap-installed system namespaces: `argocd`, `cert-manager`, `cnpg-system`,
    `metallb-system`, and `kube-system`. These get a scoped decision (policy, exception, or N/A).
    They are not hardened blindly.
  - Node layer: LSM verification, the OS firewall decision, and Cilium Host Firewall in audit mode
    only.
  - The exposure inventory and its ownership, the egress inventory with an FQDN allow-list,
    allow/deny regression tests, and the exception register.
- Affected users/systems: every Beluga UI or API behind `*.local.beluga.internal`; Kafka CDC
  clients on NodePort `30094`; Airflow DAG pods; operators; cluster bootstrap
  (`scripts/cluster/*`, `scripts/gitops/01-argocd-bootstrap.sh`).

## Non-goals

- Service mesh adoption (Istio Ambient or Cilium mutual auth/SPIRE). See the N/A decision for
  `C-09`.
- Enforcing the Cilium Host Firewall. This package covers audit mode only. Enforcement needs a
  separate, re-reviewed follow-up.
- Enabling ufw, firewalld, or nftables on nodes. See the decision for `C-07`.
- Closing identity-plaintext paths (Postgres→LDAP plaintext, Kafka `plain` listener). These are
  tracked by #2 and open PR #132. This package only records them.
- Baking PyPI and Maven dependencies into images (supply chain, #103 and PR #133). This package
  only constrains the egress they need today.
- Changing component versions in `VERSIONS.md`.

## Pre-package baseline already on `main`

Implementation for #125 started before a Change Package existed. That is contrary to the OpenForge
Class D gate. The package adopts this work as the starting state, not as verified work:

| Commit | Change | Evidence recorded | Status under this package |
|---|---|---|---|
| `2479723` | `default-deny-all` + `allow-cluster-dns` in `storage` and `governance` (`beluga-data/templates/00b-network-baseline.yaml`, `01-seaweedfs.yaml`) | helm lint/template only; live test 09 explicitly **not run** | Needs `AC-004` live evidence |
| `9680e07` | `seccompProfile: RuntimeDefault` on 22 workloads already hardened under #117 | helm template only | Needs `AC-002` live rollout evidence |
| `a514045`, `22453f4` (#117) | runAsNonRoot, drop ALL, APE=false, and read-only root filesystem (ROFS) where possible | per #117 | Counted as the baseline for `C-02` |
| `87ce04b` | `openmetadata-allow-apisix` ingress under the governance default-deny | live fix (mistakes-log 2026-09-22) | Counted for `C-04` |

## Selected profile

**`production`**, scoped to Beluga's ownership boundary. Beluga is a cluster installer: it owns the
hosts, node OS, CNI, load balancer, gateway, and workloads. Under OpenForge §Scope it must cover the
host, node, workload, exposure, identity, and egress controls. `zero-trust` is not selected because
it makes mTLS mandatory without a mesh, and Beluga has no mesh.

Profile record (adapted from `templates/kubernetes/security/security-profile.example.yml`):

```yaml
version: openforge-kubernetes-security/v1
profile: production
exposure:
  externalGateway: { enabled: false }          # no public path exists — C-01 N/A
  internalGateway: { enabled: true, className: apisix, addressPool: beluga-pool }  # 192.168.77.200
host:
  osFirewall: { enabled: false, provider: external }  # C-07 exception; Cilium host fw is the node firewall
  lsm: { provider: apparmor, appArmor: { targetMode: runtime-default } }
nodeNetwork:
  kubernetesAwareFirewall: { enabled: true, provider: cilium, initialMode: audit, targetMode: enforce }
workload:
  podSecurityStandard: restricted
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  seccompProfile: RuntimeDefault
  dropCapabilities: [ALL]
  networkPolicy: { defaultDenyIngress: true, defaultDenyEgress: true }
serviceIdentity: { enabled: false, provider: none }   # C-09 N/A (no mesh); C-10 via app-level identity
egress:
  defaultDeny: true
  fqdnAllowList: [pypi.org, files.pythonhosted.org, repo1.maven.org]  # E-01..E-04; github.com is argocd-scoped (E-05)
  fixedSourceIp: { enabled: false }
verification:
  requireConnectivityRegression: true
  requireRollbackProcedure: true
  requireExceptionExpiry: true
```

## Control gap analysis

Evidence paths are relative to the repository root. `beluga-data/…` and `beluga-platform/…` mean
`gitops/charts/<chart>/templates/…`. The current state comes from the source and from
`helm template` renders of both charts at `2f78873`, including a render with
`openmetadata.enabled=true`. It is **not** live-cluster state.

| ID | Control (production) | Current state (evidence) | Target | Decision |
|---|---|---|---|---|
| C-01 | Internal/external exposure separation | Single APISIX `LoadBalancer` at `192.168.77.200` (`beluga-platform/apisix-gateway.yaml` L197–212). The MetalLB pool `192.168.77.200-220` is advertised only on `enp26s0`, the host-only vmnet12 (`scripts/cluster/03-cni-metallb.sh` L47–72, `configs/cluster.env`). No public path exists. | Keep one private gateway. Record exposure ownership (see [Exposure ownership](#exposure-ownership)). | **N/A**: "required when both exist" does not apply because no external/public path exists. **Review trigger:** any public VIP, cloud mode, or port forward beyond the host-only network. Re-review by 2027-03-31. |
| C-01a | Management surfaces private by default | ArgoCD, Keycloak admin, the SeaweedFS filer, and Flink REST share the same VIP as user UIs. All routes carry only `response-rewrite` (rendered ApisixRoutes). | Every management route requires authenticated identity at the gateway or backend. Unauthenticated ones are documented and time-bounded. | **Gap** → `REQ-006` |
| C-01b | Stray exposure | `grafana-external` NodePort `30000` selects `app.kubernetes.io/name: grafana`, but no Grafana is installed (`beluga-platform/platform-services.yaml` L8–22; no install in `scripts/`). Kafka `external` listener NodePort `30094`, `tls: false` (`beluga-data/03-strimzi-kafka.yaml` L60–68). | Remove or gate the dangling NodePort. Record Kafka 30094 as an exception with scope. | **Gap** → `REQ-006` |
| C-02 | Pod Security `restricted` / least privilege | No PSA labels on any namespace. The render shows 22 chart pod specs compliant. **Non-compliant:** `orchestration/airflow-webserver` (both containers, no securityContext) and `analytics/superset` (3 containers; `install-authlib` sets `runAsUser: 0`) (`beluga-data/07-airflow.yaml`, `08-superset.yaml`). Also `streaming/clickstream-gen`, `streaming/flink-sql-submit`, `governance/opensearch`, `openmetadata`, and `openmetadata-migration` (`13-clickstream-gen.yaml`, `14-flink-jobs.yaml`, `11-openmetadata.yaml`). FlinkDeployment `podTemplate` has no securityContext (`05-flink-operator.yaml` L30+). Strimzi `Kafka`/`KafkaNodePool` set no `template.pod.securityContext`. Airflow KubernetesPodOperator pods are unset (`files/dags/iceberg_maintenance.py`). CNPG instances rely on operator defaults, unverified. | PSA `enforce=restricted` on all nine Beluga namespaces after audit/warn shows zero violations. `audit`/`warn=restricted` first. | **Gap** → `REQ-001`, `REQ-002`. System namespaces: see C-02x. |
| C-02x | Privileged platform components isolated | Cilium (`kube-system`) and MetalLB speaker (`metallb-system`) require host networking and capabilities by design. ArgoCD, cert-manager, and CNPG operator come from upstream manifests (`scripts/gitops/01-argocd-bootstrap.sh` L15–17, L252–259). | `kube-system`, `metallb-system`: `enforce=privileged` + `audit/warn=restricted`, with an exception entry. `argocd`, `cert-manager`, `cnpg-system`: `audit/warn=restricted`, and enforce only if audit shows zero violations. | **Exception** (kube-system, metallb-system: permanent by design, reviewed yearly). Others: gap. |
| C-03 | seccomp `RuntimeDefault` | 24 container specs set it (`9680e07` + openldap). Missing on every C-02 non-compliant workload and on operator-rendered pods. | All Beluga-namespace pods resolve to `RuntimeDefault` or `Localhost`. | **Gap** → `REQ-002` |
| C-04 | Default-deny ingress | Present in `storage` (`01-seaweedfs.yaml` L253–264) and `governance` (`00b-network-baseline.yaml`), each with explicit allows. Scoped ingress-only policies exist: `apisix-admin-restrict` (`apisix-gateway.yaml` L487–516) and `seaweedfs-data-plane-restrict`. Missing in 7 namespaces. | `default-deny-all` in all 9 namespaces, plus explicit allows from the [East-west dependency inventory](#east-west-dependency-inventory). No `namespaceSelector: {}` or `podSelector: {}` peers across namespaces. | **Gap** → `REQ-003` |
| C-05 | Default-deny egress | As C-04: DNS-only default in `storage`/`governance`, plus `openmetadata-egress`. | As C-04, with egress allows to DNS, the kube-apiserver entity, and the named dependencies. | **Gap** → `REQ-003` |
| C-06 | AppArmor/SELinux enforcing where supported | Nodes are Ubuntu 26.04 (`BOX_NAME=dasomel/ubuntu-26.04-xfs`, `configs/cluster.env`). No manifest sets `appArmorProfile` or `Unconfined` (grep over `gitops/` and `scripts/`). Host state is not measured. | AppArmor enabled on all four nodes, with containers confined by the runtime default profile. No `Unconfined`. | **Verify only** → `REQ-005`. SELinux: **N/A** (no SELinux-native node family). Re-check if `BOX_NAME` changes family. |
| C-07 | Host OS firewall (required where host is managed) | No ufw, nftables, or firewalld management (`scripts/cluster/01-node-prep.sh`). Ubuntu ufw ships inactive. Cilium KPR programs eBPF, not iptables. | Record the provider and state per node (read-only). Cilium Host Firewall (C-08) is the node firewall. Do not enable ufw or firewalld. | **Exception, time-bounded**: owner @dasomel, expiry 2027-03-31 or when C-08 reaches enforce. Rationale: a second, uncoordinated host packet filter next to the Cilium eBPF datapath is the "blind firewall mutation" the baseline forbids. The host-only vmnet12 is the outer boundary. |
| C-08 | Kubernetes-aware host firewall (audit then enforce) | Cilium Helm install without `hostFirewall`, Hubble, or `policyAuditMode` (`scripts/cluster/03-cni-metallb.sh` L22–28). | This change: `hostFirewall.enabled=true`, a host `CiliumClusterwideNetworkPolicy` in **audit**, and Hubble enabled for evidence. Enforcement is out of scope. | **Gap (audit only)** → `REQ-007` |
| C-09 | Workload mTLS (required when a mesh is adopted) | No mesh. TLS terminates at APISIX. Trino (8443), OpenLDAP (636), and the gateway use the internal CA (`beluga-platform/cert-manager-issuer.yaml`). | None in this change. | **N/A**: no mesh adopted. Revisit if a mesh or Cilium mutual auth is proposed. Plaintext east-west paths stay tracked by #2. |
| C-10 | Identity authorization for sensitive paths | Trino OAuth2 + OPA (`06-trino.yaml`), Keycloak SSO for Superset/Airflow, SeaweedFS SigV4, and the APISIX Admin API restricted by label and CIDR. Lakekeeper runs with `openfga.enabled: false` (`beluga-data/values.yaml` L36–39). Flink REST and the filer UI have no auth. | Inventory each sensitive path with its authn/authz mechanism. Unauthenticated paths get an exception or a gateway auth plugin. | **Gap (partial)** → `REQ-006` |
| C-11 | Controlled egress | Unrestricted outside `storage`/`governance`. Runtime internet calls: see [Egress inventory](#egress-inventory). | Default-deny egress plus a Cilium `toFQDNs` allow-list per workload. Denied destinations are proven denied. | **Gap** → `REQ-004` |
| C-12 | Exceptions documented with owner and expiry | No `docs/security-exceptions.md`. | Create it, with each exception from this table carrying an owner, rationale, and expiry. | **Gap** → `REQ-008` |

## Exposure ownership

| Entry point | Address / port | Backends | Class | Owner | Auth today |
|---|---|---|---|---|---|
| APISIX gateway (`platform-system/apisix-gateway`, LoadBalancer) | `192.168.77.200:80→443` redirect, `:443` | 10 host routes: trino, airflow, superset, catalog, s3, filer, flink, argocd, sso, metadata | **internal/private** (host-only vmnet12; `enp26s0`-only L2 advertisement) | beluga-platform chart | per backend (see C-10) |
| Kafka external listener (Strimzi NodePort) | every node IP `:30094` | `streaming/beluga-kafka` | internal/private, **plaintext** | beluga-data chart | none; `aclAuthorizer: false` |
| `grafana-external` NodePort | every node IP `:30000` | none (Grafana not installed) | stray | beluga-platform chart | n/a → remove (`REQ-006`) |
| kube-apiserver | `192.168.77.10:6443` | k3s | internal/private (management) | cluster bootstrap | client cert |
| SSH (Vagrant) | NAT port forward `:22` | nodes | out-of-band management | Vagrantfile | Vagrant key |

In-cluster clients also reach `sso.local.beluga.internal` through the VIP: CoreDNS forwards
`local.beluga.internal` to dnsmasq on master-1, which returns `192.168.77.200`
(`scripts/cluster/10-dnsmasq.sh`). Trino, Superset, Airflow, and `internal-ca-distribution` use
this hairpin. Cilium socket-LB translates the VIP to APISIX pod endpoints before policy
evaluation, so the egress allow rule must select `platform-system/app=apisix`, not an `ipBlock`
of the VIP. This is **unverified**. See `Q-03`.

## East-west dependency inventory

Source: service FQDN references in the rendered charts (`grep -o '*.svc.cluster.local'` over
`gitops/charts`), cross-checked with ApisixUpstreams. Each row becomes an explicit allow.

| From (ns/app) | To (ns/app:port) | Purpose |
|---|---|---|
| platform-system/apisix | every routed backend: analytics/trino:8443, superset; orchestration/airflow; lakehouse/lakekeeper:8181; storage/seaweedfs:8333,8888; streaming/flink-cluster-rest:8081; iam/keycloak:8080; governance/openmetadata:8585; argocd/argocd-server | gateway data plane |
| platform-system/apisix, apisix-ingress-controller | platform-system/apisix-etcd:2379; apisix-admin:9180 | gateway config |
| analytics/trino | iam/keycloak, opa:8181, openldap:389/636; lakehouse/lakekeeper:8181; storage/seaweedfs:8333; APISIX (sso hairpin) | query, authn, authz, catalog, data |
| iam/opa | iam/openfga:8080 | authz |
| iam/keycloak, orchestration/airflow, analytics/superset, lakehouse/lakekeeper (+migrate), governance/openmetadata, streaming/debezium-connect, database jobs | database/postgres-main-rw:5432 | metastore / CDC |
| database/postgres-main | iam/openldap:389 | LDAP auth (plaintext; #2) |
| streaming/flink-cluster, flink-sql-submit | streaming/beluga-kafka; lakehouse/lakekeeper:8181; storage/seaweedfs:8333; flink-cluster-rest:8081 | stream → Iceberg |
| streaming/clickstream-gen | streaming/beluga-kafka bootstrap | demo producer |
| streaming/debezium-register-shop | streaming/debezium-connect:8083 | connector registration |
| lakehouse/lakekeeper-bootstrap | lakehouse/lakekeeper:8181; storage/seaweedfs:8333 | bootstrap |
| analytics/superset-dashboard-import | analytics/superset; trino:8443 | bootstrap |
| iam/keycloak-* jobs | iam/keycloak:8080, openldap:636 | bootstrap |
| orchestration/airflow → analytics KubernetesPodOperator pods | kube-apiserver; analytics/trino:8443 | DAG execution |
| internal-ca-distribution, airflow, apisix-ingress-controller, CNPG instances, Strimzi/Flink operators and Flink JM | **kube-apiserver entity** | control plane |
| all pods | kube-system/kube-dns:53 | DNS |

Under Cilium, egress to the API server and to node IPs needs `toEntities: [kube-apiserver]` (and
`host`/`remote-node` where applicable). A plain `ipBlock` does not select these identities by
default. Where the portable `NetworkPolicy` cannot express a rule, use `CiliumNetworkPolicy`, and
record the portability cost in the ADR.

## Egress inventory

| ID | Destination | Caller | When | Target control |
|---|---|---|---|---|
| E-01 | `pypi.org`, `files.pythonhosted.org` :443 | `orchestration/airflow-webserver` (`pip install authlib apache-airflow-providers-cncf-kubernetes`, `07-airflow.yaml` L150) | every start | `toFQDNs` allow. Removal tracked with #103. |
| E-02 | PyPI :443 | `analytics/superset` init `install-authlib` (`uv pip install`, `08-superset.yaml` L92–98) | every start | `toFQDNs` allow |
| E-03 | PyPI :443 | `streaming/clickstream-gen` (`pip install kafka-python-ng==2.2.2`, `13-clickstream-gen.yaml` L35) | every start | `toFQDNs` allow |
| E-04 | `repo1.maven.org` :443 | `streaming/flink-cluster` init `download-connectors` (`05-flink-operator.yaml` L40–50), `flink-sql-submit` (`14-flink-jobs.yaml` L72–81), SHA-256 pinned (`3385244`) | every start | `toFQDNs` allow |
| E-05 | `github.com` :443 | `argocd/argocd-repo-server` (Application `repoURL`, `gitops/apps/*.yaml`) | continuous | `toFQDNs` allow in `argocd` if that namespace is brought under policy (`Q-05`) |
| E-06 | upstream DNS via dnsmasq on master-1 | CoreDNS (`kube-system`) | continuous | unchanged; `kube-system` is not policed (C-02x) |
| — | image registries (docker.io, quay.io, ghcr.io, …) | containerd on the node, not pods | image pull | not affected by pod NetworkPolicy; the host firewall audit (C-08) records it |

Every other internet destination from a Beluga namespace must be **denied**. Prefect-style
telemetry is not present, but the deny test (`AC-004`) proves the default-deny holds.

## Requirements

- `REQ-001` — Every Beluga namespace (C-02 list) carries PSA labels. `audit`/`warn=restricted` is
  applied first, and `enforce=restricted` follows only after zero violations are observed. System
  namespaces follow C-02x.
- `REQ-002` — Every pod spec that Beluga renders, or asks an operator or DAG to render, in a Beluga
  namespace meets `restricted`: runAsNonRoot, APE=false, drop ALL, and seccomp `RuntimeDefault`.
  ROFS is applied where it was proven not to crash; the Keycloak/APISIX ROFS=false exceptions are
  recorded (mistakes-log 2026-09-19). The Superset root init container is replaced with a
  non-root equivalent.
- `REQ-003` — Every Beluga namespace has `default-deny-all` (Ingress+Egress) and
  `allow-cluster-dns`. Explicit allows exist only for the rows in the East-west dependency
  inventory. No production policy uses an unrestricted cross-namespace selector.
- `REQ-004` — Internet egress from Beluga namespaces is limited to the E-01–E-05 FQDN allow-list,
  per workload. All other destinations are denied.
- `REQ-005` — The AppArmor state is recorded per node from a read-only inspection, container
  confinement is sampled, and no workload uses `Unconfined`.
- `REQ-006` — Exposure ownership is recorded. The dangling `grafana-external` NodePort is removed
  or gated. Kafka `:30094` and every management route without authentication have either an auth
  control or an exception entry.
- `REQ-007` — Cilium Host Firewall runs in **audit** with Hubble enabled. The flows seen in audit
  cover kube-apiserver, kubelet, VXLAN node-to-node, DNS, MetalLB L2 announcements, NodePorts, and
  SSH, with no enforcement.
- `REQ-008` — `docs/security-exceptions.md` lists every exception and N/A item in this package,
  each with an owner, rationale, and expiry or review trigger.
- `REQ-009` — Allow and deny connectivity paths are tested by a deterministic live test script,
  and static policy coverage is gated in `make validate`.
- `REQ-010` — Every enforcement step has a documented, tested rollback that works with ArgoCD
  `selfHeal: true`.

## Acceptance scenarios

### `AC-001` — PSA staged then enforced

- Covers: `REQ-001`
- Given a Beluga namespace labelled `pod-security.kubernetes.io/audit=restricted` and
  `warn=restricted`,
- when `kubectl label --dry-run=server --overwrite ns <ns> pod-security.kubernetes.io/enforce=restricted`
  is run,
- then it returns no warnings. After enforcement, a probe pod without a securityContext is
  **rejected**, and all existing workloads stay Ready through a rollout restart.

### `AC-002` — Runtime posture

- Covers: `REQ-002`
- Given both charts rendered with production values and with `openmetadata.enabled=true`,
- when the static posture check runs over every pod template,
- then every container in a Beluga namespace resolves to runAsNonRoot, APE=false, drop ALL, and
  seccomp RuntimeDefault. Live, every Deployment, StatefulSet, and Job reaches Ready or Complete,
  and `kubectl get pod -o jsonpath` confirms the effective securityContext on CNPG, Kafka, and
  Flink pods.

### `AC-003` — Required connectivity allowed

- Covers: `REQ-003`, `REQ-009`
- Given default-deny in all nine namespaces,
- when test 15 runs from the real client pods (`kubectl exec`),
- then each of these succeeds:
  - trino → lakekeeper:8181, seaweedfs:8333, opa:8181, openldap:636, and keycloak;
  - airflow, superset, and keycloak → postgres-main-rw:5432;
  - flink → kafka bootstrap and seaweedfs;
  - apisix → every routed backend;
  - superset/trino → `https://sso.local.beluga.internal` (VIP hairpin).
- The domain-registry entry path returns the expected status for all ten hosts, and the existing
  tests 01, 04, 06–10, and 12 still pass.

### `AC-004` — Unrequired connectivity denied

- Covers: `REQ-003`, `REQ-004`, `REQ-009`
- Given the same state,
- when a throwaway pod (in `default` and inside each Beluga namespace, with no allowed labels)
  tries postgres-main-rw:5432, seaweedfs:8333, openldap:389, apisix-admin:9180, and trino:8443,
- then each attempt times out or is refused.
- In addition:
  - airflow → seaweedfs:8333 is denied (not in the inventory);
  - clickstream-gen → postgres is denied;
  - any Beluga pod → `https://example.com` and a raw public IP:443 are denied;
  - airflow → `pypi.org:443` is allowed.
- Hubble shows `DROPPED` verdicts for the denied flows.

### `AC-005` — LSM posture

- Covers: `REQ-005`
- Given all four nodes,
- when OpenForge `check-host-security.sh` (read-only) runs and
  `cat /proc/<container-pid>/attr/current` is sampled,
- then AppArmor is enabled on every node, containers show a runtime default profile in enforce
  mode, and a grep of the render finds no `Unconfined`.

### `AC-006` — Exposure

- Covers: `REQ-006`
- Given the rendered charts,
- when Services are listed,
- then the only non-ClusterIP Services are `apisix-gateway` (LoadBalancer) and the recorded Kafka
  NodePort. `grafana-external` is gone or gated. From the host, `nc -z <node-ip> 30000` fails.
  Every management route in the Exposure ownership table has an auth control or an exception
  entry.

### `AC-007` — Host firewall audit

- Covers: `REQ-007`
- Given Cilium with `hostFirewall.enabled=true` and a host policy in audit,
- when normal operation runs for at least 24 hours, including a full `make test` run,
- then Hubble shows audit verdicts only, with no drops caused by the host policy. The observed
  flow set is attached as evidence, and SSH plus kube-apiserver stay reachable.

### `AC-008` — Rollback works under selfHeal

- Covers: `REQ-010`
- Given one enforced namespace policy,
- when the documented rollback is executed,
- then connectivity is restored within one ArgoCD sync, and the restored state is not silently
  reverted by selfHeal.

## Architecture and decisions

- Relevant ADR/design links: `docs/adr/0001-vagrant-k3s-gitops-platform-architecture.md`,
  `docs/validation/kube-proxy-free-en.md`, OpenForge ADR-0014.
- ADR threshold result: **required**. This change crosses a security boundary and introduces
  Cilium-specific policy CRDs (`CiliumNetworkPolicy` for FQDN, entity, and host rules) that reduce
  portability. The ADR is authored as `docs/adr/0003-kubernetes-security-baseline{,-ko}.md` and
  indexed in both READMEs, following the precedent of kubemetal ADR-0003.
- Alternatives and trade-offs:
  - _Portable `NetworkPolicy` only_: this cannot express FQDN egress or apiserver/host entities,
    and would force `ipBlock 0.0.0.0/0` egress. Rejected for C-11.
  - _Cluster-wide `policyAuditMode=true` staging_: this gives observable default-deny before
    enforcement. It also temporarily disables the already-enforced `apisix-admin-restrict` and
    `seaweedfs-data-plane-restrict`, so tests 08 and 09 fail during the window. The alternative
    is per-endpoint audit (`cilium-dbg endpoint config <id> PolicyAuditMode=Enabled`), which is
    not GitOps-declarable. See `Q-02`.
  - _ufw on nodes_: rejected (C-07).
  - _Per-app policy instead of namespace-wide default-deny_ (as kubemetal did): not needed.
    Beluga owns every workload in these namespaces.

## Change impact

| Area | Impact / evidence needed |
|---|---|
| Source / API / command | Chart templates (NetworkPolicy/CiliumNetworkPolicy, securityContext, Namespace labels); `scripts/cluster/03-cni-metallb.sh` (Cilium values: Hubble, hostFirewall); new `tests/15-*.sh`, `tests/16-*.sh`; static check under `scripts/ci/` |
| Dependencies / lockfiles | N/A — no new packages. Cilium `hubble-relay`/`hubble-ui` images come with the pinned 1.20.0 chart and must be listed in `VERSIONS.md` if deployed |
| Runtime / toolchain | Cilium agent restart when Helm values change. Known hazard: stale socket-LB/conntrack after an agent restart hangs TLS on older pods (mistakes-log 2026-09-08). A planned restart of dependent pods is required |
| CI / CD | `make validate` gains a static policy/posture gate. ArgoCD `selfHeal` applies every chart change; bootstrap (`01-argocd-bootstrap.sh`) applies the non-GitOps parts |
| Release / packaging | N/A — no release artifacts. `CHANGELOG` entry at completion |
| Generated output | N/A |
| Security / supply chain | Core of the change. Introduces an FQDN allow-list (depends on Cilium DNS proxy). Interacts with #103 (pip hashes, PR #133) and #2 (plaintext identity, PR #132) |
| Offline / air-gap | FQDN allow-list documents the exact runtime internet set; air-gap needs E-01..E-04 removed (#103) |
| Documentation / operations | `docs/security-exceptions.md` (new), ADR-0003, `docs/access-guide*.md` (NodePort changes), `docs/development*.md` (new tests), break-glass in `docs/mistakes-log.md` discriminators |
| Portfolio / downstream repositories | Feed reusable gaps to OpenForge: (1) Cilium `ipBlock` does not match apiserver/node identities, (2) VIP hairpin under socket-LB, (3) staging default-deny under selfHeal. `beluga-manager` consumes the same gateway and needs a heads-up |

### Open PRs #131–#137

| PR | Touches security controls? | Package impact |
|---|---|---|
| #131 CI concurrency | No | None |
| #132 identity plaintext preflight in `make validate` | Adjacent (C-09/C-10 plaintext inventory) | Reuse its preflight; do not duplicate. Land it before `REQ-009` static gate to avoid `Makefile` conflict |
| #133 pip hash integrity (#103) | Adjacent (supply chain, E-01..E-03) | No conflict; E-01..E-03 shrink when #103 bakes deps |
| #134 VERSIONS/NOTICE | No | Hubble images, if added, must pass it |
| #135 status/evidence | No | Evidence for this change lands in `research/evidence/` in the same format |
| #136 TLS certificate inventory (#47) | Adjacent: edits `apisix-gateway.yaml`, `openldap.yaml`, `06-trino.yaml`, `cert-manager-issuer.yaml` | Textual merge risk only; land #136 first, rebase |
| #137 Makefile/CI stage parity | No (but gates `Makefile`) | New `validate` step must stay in parity with documented CI stages |

## Verification plan

| Acceptance ID | Verification method | Environment | Expected evidence |
|---|---|---|---|
| `AC-001` | `kubectl label --dry-run=server` per ns; negative probe `kubectl run psa-probe --image=busybox` | live (isolated kubeconfig per `AGENTS.md`) | zero warnings; probe rejected with `violates PodSecurity "restricted"` |
| `AC-002` | static: new `scripts/ci/check-pod-security-posture.py` over `helm template` (both value sets) in `make validate`; live: `kubectl get pods -A -o json \| jq` effective securityContext | CI + live | CI exit 0; per-pod posture table |
| `AC-003` | `tests/15-network-baseline-live.sh` allow matrix (`kubectl exec` from real pods, `nc -z -w5` / `curl`); `make test`; domain registry curl for 10 hosts | live | per-edge PASS lines; test run log |
| `AC-004` | same script, deny matrix; `hubble observe --verdict DROPPED --since 5m` | live | per-edge PASS (= denied); Hubble drop excerpt |
| `AC-005` | `check-host-security.sh` (read-only) on 4 nodes; `aa-status`; `/proc/<pid>/attr/current` | live nodes | per-node table (AppArmor enabled, profile mode) |
| `AC-006` | static: rendered Service types; live: `kubectl get svc -A`, `nc -z` from host | CI + live | Service inventory; closed port |
| `AC-007` | `cilium status`, `hubble observe --verdict AUDIT` over ≥ 24 h incl. `make test` | live | flow set; zero host-policy drops |
| `AC-008` | rollback drill on `lakehouse` (lowest blast radius) | live | timeline: break → rollback → restored, ArgoCD revision |

Evidence classes are reported separately (static/lint vs live vs manual entry-path) per `AGENTS.md`;
a lower class never stands in for a higher one. Static evidence alone does **not** close this issue.

## Rollout, rollback and recovery

### Rollout sequence (OpenForge rollout order, adapted)

1. **Inventory (read-only)**: host LSM/firewall on each node, live effective securityContext, Cilium config. No mutation.
2. **Observability**: enable Hubble (Cilium Helm values). Then roll-restart long-lived pods on purpose (mistakes-log 2026-09-08 hazard).
3. **Runtime posture**: fix `securityContext` gaps one workload per commit, starting with non-stateful workloads.
4. **PSA audit/warn** on all nine namespaces → observe → **enforce** namespace by namespace.
5. **Exposure**: remove or gate `grafana-external`, record Kafka 30094, and add management-route auth or exceptions.
6. **Default-deny**: one namespace per commit, allows before deny. Order by blast radius: `lakehouse` → `iam` → `analytics` → `orchestration` → `streaming` → `database` → `platform-system` (gateway last).
7. **Egress FQDN** allow-lists per workload after the namespace is under default-deny.
8. **Host firewall audit** (no enforce).
9. **Regression tests and evidence**, then the exception register and ADR.

Each step is pushed, synced by ArgoCD, and verified with its acceptance scenario before the next
step starts. Unpushed fixes get reverted by selfHeal (mistakes-log 2026-09-20).

### Rollback by enforcement type

| Change | Fail mode | Rollback | Recovery path if the API is unreachable |
|---|---|---|---|
| PSA `enforce` label | New pods rejected (existing pods unaffected) | `git revert` of the label commit → push → ArgoCD sync. Break-glass: set `enforce=privileged` after disabling auto-sync on the owning Application (`argocd app set <app> --sync-policy none`) | n/a — PSA does not affect running pods or API reachability |
| securityContext | CrashLoop (ROFS/UID; see Keycloak/APISIX 2026-09-19) | `git revert` the per-workload commit → push → sync → `rollout restart` | n/a |
| Namespace default-deny / allows | Timeouts on a missed flow (OpenMetadata 2026-09-19/22) | Preferred: add the missing allow (forward fix) once Hubble shows the dropped flow. Otherwise `git revert` the namespace commit → push → sync. Break-glass: disable auto-sync on `beluga-data`/`beluga-platform`, `kubectl delete netpol default-deny-all -n <ns>`, then fix forward and re-enable. Note that a plain `kubectl delete` is re-applied by selfHeal | Policies never block kubelet→API or node SSH; API stays reachable |
| FQDN egress (CiliumNetworkPolicy) | Pod start fails on pip/maven download | Same as above. Pods already running are unaffected until restart | same |
| Cilium Helm values (Hubble, hostFirewall) | Agent restart; stale TLS sockets | `helm rollback cilium -n kube-system` to the previous revision. Roll-restart pods started before the agent restart | VMware console on master-1 → `k3s kubectl` on loopback |
| Host firewall **audit** | None expected (audit never drops). If a drop is seen, the mode was wrong | `kubectl delete ccnp <host-policy>`; `helm rollback cilium` | VMware console / `vagrant ssh` (NAT forward; SSH must be allowed in host policy **before** any future enforce) |

No step flushes or enables a host firewall, changes an LSM mode, or replaces the CNI.

- Data/configuration recovery: none. No step touches PVC data. The CNPG and SeaweedFS pods keep
  their volumes, and the `fsGroup` retrofit hazard applies (kubemetal ADR-0003 §6).
- Compatibility or migration obligations: `beluga-manager` and any external Kafka client on
  `:30094` need notice before step 5.

## Evidence and durable synchronization

- Evidence location/format: `research/evidence/2026-MM.jsonl` (same format as PR #135) plus the
  PR description per step. Attach Hubble excerpts and test logs, and retain failures.
- Durable regression controls: `scripts/ci/check-pod-security-posture.py` and the policy-coverage
  check in `make validate`. Live tests `tests/15-network-baseline-live.sh` (allow/deny) and
  `tests/16-host-security-readonly.sh` (LSM/host inventory), added to `tests/run-all.sh`.
- Documentation to update: `docs/security-exceptions.md` (new), `docs/access-guide*.md`,
  `docs/development*.md`, `docs/architecture*.md` (security section), `docs/mistakes-log.md`.
- ADR/evidence/portfolio records: ADR-0003 (+ `-ko`, both indexes), `.openforge/status.json`
  capability `k8s-security-baseline`, and an OpenForge feedback issue for the reusable gaps.

## Risks

- **R1 — Missed flow under default-deny** (proven twice in `governance`). Mitigations: allows land
  before the deny, Hubble evidence, the per-namespace order, and gateway last.
- **R2 — Cilium agent restart side effects** (stale sockets, 2026-09-08). Mitigation: a planned
  roll-restart and a maintenance window.
- **R3 — FQDN policy depends on the Cilium DNS proxy.** It changes the DNS path for selected pods.
  CoreDNS → dnsmasq forwarding must keep working. Validate on one workload first.
- **R4 — PSA enforce vs operator-rendered pods** (Strimzi, Flink, CNPG) that Beluga does not fully
  control. A mitigation must go through the operators' pod-template APIs. Where that is not
  possible, the namespace stays at `baseline` enforce plus `restricted` audit, with an exception.
- **R5 — No live cluster in the authoring session.** Every claim about the current state in this
  package is render-based.
- **R6 — Portability.** CiliumNetworkPolicy ties Beluga to Cilium. This is acceptable because
  Cilium is already a hard dependency (kube-proxy-free). It is recorded in the ADR.

## Review record

- Accepted scope/requirements: _pending_
- Material changes after acceptance and re-review: _none yet_
- Open questions for the reviewer:
  - `Q-01` Profile: confirm `production`, and that `zero-trust` is out of scope because there is
    no mesh.
  - `Q-02` Staging mechanism for default-deny. Choose between cluster-wide Cilium
    `policyAuditMode` (observable, but temporarily relaxes the enforced policies behind tests 08
    and 09) and per-namespace direct enforcement with allows-first plus Hubble (default in this
    package).
  - `Q-03` VIP hairpin: should in-cluster OIDC traffic keep going through the VIP (policy must
    allow apisix pods), or should it move to `keycloak.iam.svc` with a split issuer?
  - `Q-04` Management surfaces: accept time-bounded exceptions for Flink REST, the filer UI, and
    Lakekeeper (OpenFGA off)? Or add gateway auth (`openid-connect` plugin) in this change? That
    would widen the scope into auth/gateway behavior and require both entry-path checks.
  - `Q-05` System namespaces (`argocd`, `cert-manager`, `cnpg-system`): bring them under
    default-deny now, or keep them as exceptions with an expiry?
  - `Q-06` Kafka `:30094` plaintext NodePort: who are the external clients? Keep it as an
    exception, restrict the source to `192.168.77.0/24`, or remove it?
  - `Q-07` Exception expiry: 2027-03-31 is proposed for C-01, C-07, and C-02x review. Confirm the
    owner and date.
  - `Q-08` Should the package files merge into `main`, or live only on this PR as the change
    record? The OpenForge default is PR-only.
