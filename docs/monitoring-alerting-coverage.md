# Service-Level Monitoring, Alerting and Incident Response Coverage (Proposal)

> **2026-11-12 CDC disk detection:** `tests/29-cdc-slot-wal-retention.sh` reads retained slot WAL (<1GiB), `/kafka/logs` allocated usage on every Connect pod (<=200MiB), and kubelet nodefs/imagefs free space (>=20%). Connect's unbounded hourly logs independently filled nodefs while WAL filled imagefs. GitOps now declares console logging, ERROR reconnect loggers, bounded log/tmp emptyDirs and an ephemeral-storage limit; runtime log rotation and eviction behavior remain unverified by this change. The current VM scrape list has no CNPG 9187 or node exporter target, no custom-query ConfigMap, alert evaluator or provisioned-dashboard convention. Default CNPG `cnpg_pg_replication_slots_*` metrics do not establish VM collection/alerting. This is a point-in-time check; scheduling and automatic notification remain a gap. [Recovery runbook](runbooks/cdc-slot-wal-retention.md).

English | [한국어](monitoring-alerting-coverage-ko.md)

> **Update 2026-11-09 (issue #366):** the findings below describe the 2026-10-07 state. The Prometheus Stack claim was replaced by VictoriaMetrics single-node + Grafana (`gitops/charts/beluga-platform/templates/observability.yaml`, VERSIONS.md rows), the `grafana-external` NodePort shim was removed, and Grafana is served at `grafana.<baseDomain>` through APISIX with Keycloak SSO. Alerting rules, Alertmanager and logs (Loki) remain out of scope; logs stay on Kubernetes Events.

Refs [Issue #14](https://github.com/dasomel/beluga/issues/14) ("Define service-level monitoring, alerting, and incident response coverage").

> **Status: PROPOSAL. Documentation only.** No rule, exporter, dashboard, script or manifest is changed. Repository statements
> carry a `file:line` read at the commit this document was written against. Live statements come from read-only `kubectl`
> commands run on 2026-10-07 (~14:07 UTC) and are labelled **L#**; unmeasured items are **not verified live**. External
> statements cite an official page `[S#]` (accessed 2026-10-07) or say **no official recommendation**. Severity, response
> targets and ownership are **Owner decisions**: they are offered as options with a basis, never as facts.

---

## 1. Purpose and issue mapping

| Issue #14 acceptance criterion | Where addressed |
|---|---|
| Critical services have actionable alerts | Sections 3 (gap) and 4.2 (catalog) |
| Severity and response targets documented | Section 4.3 (options) |
| Runbooks exist and are linked from alerts | Section 4.5 |
| One controlled fault per major layer demonstrates detection | Section 5 |
| Operational health reporting generated repeatably | Section 4.6 |

---

## 2. Current state (verified)

### 2.1 Repository

| Fact | Evidence |
|---|---|
| "Prometheus Stack 67.4.0 (`prometheus-community/kube-prometheus-stack`)" is listed as a component and in the README architecture table | [`VERSIONS.md:20`](../VERSIONS.md#L20), [`README.md:66`](../README.md#L66) |
| The only repository artifacts for it are a values block (`prometheusGrafana.enabled: true`, ports) and a NodePort `Service` `grafana-external` selecting `app.kubernetes.io/name=grafana`. A repo-wide search for `kube-prometheus`, `alertmanager`, `PrometheusRule`/`ServiceMonitor` finds only the `VERSIONS.md` row; no template, bootstrap step or ArgoCD Application installs the stack | [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22), [`platform-services.yaml:8-21`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L21) |
| Kafka has no `metricsConfig`, and no pod carries `prometheus.io/scrape` annotations (search over `gitops/`: no match) | [`03-strimzi-kafka.yaml:34-108`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L34-L108) |
| Keycloak registers a `grafana` OIDC client (the login side exists, the service does not) | [`keycloak.yaml:211`](../gitops/charts/beluga-platform/templates/keycloak.yaml#L211) |
| `make test` / `tests/01-cluster-health.sh` check node count and pod phases once; they are state checks, not monitoring (`tests/01` lines 13-37) | [`01-cluster-health.sh:13-37`](../tests/01-cluster-health.sh#L13-L37), [`run-all.sh:12-29`](../tests/run-all.sh#L12-L29) |
| Existing report-style tooling that can be a pattern: `make drift-live --out` JSON, `scripts/generate_sizing_report.py`, `scripts/generate_release_qa_report.py` | [`Makefile:147-155`](../Makefile#L147-L155) |
| The mistakes log shows silent failures that monitoring should have surfaced: stuck hook Jobs, a 10-day Keycloak CrashLoop, a stalled import Job for 8 days, `selfHeal` silently reverting a fix | [`mistakes-log.md:49`](mistakes-log.md#L49), [`:63`](mistakes-log.md#L63), [`:86`](mistakes-log.md#L86), and the 2026-09-08 entry |

### 2.2 Live measurements (read-only, 2026-10-07)

| # | Command | Result |
|---|---|---|
| L1 | `kubectl get prometheusrules,servicemonitors,podmonitors,alertmanagers,prometheuses -A` | `error: the server doesn't have a resource type "prometheusrules"` (the Prometheus Operator CRDs are not installed) |
| L2 | `kubectl get pods -A \| grep -E "prometheus\|alertmanager\|grafana\|kube-state\|node-exporter"` and `kubectl get svc -A \| grep -i -E "prom\|graf\|alert"` | no pod; one Service `platform-system/grafana-external` (NodePort 30000) whose Endpoints are `<none>` |
| L3 | `kubectl get apiservices \| grep metrics` | `metrics.k8s.io` served by `kube-system/metrics-server` (resource metrics only; no alert evaluation) |
| L4 | `kubectl -n argocd get cm argocd-notifications-cm` | exists with `DATA 0` (no triggers/services configured); the notifications controller pod runs |
| L5 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; cluster `status.conditions` | two backups (started 2026-10-05T02:00:00Z; second created 2026-10-07T02:09:09Z) hung for about 2 days and about 7h50m and were marked `failed` only at the instance-manager restarts ("instance manager was restarted during backup"); no `lastSuccessfulBackup`; `ContinuousArchiving=False` since 2026-10-04T07:19:43Z (`AccessDenied ... CreateBucket`, see [HA/DR objectives](ha-dr-objectives.md) 2.2). Nothing alerted on it (no alerting stack, L1): a rule must cover both "backup running longer than N hours" and "ContinuousArchiving false" |
| L6 | `kubectl -n streaming get kafka beluga-kafka` conditions | `Ready=True` plus a `Warning` `KafkaMinInsyncReplicas` ("min.insync.replicas ... defaults to 1 which does not guarantee reliability") |
| L7 | `kubectl get certificates -A` | 4 Certificates `Ready=True`; renewal times 2026-12-03 (3 leaf certs) and 2027-06-04 (internal CA) |
| L8 | `kubectl get pods -A` restart counts (cumulative, 3d6h cluster age) | highest: `metallb-frr-k8s` 258, `metallb-speaker` 251, `cert-manager-cainjector` 242, `clickstream-gen` 217, `openldap` 205, `apisix-ingress-controller` 186, `seaweedfs-0` 165, `cnpg-controller-manager` 156; cause not investigated. No non-Running pods; no Warning events at measurement time |
| L9 | `kubectl get --raw .../flink-cluster-rest:8081/proxy/jobs/overview` | 3 jobs `RUNNING`; started 10:19 UTC (not the cluster creation time), i.e. restarted at least once without anything signalling it |

---

## 3. Gaps against the acceptance criteria

| Criterion | Status | Gap |
|---|---|---|
| Critical services have actionable alerts | **Open (zero alerts possible today)** | No metrics stack runs (L1, L2); the Prometheus Stack in `VERSIONS.md` and README is not deployed from this repository. Metric sources (Kafka, Flink, Trino, SeaweedFS) are not exposed either (2.1) |
| Severity and response targets | **Open** | Not defined |
| Runbooks linked from alerts | **Open** | No runbook directory exists |
| Controlled fault per layer | **Open** | Nothing to detect with (L1) |
| Repeatable health report | **Partial** | A point-in-time report pattern exists (2.1) but nothing covers service health or trends |

A correction is needed before anything else: the documentation (README, `VERSIONS.md`) says a Prometheus Stack is present, while the repository and the live cluster do not contain one. This proposal treats "install and wire the stack" as the first task (section 7, T1).

---

## 4. Proposal (all **Proposed**)

### 4.1 Principles

Alert on symptoms that matter to users, keep alerts few, tolerate short blips, make every alert actionable and link it to a console and a runbook [S1]. Alertmanager only routes and groups notifications; rule evaluation is Prometheus' job [S2].

### 4.2 Alert catalog (starting set, per layer)

Metric names are quoted only where an official page was read; other rows say "confirm during implementation".

| Layer | Signal (condition to alert on) | Metric / source | Severity (option) |
|---|---|---|---|
| GitOps | Application not `Synced` or not `Healthy` for N minutes | `argocd_app_info{sync_status,health_status,name}` [S3] | warning, then critical on `Degraded` |
| GitOps drift | unauthorized drift reported | `make drift-live` JSON (see [GitOps drift control](gitops-drift-control.md)) | warning |
| PostgreSQL | instance down; replication lag; **no recent successful backup / no recoverability point** | `cnpg_collector_up`, `cnpg_pg_replication_lag`, `cnpg_collector_last_failed_backup_timestamp`, `cnpg_collector_last_available_backup_timestamp` (port 9187, PodMonitor created manually) [S4] | critical (down, backup stale) |
| Kafka | broker/controller down, under-replicated partitions, consumer lag (CDC) | needs `metricsConfig` (JMX exporter or Strimzi Metrics Reporter) and Strimzi's example rules [S5]; metric names: confirm | critical / warning |
| Kafka Connect (Debezium) | connector or task `FAILED` | Strimzi `KafkaConnector` status; metric names: confirm | critical |
| Flink | job not `RUNNING`; checkpoint failures | Prometheus reporter, port 9249 by default [S6]; enabling needs `flinkConfiguration` keys; metric names: confirm. REST `jobs/overview` (L9) is a stopgap probe | critical |
| Trino | coordinator unavailable; queued/failed query ratio (saturation) | Trino JMX/metrics: **not verified**, confirm | warning |
| Object storage | volume capacity (PVCs are 5Gi), S3 endpoint availability | kubelet volume stats via kube-prometheus-stack (confirm), blackbox probe | critical at high fill |
| Identity | Keycloak/OpenLDAP down, login probe failing | blackbox/synthetic probe (reuse tests 06/07/10 logic) | critical |
| Certificates | expiry inside the renewal window | cert-manager serves metrics on port 9402 [S7]; exact metric names were not on the page read: confirm | warning |
| Platform | pod restart rate, node memory/disk pressure, PDB at 0 allowed disruptions | kube-state-metrics / node-exporter of the stack (confirm) | warning |

### 4.3 Severity and response targets (options, **Owner decision**)

Offer three classes. **No official recommendation** exists for numeric targets; the owner picks them.

| Class | Meaning | Option for response target | Notification |
|---|---|---|---|
| P1 critical | data loss risk or full outage of a layer (CNPG down, backups stale, Kafka below ISR, Flink jobs stopped) | acknowledge within hours of business hours vs 24x7: **Owner decision** | page |
| P2 warning | degraded or at risk, no immediate loss | next business day | ticket/chat |
| P3 info | trend/hygiene (cert renewal window, restarts) | weekly review | report only |

### 4.4 Ownership and escalation

The repository names no on-call owner. Proposed: a table in the runbook index with role (platform operator, data engineer, identity owner), primary/backup contact fields and an escalation step to the repository owner. Concrete names are an **Owner decision**.

### 4.5 Runbooks

Directory `docs/runbooks/` (+ `-ko`), one page per issue-listed failure, each with: symptom and alert, first three read-only checks, safe mitigations, escalate-when, post-incident log entry (in `mistakes-log.md`). Pages: Kafka lag; connector failure; Flink job failure (include the hook-resubmit path and the JobManager-restart job loss, see [upgrade procedures](upgrade-rollback-procedures.md) G1/G2); Trino saturation; CNPG failure and failed backups; object-storage capacity; Keycloak/LDAP failure; ArgoCD drift. Alert annotations carry the `runbook_url`.

### 4.6 Periodic health report

A read-only script `scripts/ops/health-report.py` writing deterministic JSON plus a short Markdown summary: node and pod health, Application sync/health, CNPG backup freshness, Flink job states, certificate expiry, restart outliers (the measurements L5-L9 are the first set). It reuses the `drift-live --out` pattern. Cadence and retention are an **Owner decision**.

### 4.7 Development-profile noise

Two rule sets selected by profile (see [environment profiles](environment-profiles.md)): production-style enables all P1/P2; the development profile keeps P1 only and routes P2/P3 to the report. Single-replica workloads and PDBs with 0 allowed disruptions are expected there and must not page.

---

## 5. Verification and test ideas (controlled faults, lab only)

| Layer | Fault | Expected detection |
|---|---|---|
| GitOps | scale a Deployment by hand with `selfHeal` temporarily paused (owner-run) | drift report finding or `OutOfSync` alert |
| PostgreSQL | block WAL archiving (e.g. a wrong bucket in a scratch cluster, reproduces the L5 condition) | archiving-failing and backup-stale alerts within one scrape plus the rule window |
| Kafka | stop one broker | under-replicated / broker-down alert (note: with RF=1 the loss is data unavailability, not only a warning) |
| Flink | delete the JobManager pod (reproduces the job loss) | job-not-running alert |
| Identity | scale Keycloak to 0 | login probe alert |
| Certificates | issue a short-lived test certificate | expiry-window alert |

Run each against a rehearsal cluster only; none was run in this lane.

---

## 6. Owner decisions remaining

| # | Decision | Recommendation (basis) |
|---|---|---|
| D1 | Install the Prometheus Stack from the repo, or remove the claim from README/`VERSIONS.md` | Install (the claim exists, ports/OIDC client are already prepared) |
| D2 | Operating hours (24x7 or agreed hours) and response targets | Agreed hours for the learning profile; revisit with an HA profile |
| D3 | Notification channel (chat/email) | Needs owner input; ArgoCD notifications are empty (L4) |
| D4 | Who owns each class and escalation | Fill the ownership table in 4.4 |
| D5 | Report cadence and retention | Weekly report, keep as release artifacts |
| D6 | Fault-test cadence | At each release rehearsal |

---

## 7. Follow-up implementation tasks (ordered, small)

| # | Task | Acceptance test idea |
|---|---|---|
| T1 | Deploy the metrics stack (ArgoCD Application) and Alertmanager with a null receiver | `kubectl get prometheusrules` works; targets up |
| T2 | Expose Kafka, Flink and CNPG metrics (PodMonitors) | targets listed for each |
| T3 | Rules: CNPG backup stale, ArgoCD not synced, certificates, pod restarts | rules load; a forced fault fires |
| T4 | `docs/runbooks/` skeleton and annotation links | CI check that each rule has a runbook URL |
| T5 | `scripts/ops/health-report.py` | repeatable output on two runs |
| T6 | Controlled fault drills (section 5) | one evidence file per layer |

---

## 2026-11-12 update: emptyDir and ephemeral storage bounds (#403)

Disk emptyDir bounds and container ephemeral-storage requests/limits (including init)
are declared for every standard workload and Job rendered by the two charts. The render
gate enforces positive disk sizeLimit and request ≤ limit across default, full, SSO and
full+SSO, retaining the Connect mount contract. **No Memory emptyDirs are rendered in
this scope**; they are exempt from this disk check. CNPG shm belongs to the separate
operator scope. See the [budget inventory](ephemeral-storage-bounds.md) for all workloads,
limits, consequences, follow-up fields and explicit live confirmation items.

Airflow's supplied 2,009,600KiB home total includes installed packages; the chart explicitly
sets task/DAG-processor log paths and runs its 3.3.0 Docker `/clean-logs` helper with
three-day retention every 15 minutes on both log locations. Bursts/open files can still
evict its single LocalExecutor pod and interrupt tasks. Source inspection and static
render/syntax checks do not prove runtime cleanup, eviction or recovery. **There is still
no automatic storage alert collection/evaluation/notification pipeline.**

### Supplied live evidence (colima, 2026-11-12)

Copied verbatim from the task's `emptydir-usage.txt`, then that scratch file was removed.
These are supplied observations, not live queries from this worker; units are KiB and
missing pods/volumes are not zero. The incident Connect log high-water mark was 10.9GB;
this later snapshot shows the post-mitigation volume sizes.

```text
# live emptyDir usage on colima, captured 2026-11-12 (KiB namespace pod volume)
2009600 orchestration airflow-webserver-665b66499b-8p5jp airflow-home
231080 argocd argocd-repo-server-fb87d8994-5tjp7 var-files
231080 argocd argocd-dex-server-6fb56f4676-lrw77 static-files
78692 analytics superset-7fcddf4b99-ltx8p tmp
64668 metallb-system metallb-frr-k8s-gfs7k metrics
58120 database postgres-main-1 scratch-data
58116 platform-system manager-db-1 scratch-data
56540 metallb-system metallb-frr-k8s-gfs7k frr-status
54280 analytics superset-7fcddf4b99-ltx8p pylibs
40052 storage seaweedfs-0 tmp
21012 argocd argocd-repo-server-fb87d8994-5tjp7 tmp
12984 argocd argocd-application-controller-0 argocd-application-controller-tmp
12036 database postgres-main-1 shm
3304 iam keycloak-6fcc796c58-65252 quarkus-build
3092 analytics trino-coordinator-f988dbb8d-4tvmh tmp
2432 streaming clickstream-gen-645bc7897d-rsgqj pylibs
1464 analytics trino-coordinator-f988dbb8d-4tvmh data-volume
1056 platform-system manager-db-1 shm
656 kube-system cilium-5tfh2 tmp
652 analytics superset-7fcddf4b99-ltx8p superset-home
532 orchestration airflow-webserver-665b66499b-8p5jp airflow-state
228 analytics superset-7fcddf4b99-ltx8p ca-bundle
220 orchestration airflow-webserver-665b66499b-8p5jp ca-bundle
216 iam keycloak-6fcc796c58-65252 keycloak-data
140 metallb-system metallb-frr-k8s-gfs7k frr-tmp
60 platform-system apisix-5456d9d645-98x7v conf-rw
52 iam keycloak-6fcc796c58-65252 tmp
36 argocd argocd-repo-server-fb87d8994-5tjp7 gpg-keyring
28 metallb-system metallb-frr-k8s-gfs7k reloader
28 metallb-system metallb-frr-k8s-gfs7k frr-sockets
24 platform-system manager-web-8d9f84d6d-4f6xx nginx-cache
20 metallb-system metallb-frr-k8s-gfs7k frr-conf
16 metallb-system metallb-frr-k8s-gfs7k frr-lib
12 kube-system metrics-server-6dc596dfb8-tdkfv tmp-dir
12 iam openldap-5f4c775fb7-92vld ldap-run
12 argocd argocd-dex-server-6fb56f4676-lrw77 dexconfig
8 storage seaweedfs-0 identities
8 platform-system manager-web-8d9f84d6d-4f6xx nginx-run
8 platform-system manager-web-8d9f84d6d-4f6xx nginx-conf
8 platform-system apisix-ingress-controller-77484f479c-nlvwm conf-rw
8 platform-system apisix-5456d9d645-98x7v tmp
8 platform-system apisix-5456d9d645-98x7v apisix-logs
8 argocd argocd-server-5b9cfd9b9c-9sgmr plugins-home
8 argocd argocd-application-controller-0 argocd-home
8 analytics trino-coordinator-f988dbb8d-4tvmh truststore-volume
4 streaming flink-kubernetes-operator-6c97f5d8c5-pgt8s flink-artifacts-volume
4 streaming flink-cluster-774ccc5dfc-wj5mv user-artifacts-volume
4 streaming debezium-connect-9665f6dbf-z7lsv tmp
4 streaming debezium-connect-9665f6dbf-z7lsv kafka-logs
4 streaming clickstream-gen-645bc7897d-rsgqj tmp
4 platform-system manager-domain-api-797dc7785-7v6zm tmp
4 platform-system grafana-7488797b78-nw455 tmp
4 platform-system apisix-5456d9d645-98x7v uwsgi-temp
4 platform-system apisix-5456d9d645-98x7v scgi-temp
4 platform-system apisix-5456d9d645-98x7v proxy-temp
4 platform-system apisix-5456d9d645-98x7v fastcgi-temp
4 platform-system apisix-5456d9d645-98x7v client-body-temp
4 orchestration airflow-webserver-665b66499b-8p5jp tmp
4 iam openldap-5f4c775fb7-92vld tmp
4 cnpg-system cnpg-controller-manager-9f5cd66db-5w2xt scratch-data
4 argocd argocd-server-5b9cfd9b9c-9sgmr tmp
4 argocd argocd-repo-server-fb87d8994-5tjp7 plugins
4 argocd argocd-repo-server-fb87d8994-5tjp7 helm-working-dir
4 argocd argocd-applicationset-controller-5b768d786f-p94ms tmp
4 argocd argocd-applicationset-controller-5b768d786f-p94ms gpg-keyring
```

---

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Prometheus, Alerting practices: https://prometheus.io/docs/practices/alerting/ |
| S2 | Alertmanager configuration: https://prometheus.io/docs/alerting/latest/configuration/ |
| S3 | ArgoCD metrics: https://argo-cd.readthedocs.io/en/stable/operator-manual/metrics/ |
| S4 | CloudNativePG 1.30 monitoring: https://cloudnative-pg.io/docs/1.30/monitoring |
| S5 | Strimzi deploying guide, metrics: https://strimzi.io/docs/operators/latest/deploying#assembly-metrics-config-files-str |
| S6 | Flink 1.20 metric reporters: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/metric_reporters/ |
| S7 | cert-manager Prometheus metrics: https://cert-manager.io/docs/devops-tips/prometheus-metrics/ |
