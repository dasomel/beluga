# Beluga #125 Security Baseline Analysis (OpenForge PR #77 `production` profile adoption)

> 원본 스냅샷(2026-09-17 작성, `mdp/` 루트에서 이관 2026-10-15). 이후 머지된 #125 관련 변경은 반영되지 않았다 — 현재 상태는 이슈 #125와 main을 기준으로 확인한다.

Source of truth: [dasomel/openforge#77](https://github.com/dasomel/openforge/pull/77) (MERGED, 800 additions / 14 files).
Reusable assets consumed: `templates/kubernetes/security/security-profile.example.yml`,
`templates/kubernetes/security/workload-baseline.yaml`, `templates/kubernetes/security/mesh-istio-ambient-strict.yaml`,
`templates/kubernetes/security/check-host-security.sh`.

Platform facts that constrain every recommendation below:

| Fact | Evidence |
|---|---|
| CNI is **Cilium 1.20.0**, `kubeProxyReplacement=true` | `scripts/cluster/03-cni-metallb.sh:19-26` |
| k3s runs with `--flannel-backend=none --disable-network-policy` | `scripts/cluster/02-k8s-init.sh:27` — k3s' own netpol controller is off; **Cilium is the sole NetworkPolicy enforcer** |
| Host OS is **Ubuntu 26.04** → AppArmor-native (not SELinux) | `Vagrantfile:25` (`dasomel/ubuntu-26.04-xfs`) |
| No host firewall / LSM mutation is shipped | `grep -riE "apparmor\|selinux\|ufw\|firewalld\|nftables" scripts/ docs/` → only `net.bridge.bridge-nf-call-iptables` in `scripts/cluster/01-node-prep.sh:27` |
| Ingress is APISIX only; nginx Ingress removed (D11) | `gitops/charts/beluga-data/templates/09-ingress.yaml` is intentionally empty |
| Single LoadBalancer (MetalLB) — **one gateway, not two** | `apisix-gateway` Service `type: LoadBalancer`, `apisix-gateway.yaml:196-199` |

---

## 1. Exposure & dependency inventory

### 1.1 Namespaces (9 declared, 2 charts)

| Namespace | Declared in | Workloads |
|---|---|---|
| `platform-system` | `beluga-platform/templates/00-namespaces.yaml` | `apisix`, `apisix-ingress-controller`, `apisix-etcd`, `internal-ca-distribution` (Job) |
| `iam` | `beluga-platform/templates/00-namespaces.yaml` | `keycloak`, `opa`, `openfga`, `openldap`, + 6 Jobs (`openldap-init`, `keycloak-clients`, `keycloak-users`, `keycloak-group-mapper`, `keycloak-ldap-federation`, `keycloak-role-migration`) |
| `database` | `beluga-data/templates/00-namespaces.yaml` | `postgres-main` (CNPG `Cluster` CR), `shop-seed` (Job), `db-roles-setup` (Job) |
| `storage` | `beluga-data/templates/00-namespaces.yaml` | `seaweedfs` (StatefulSet, 1 replica) |
| `streaming` | `beluga-data/templates/00-namespaces.yaml` | `beluga-kafka` (Strimzi `Kafka` + `KafkaNodePool`), `debezium-connect`, `debezium-register-shop` (Job), `flink-cluster` (`FlinkDeployment`), `flink-sql-submit` (Job), `clickstream-gen` |
| `lakehouse` | `beluga-data/templates/00-namespaces.yaml` | `lakekeeper`, `lakekeeper-migrate` (Job), `lakekeeper-bootstrap` (Job) |
| `analytics` | `beluga-data/templates/00-namespaces.yaml` | `trino-coordinator`, `trino-worker` (`workerEnabled: false`), `superset`, `superset-dashboard-import` (Job) |
| `orchestration` | `beluga-data/templates/00-namespaces.yaml` | `airflow-webserver` (KubernetesExecutor → spawns task pods in-namespace) |
| `governance` | `beluga-data/templates/00-namespaces.yaml` | `opensearch`, `openmetadata`, `openmetadata-migration` (Job) — **all gated `openmetadata.enabled: false`** (`beluga-data/values.yaml:43`) |

Out-of-chart namespaces also in play: `kube-system` (Cilium, CoreDNS), `argocd`, `metallb-system`, `cert-manager`.

### 1.2 Services and ports

| Namespace | Service | Type | Ports | Externally routed? |
|---|---|---|---|---|
| `platform-system` | `apisix-gateway` | **LoadBalancer** | 80→9080, 443→443 | **YES — the only external ingress** |
| `platform-system` | `apisix-admin` | ClusterIP | 9180 | No — restricted by NetworkPolicy |
| `platform-system` | `apisix-etcd` | ClusterIP | 2379 (client), 2380 (peer) | No |
| `platform-system` | `grafana-external` | **NodePort** | `prometheusGrafana.grafanaPort` (3000) → 3000 | **YES — bypasses APISIX (see §3 gap G2)** |
| `iam` | `keycloak` | ClusterIP | 8080 | Via APISIX (`sso.{baseDomain}`) |
| `iam` | `opa` | ClusterIP | 8181 | No |
| `iam` | `openfga` | ClusterIP | 8080 (http), 8081 (grpc), 3000 (playground) | No |
| `iam` | `openldap` | ClusterIP | 389 (ldap), 636 (ldaps) | No |
| `database` | `postgres-main-rw` (CNPG-generated) | ClusterIP | 5432 | No |
| `storage` | `seaweedfs-s3` | ClusterIP | 8333 (s3), 8888 (filer) | Via APISIX (`s3.`, `filer.`) |
| `streaming` | `debezium-connect` | ClusterIP | 8083 (rest) | No |
| `streaming` | `beluga-kafka-*` (Strimzi-generated) | ClusterIP/headless | 9092/9093, external 9094 (`kafka.externalPort`) | Operator-managed |
| `streaming` | `flink-cluster-rest` (operator-generated) | ClusterIP | 8081 (`flink.uiPort`) | Via APISIX (`flink.`) |
| `lakehouse` | `lakekeeper` | ClusterIP | 8181 (`lakekeeper.port`) | Via APISIX (`catalog.`) |
| `analytics` | `trino` | ClusterIP | 8080 (`trino.port`), 8443 (https) | Via APISIX (`trino.`) |
| `analytics` | `superset` | ClusterIP | 8088 (`superset.uiPort`) | Via APISIX (`superset.`) |
| `governance` | `opensearch` | ClusterIP | 9200 | No |
| `governance` | `openmetadata` | ClusterIP | 8585 | Via APISIX (`metadata.`) |

### 1.3 External (public) exposure surface — APISIX host routes

All via the single `apisix-gateway` LoadBalancer on 443. `{{ .Values.baseDomain }}` = `local.beluga.internal`.

| Host | Route file | Upstream |
|---|---|---|
| `trino.local.beluga.internal` | `beluga-data/templates/10-apisix-route.yaml:26-41` | `trino.analytics.svc.cluster.local` |
| `airflow.local.beluga.internal` | `10-apisix-route.yaml:62-77` | `airflow.orchestration.svc.cluster.local` |
| `superset.local.beluga.internal` | `10-apisix-route.yaml:98-113` | `superset.analytics.svc.cluster.local` |
| `catalog.local.beluga.internal` | `10-apisix-route.yaml:134-149` | `lakekeeper.lakehouse.svc.cluster.local` |
| `s3.local.beluga.internal` | `10-apisix-route.yaml:169-184` | `seaweedfs-s3.storage.svc.cluster.local:8333` |
| `filer.local.beluga.internal` | `10-apisix-route.yaml:204-219` | `seaweedfs-s3.storage.svc.cluster.local:8888` |
| `flink.local.beluga.internal` | `10-apisix-route.yaml:239-248` | `flink-cluster-rest.streaming.svc.cluster.local` |
| `argocd.local.beluga.internal` | `beluga-platform/templates/apisix-routes.yaml:15-30` | `argocd-server.platform-system` |
| `sso.local.beluga.internal` | Keycloak route | `keycloak.iam.svc.cluster.local:8080` |
| `metadata.local.beluga.internal` | `11-openmetadata.yaml:227` | `openmetadata.governance` (disabled) |

**Internal-only (no external route):** `opa`, `openfga`, `openldap`, `apisix-etcd`, `apisix-admin`, `postgres-main-rw`, `debezium-connect`, `opensearch`, Kafka brokers.

---

## 2. Current NetworkPolicy baseline — **3 policies exist, all Ingress-only, all single-pod scoped**

`grep -rn "kind: NetworkPolicy" gitops/` returns exactly three:

| Policy | Namespace | `podSelector` | policyTypes | What it does |
|---|---|---|---|---|
| `apisix-admin-restrict` | `platform-system` | `app: apisix` | Ingress | Allows 9080/443 from anywhere; allows 9180 only from `app: apisix-ingress-controller` (same ns). `apisix-gateway.yaml:476-506` |
| `seaweedfs-data-plane-restrict` | `storage` | `app: seaweedfs` | Ingress | Allows 8333/8888 from an explicit 6-peer list (trino, flink-cluster, flink-sql-submit, lakekeeper, lakekeeper-bootstrap, same-ns, apisix). `01-seaweedfs.yaml:185-247` |
| `opensearch-allow-openmetadata-only` | `governance` | `app: opensearch` | Ingress | Allows 9200 only from `openmetadata` / `openmetadata-migration`. `11-openmetadata.yaml:243-264`. **Inert — namespace gated off.** |

### Baseline verdict

| Control (OpenForge `production`) | Beluga state |
|---|---|
| `networkPolicy.defaultDenyIngress: true` | **PARTIAL** — 3 pods are effectively default-deny-ingress (a selected pod denies all unlisted ports). **0 of 9 namespaces have a namespace-wide `podSelector: {}` default-deny.** Any new pod in any namespace is fully open. |
| `networkPolicy.defaultDenyEgress: true` | **NONE** — zero policies in the repo carry `policyTypes: Egress`. No egress control exists anywhere. |
| `allow-cluster-dns` baseline | **NONE** — not needed yet because no default-deny egress exists; becomes mandatory the moment one is added. |
| `podSecurityStandard: restricted` | **NONE** — `grep -rn "pod-security.kubernetes.io" gitops/` returns **zero hits**. No namespace carries enforce/audit/warn labels. |
| `seccompProfile: RuntimeDefault` | **1 of 23 workloads** — only `openldap` (`openldap.yaml:131`, `:307`). Not covered by #117, which addressed `runAsNonRoot`/`readOnlyRootFilesystem`/`capabilities.drop`. |
| `runAsNonRoot` / `allowPrivilegeEscalation: false` / `dropCapabilities: [ALL]` | **DONE (22/23)** via #117 (a514045, 22453f4). |
| External vs internal gateway separation | **NOT SEPARATED** — one `apisix-gateway` LoadBalancer serves both, plus one `grafana-external` NodePort bypassing it. |
| `serviceIdentity` / mTLS (Istio Ambient) | **N/A** — no service mesh installed; see §6. |
| Host firewall / Cilium Host Firewall | **NOT ENABLED** — `kubernetesAwareFirewall` absent; Cilium installed with only `ipam.mode` + `kubeProxyReplacement`. |
| LSM (AppArmor) | **Host-native, untouched** — correct per issue scope ("preserve"); see §6. |

---

## 3. Phased breakdown

### 3.1 SAFE-NOW (recommended first increment) — namespace-wide default-deny in `storage`

**Why `storage` and not any other namespace:**

1. It holds exactly **one workload** (`seaweedfs` StatefulSet, `replicas: 1`).
2. Its ingress allow-list **is already written and field-proven** — `seaweedfs-data-plane-restrict` enumerates all 6 legitimate peers and has survived live regression testing (`tests/09-seaweedfs-authz-live.sh`).
3. It has **zero outbound network dependency**, verified line by line:
   - init container `render-s3-identities` (`01-seaweedfs.yaml:60-105`) runs `sed` over a mounted ConfigMap using Secret-sourced env vars — **no network call** despite the `curlimages/curl` image.
   - main container `master-volume-s3` runs `weed server -s3 -filer.port... -dir=/data` (`01-seaweedfs.yaml:109-127`) — master, volume, filer and S3 gateway are all in **one pod**, so their mutual traffic is loopback and is not subject to NetworkPolicy at all.
   - `grep` for external URLs under `storage` returns nothing: no package registry, no API server, no other namespace.
4. A regression test already exists and already asserts both the allowed and the denied direction.

**Proposed manifests** (adapted from OpenForge `workload-baseline.yaml`, DNS peer labels matched to k3s CoreDNS):

```yaml
# default-deny for the whole namespace — closes the "new pod is wide open" gap.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: storage
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# First mandatory exception after default-deny egress.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cluster-dns
  namespace: storage
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
```

Policies are additive, so the existing `seaweedfs-data-plane-restrict` ingress allows continue to apply unchanged.

**Optional zero-risk riders in the same increment:**

| Rider | Risk | Note |
|---|---|---|
| Same two policies in `governance` | **Zero** — namespace is empty (`openmetadata.enabled: false`) | Pre-stages coverage for when the 48GB profile turns it on |
| `pod-security.kubernetes.io/audit` + `/warn: restricted` labels on all 9 namespaces | **Zero** — non-blocking, emits warnings only | Do **NOT** add `enforce` — it would reject `airflow-webserver`, `superset` and `clickstream-gen`, which #117 classified RISKY (root / boot-time `pip install`) |

**Blast radius: 1 namespace, 1 workload, 2–3 files.**
- `gitops/charts/beluga-data/templates/01-seaweedfs.yaml` (append 2 resources) — or a new `00b-network-baseline.yaml` if the team prefers policy separation.
- `tests/09-seaweedfs-authz-live.sh` (extend) or new `tests/15-networkpolicy-baseline.sh` + one line in `tests/run-all.sh`.
- With the optional PSA-label rider: +2 files (`beluga-data/templates/00-namespaces.yaml`, `beluga-platform/templates/00-namespaces.yaml`).

### 3.2 NEEDS-DESIGN (do not attempt in the first increment)

| Area | Why it is blocked |
|---|---|
| `analytics` / `streaming` / `lakehouse` default-deny | Dense east-west mesh (§4). Trino alone fans out to `postgres-main-rw:5432`, `seaweedfs-s3:8333`, `lakekeeper:8181`, `opa:8181`, `keycloak:8080` across 5 namespaces. Egress default-deny here needs all five allow rules landed and verified together. |
| `orchestration` default-deny egress | `airflow-webserver` runs `pip install --no-cache-dir authlib apache-airflow-providers-cncf-kubernetes` **at boot** (`07-airflow.yaml:150`) → hard PyPI egress dependency. Also `executor: KubernetesExecutor` → needs Kubernetes **API server** egress and ingress from task pods it spawns. |
| `database` default-deny | Pods are CNPG-operator-generated (`Cluster` CR). The operator in its own namespace must reach pod ports for reconciliation and failover; wrong rules cause silent failover breakage, not an obvious 403. |
| `streaming` Kafka/Flink default-deny | Strimzi (`Kafka`, `KafkaNodePool`) and flink-kubernetes-operator (`FlinkDeployment`) own the pod specs and labels. Same operator-reachability problem plus inter-broker and JobManager↔TaskManager traffic. |
| Egress allowlisting to package registries | `repo1.maven.org` (×5, Flink connector JARs, `14-flink-jobs.yaml:65-71`), PyPI (airflow, superset, clickstream-gen), `raw.githubusercontent.com`. Standard NetworkPolicy **cannot express FQDN rules** — this requires `CiliumNetworkPolicy` `toFQDNs`, which is a CRD/enforcement change, or baking dependencies into images. |
| Kubernetes API server egress | `internal-ca-distribution` and the Keycloak reconcile Jobs call `https://kubernetes.default.svc` (`internal-ca-distribution.yaml:60`). Under default-deny egress the API server is **not** reachable via `namespaceSelector` — it needs `ipBlock` with the node/apiserver IP, or Cilium's `toEntities: kube-apiserver`. Cluster-specific; must be derived at deploy time. |
| External/public vs internal/private gateway separation | Requires a second MetalLB `IPAddressPool` + second APISIX Service, and a per-route decision for all 10 hosts. `grafana-external` (NodePort) is a separate pre-existing bypass to fold in. |
| Cilium Host Firewall (`audit` → `enforce`) | OpenForge ships it as a reference only and explicitly ships no firewall mutation. Needs node inventory + rollback before the audit pass. |
| `pod-security ... enforce: restricted` | Blocked on the 3 RISKY workloads from #117 (`airflow-webserver`, `superset`, `clickstream-gen`). Needs pre-built images or per-namespace exceptions. |
| `seccompProfile: RuntimeDefault` rollout (22 workloads) | Low risk but a wide diff; belongs in its own increment so a seccomp-induced crash is not confounded with a NetworkPolicy-induced one. |

---

## 4. Required intra-cluster traffic paths (input for allow rules)

Derived from `grep -rhoE "[a-z0-9.-]+\.(ns)\.svc\.cluster\.local(:[0-9]+)?" gitops/charts/`, cross-checked against Service port definitions.

| Source (ns / workload) | Destination | Port | Evidence |
|---|---|---|---|
| `analytics` / `trino-coordinator` | `seaweedfs-s3.storage` | 8333 | `06-trino.yaml:18` |
| `analytics` / `trino-coordinator` | `lakekeeper.lakehouse` | 8181 | Iceberg REST catalog config |
| `analytics` / `trino-coordinator` | `opa.iam` | 8181 | Trino OPA access-control plugin |
| `analytics` / `trino-coordinator` | `postgres-main-rw.database` | 5432 | Postgres connector |
| `analytics` / `trino-coordinator` | `keycloak.iam` | 8080 | OIDC / JWT authn |
| `analytics` / `superset` | `trino.analytics` | 8080 / 8443 | Same-namespace |
| `analytics` / `superset` | `postgres-main-rw.database` | 5432 | Metadata DB |
| `analytics` / `superset` | `keycloak.iam` (via `sso.` host) | 443 → gateway | OIDC |
| `analytics` / `superset-dashboard-import` | `superset.analytics` | 8088 | Same-namespace Job |
| `streaming` / `flink-cluster` | `seaweedfs-s3.storage` | 8333 | `05-flink-operator.yaml:18` |
| `streaming` / `flink-cluster` | `lakekeeper.lakehouse` | 8181 | Iceberg sink |
| `streaming` / `flink-cluster` | `beluga-kafka` brokers (same ns) | 9092/9093 | Strimzi-generated |
| `streaming` / `flink-sql-submit` | `flink-cluster-rest.streaming` | 8081 | `14-flink-jobs.yaml` job submission |
| `streaming` / `flink-sql-submit` | `seaweedfs-s3.storage` | 8333 | Allowed peer in existing policy |
| `streaming` / `debezium-connect` | `postgres-main-rw.database` | 5432 | CDC source |
| `streaming` / `debezium-connect` | `beluga-kafka` brokers (same ns) | 9092/9093 | Connect sink |
| `streaming` / `debezium-register-shop` | `debezium-connect.streaming` | 8083 | `03-strimzi-kafka.yaml:167-170` |
| `streaming` / `clickstream-gen` | `beluga-kafka` brokers (same ns) | 9092 | Producer |
| `lakehouse` / `lakekeeper` | `postgres-main-rw.database` | 5432 | Catalog DB |
| `lakehouse` / `lakekeeper` | `seaweedfs-s3.storage` | 8333 | Warehouse storage |
| `lakehouse` / `lakekeeper` | `openfga.iam` | 8080 | `values.yaml:40` — **gated `enabled: false` (D14)** |
| `lakehouse` / `lakekeeper-migrate` | `postgres-main-rw.database` | 5432 | Schema migration Job |
| `lakehouse` / `lakekeeper-bootstrap` | `lakekeeper.lakehouse` | 8181 | `12-lakekeeper-bootstrap.yaml` |
| `lakehouse` / `lakekeeper-bootstrap` | `seaweedfs-s3.storage` | 8333 | `12-lakekeeper-bootstrap.yaml:53` |
| `orchestration` / `airflow-webserver` | `postgres-main-rw.database` | 5432 | `07-airflow.yaml:160` |
| `orchestration` / `airflow-webserver` | `trino.analytics` | 8080/8443 | DAG tasks |
| `orchestration` / `airflow-webserver` | Kubernetes API server | 443/6443 | `executor: KubernetesExecutor` |
| `orchestration` / airflow task pods | `airflow-webserver.orchestration` | 8080 | Airflow 3 Task Execution API |
| `iam` / `keycloak` | `postgres-main-rw.database` | 5432 | Keycloak DB |
| `iam` / `keycloak` | `openldap.iam` | 389 / 636 | LDAP federation |
| `iam` / Keycloak Jobs (×5) | `keycloak.iam` | 8080 | Admin REST reconcile |
| `iam` / `keycloak-*` Jobs | Kubernetes API server | 443 | Secret read/write |
| `iam` / `opa` | — | — | In-memory, static bundle; no outbound |
| `governance` / `openmetadata` | `postgres-main-rw.database` | 5432 | `11-openmetadata.yaml:133` |
| `governance` / `openmetadata` | `opensearch.governance` | 9200 | `11-openmetadata.yaml:152-154` |
| `database` / `shop-seed`, `db-roles-setup` | `postgres-main-rw.database` | 5432 | Same-namespace Jobs |
| `platform-system` / `apisix` | **every routed upstream** (§1.3) | varied | Gateway relay — must never be default-denied on egress without the full route list |
| `platform-system` / `apisix-ingress-controller` | `apisix-admin.platform-system` | 9180 | `apisix-gateway.yaml:498-506` |
| `platform-system` / `apisix` | `apisix-etcd.platform-system` | 2379 | `apisix-infra.yaml:93-101` |
| `platform-system` / `apisix-ingress-controller` | Kubernetes API server | 443 | CRD watch |
| **all namespaces** | `kube-dns.kube-system` | 53/UDP+TCP | Mandatory first exception under default-deny egress |

### Required **outbound** (cluster-external) dependencies

| Destination | Consumer | Evidence |
|---|---|---|
| `repo1.maven.org` | `flink-sql-submit` — downloads 4 connector JARs | `14-flink-jobs.yaml:65-71` (5 references) |
| PyPI | `airflow-webserver`, `superset` (`install-authlib` init), `clickstream-gen` | `07-airflow.yaml:150`, `08-superset.yaml:95`, `13-clickstream-gen.yaml:35` |
| `raw.githubusercontent.com` | chart bootstrap | chart grep |
| Container registries (`quay.io`, `docker.io`, `ghcr.io`) | kubelet image pull — **node-level, not pod-level**; NetworkPolicy does not apply | — |

---

## 5. Regression evidence plan

The repo already has the exact pattern this issue needs. **Reuse, do not invent.**

`tests/08-apisix-admin-restrict.sh` is a working NetworkPolicy regression test with a three-assertion shape:

1. **Policy exists** — `kubectl -n <ns> get networkpolicy <name>` (fails the test if absent).
2. **Denied path is denied** — `kubectl -n default run <probe> --rm -i --restart=Never --image=curlimages/curl:8.21.0 --timeout=20s --command -- curl -sf --max-time 8 ...` from an *unrelated* namespace, asserting **non-zero exit**.
3. **Allowed path still works** — asserts the legitimate client is still `Ready` and a real end-to-end request still returns a non-`000` HTTP code.

`tests/09-seaweedfs-authz-live.sh` refines the probe mechanism and documents a real defect to avoid: `kubectl run --rm -i` leaks a `pod ... deleted` line into captured output under cluster load. It uses **static labelled pod + `kubectl logs` + separate delete** instead. Any new probe must follow the `run_probe()` helper in that file.

**Proposed evidence for the SAFE-NOW increment:**

| # | Assertion | Method |
|---|---|---|
| E1 | `default-deny-all` and `allow-cluster-dns` exist in `storage` | `kubectl -n storage get networkpolicy default-deny-all allow-cluster-dns` |
| E2 | DNS still resolves from inside `storage` | probe pod in `storage`, `nslookup seaweedfs-s3.storage.svc.cluster.local` |
| E3 | Allowed peer still reaches S3 | existing `tests/09` assertion 1/3 must still pass unchanged (trino-labelled probe → 8333) |
| E4 | Unrelated namespace still denied | existing `tests/09` assertion 2 must still pass (`default` ns probe → timeout) |
| E5 | Egress default-deny is actually enforced | probe pod in `storage` attempting `postgres-main-rw.database.svc.cluster.local:5432` → must **fail** (proves the Egress policyType took effect, not just that it was created) |
| E6 | Gateway path unaffected | `curl -s -o /dev/null -w '%{http_code}' https://s3.local.beluga.internal/...` → non-`000` |
| E7 | Full suite green | `bash tests/run-all.sh` |

E5 is the assertion that distinguishes "policy applied" from "policy present but unenforced" — Cilium is the only enforcer here (k3s netpol controller is disabled), so enforcement must be proven, not assumed.

**Two enforcement caveats to verify live before trusting the result:**
- Kubelet liveness/readiness probes originate from the **node**, not a pod. Cilium's `allow-localhost` default is expected to keep them working under namespace default-deny, but this must be confirmed by watching the `seaweedfs` pod stay `Ready` for a full probe cycle after apply — not inferred.
- `kubectl port-forward` **bypasses NetworkPolicy** (goes via kubelet). `apisix-gateway.yaml:520-523` already records this measured defect. Probes must be in-cluster pods, never port-forward.

**Rollback:** delete the two NetworkPolicy resources (`kubectl -n storage delete networkpolicy default-deny-all allow-cluster-dns`) or revert the chart file and let ArgoCD prune. No data-plane state changes, so rollback is instantaneous and lossless.

---

## 6. Project-specific N/A controls and time-bounded exceptions

| OpenForge control | Beluga status | Rationale |
|---|---|---|
| `lsm.selinux.targetMode: enforcing` | **N/A** | Host is Ubuntu 26.04 (`Vagrantfile:25`) → AppArmor-native. OpenForge's own LSM abstraction says AppArmor for AppArmor-native hosts. SELinux is not applicable. |
| `lsm.appArmor.targetMode: runtime-default` | **PRESERVE (no change)** | The issue requires preserving the host-native model. Ubuntu ships AppArmor enabled by default and no script in this repo touches it. Optionally add the K8s-native `securityContext.appArmorProfile: {type: RuntimeDefault}` field per workload — a separate increment, not this one. |
| `serviceIdentity` / `mesh-istio-ambient-strict.yaml` (mTLS `STRICT`) | **N/A for now** | No service mesh is installed. In-cluster TLS is instead handled by cert-manager + the internal CA (`internal-ca-distribution.yaml`), with `tests/10-tls-identity-boundary.sh` and `tests/11-identity-plaintext-preflight.sh` already asserting the boundary. Installing Istio Ambient on a 32GB Vagrant profile is out of scope. |
| `exposure.internalGateway` | **DEFERRED** | Beluga has one MetalLB pool and one APISIX LoadBalancer. Splitting internal/external needs a second pool + Service + per-route classification (10 hosts). Track separately. |
| `egress.fqdnAllowList` | **DEFERRED — needs CRD change** | Standard `networking.k8s.io/v1` NetworkPolicy cannot express FQDN rules. Requires `CiliumNetworkPolicy.toFQDNs`, which changes the policy CRD surface of the whole repo. |
| `egress.fixedSourceIp` | **N/A** | No requirement for a fixed egress source IP in a local Vagrant platform. |
| `nodeNetwork.kubernetesAwareFirewall` (Cilium Host Firewall) | **DEFERRED** | OpenForge ships it as reference only and explicitly ships no firewall mutation ("No universal `ufw enable`, `firewall-cmd`, or nftables mutation is shipped"). Needs inventory + `audit` pass + rollback first. |
| `host.osFirewall` | **DEFERRED** | Same reason. `preserveCniRules: true` is critical here since Cilium runs `kubeProxyReplacement=true` — a naive host firewall would break eBPF service routing. |
| `workload.podSecurityStandard: restricted` (`enforce`) | **EXCEPTION, time-bounded** | Blocked by 3 workloads that #117 classified RISKY: `airflow-webserver` and `clickstream-gen` (boot-time `pip install`), `superset` (`install-authlib` init container mandates `runAsUser: 0`, `08-superset.yaml:95`). Exception should expire when those move to pre-built images. `audit`/`warn` labels can land now. |
| `workload.seccompProfile: RuntimeDefault` | **GAP — not yet covered** | Only `openldap` has it. #117 covered a different control set. Needs its own increment across the 22 hardened workloads. |
| Operator-managed pod specs (CNPG `Cluster`, Strimzi `Kafka`/`KafkaNodePool`, `FlinkDeployment`) | **NOT-OURS** | Same classification as #117: pod specs and labels are owned by upstream operators. NetworkPolicy targeting them must use operator-assigned labels, which must be read off a live cluster, not inferred from the charts. |

---

## 7. Recommendation

Implement **§3.1 only** as increment 1: namespace-wide `default-deny-all` (Ingress + Egress) plus `allow-cluster-dns` in the `storage` namespace, with the same two policies mirrored into the inert `governance` namespace at zero cost, and E1–E7 as regression evidence.

This lands the first true default-deny cell in the platform, establishes the reusable policy pair and the enforcement-proof test (E5), and does it against the single workload in the repo with a pre-verified ingress allow-list and zero outbound dependencies. Everything in §3.2 should be sequenced after E1–E7 pass on a live cluster.
