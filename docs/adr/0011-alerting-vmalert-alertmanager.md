# ADR-0011: vmalert and Alertmanager for storage/CDC alerts

English | [한국어](0011-alerting-vmalert-alertmanager-ko.md)

- Status: Accepted (implementation declared; live verification pending)
- Date: 2026-11-13
- Owner: dasomel, issue #408 (owner decision 2026-11-13)
- Change: approved new components and metrics-read RBAC; no other permission expansion

## Context

The [2026-11-12 incident record](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/README.md)
identifies independent Connect root-disk log growth and retained slot WAL on the data
disk. Test 29 is a point-in-time check, not continuous detection. No node-exporter,
kube-state-metrics or Prometheus Operator is deployed. The owner selected vmalert
and Alertmanager over Grafana-managed evaluation. ADR-0010 is occupied; use 0011.

## Decisions

- **D-ALERT-1 — direct kubelet and bounded discovery.** VM's Kubernetes SD discovers
  nodes and CNPG exporter pods. ClusterRole grants only `list/watch nodes` and
  `get nodes/metrics`; namespace Roles grant only `list/watch pods` in database and
  platform-system. TLS + SA token scrape kubelet `:10250` `/metrics`,
  `/metrics/cadvisor`, `/metrics/resource`. The API-proxy alternative requires
  `nodes/proxy`, which authorizes arbitrary kubelet proxy requests, so is absent.
  Node SD keeps its default node InternalIP:10250 address (no address rewrite).
  Owner-provided colima evidence (2026-11-13): `nodes/metrics get` plus nodes
  list/watch suffices; `nodes/proxy` is unnecessary. The kubelet serving certificate
  is issued by `k3s-server-ca`, verifies with the SA `ca.crt`, and has node-name and
  InternalIP `192.168.5.3` SANs. Keep `tls_config.ca_file` and full verification;
  never set `insecure_skip_verify`. Cost: other environments still need CA/SAN
  and authenticated scrape confirmation. Escape: fix routing/serving certs;
  a proxy fallback requires a separate explicit security review, never skip TLS.
  The new SA has no Secret API access. Pod SD filters CNPG cluster label and 9187;
  no monitor CRDs or exporter additions are needed.
- **D-ALERT-2 — pins.** vmalert v1.155.0 matches VM. Use owner-supplied Alertmanager
  v0.34.2, since v0.35.0 was only four days old at the decision. Both are Apache-2.0
  and owner-supplied multi-arch amd64/arm64 digest pins. Cost: newer fixes delayed;
  escape: reviewed VERSIONS.md/image/license update after regression checks.
- **D-ALERT-3 — null receiver.** Group by alertname/namespace, default receiver
  exactly `name: "null"` without integrations. No notification leaves the cluster.
  Cost: no operator paging and no external Watchdog dead-man signal. Escape:
  owner chooses channel, routing and credentials; change `alertmanager.config`
  and `extraEgress` values, design Secret projection if credentials are needed.
- **D-ALERT-4 — state and Grafana.** vmalert queries VM and uses remote write/read
  to retain alert pending state across restarts (within the upstream lookback).
  Those endpoints do not require VM's admin auth-key: retain all existing file://
  management keys in VM only. VM's `-vmalert.proxyURL` proxies rules/alerts to Grafana;
  `manageAlerts: true` with `prometheusType: Prometheus` permits viewing external
  rules, not Grafana rule storage. Built-in Alertmanager datasource uses Prometheus
  implementation, `handleGrafanaManagedAlerts: false`; no plugin/new public host.
  Cost: VM/evaluator single failure domain. Escape: future reviewed HA topology.
- **D-ALERT-5 — Cilium network boundaries.** The namespaced
  `victoria-metrics-entity-egress` CiliumNetworkPolicy selects only
  `app=victoria-metrics` in platform-system. Its two additive egress rules allow
  `kube-apiserver` TCP 6443/443 and `host, remote-node` TCP 10250. Plain `ipBlock`
  does not select these Cilium identities (security baseline REQ-015).
  Owner-provided colima evidence (2026-11-13, k3s+Cilium tunnel mode,
  `policy-cidr-match-mode` unset): VM pod probes of nodeIP:10250 and
  kubernetes.default.svc timed out under CIDR rules, returned HTTP 401 with the
  temporary entity policy, and timed out again after removal. HTTP 401 proves
  reachability, not successful authenticated collection. Both supported environments
  (Vagrant and Kakao) use Cilium; the CRD exists on the tested colima cluster.
  `observability.ciliumEntityEgress` defaults true. Cost: Cilium CRD dependency;
  escape: non-Cilium clusters may set false, but node metrics are not scraped
  without a separately designed replacement network path. No CIDR values remain.
  Pod-level policies constrain all alerting paths; Alertmanager egress defaults
  to DNS only. `manager-db-ingress` adds only VM TCP 9187 (D-ALERT-15); database
  has no NetworkPolicy in either chart, so postgres-main needs no ingress change.
  Existing DB clients and namespace defaults stay as declared.
- **D-ALERT-6 — truthful storage coverage.** Keep cAdvisor host usage/limit
  with `id="/",device=~"/dev/.+",device!="/dev/shm"`; discard tmpfs/overlay series.
  D-ALERT-16 evaluates capacity >1073741824 bytes (1 GiB) per `node, device`,
  covering root and data disks. The measured Colima cloud-init ISO `/dev/vdc`
  is permanently 100% full: worst-of-all-devices causes a permanent false alert.
  Cost: filesystems <=1 GiB or outside `/dev/` are uncovered; the global absence
  alert (same label selector, no size filter) and test 31 are backstops. Test 31
  requires a selected capacity >1 GiB per node and prints devices. Escape:
  node-exporter with mountpoint labels. Alert names remain stable.
  `NodeRootFilesystemMetricAbsent` warns after 15m; there are 12 rule entries total;
  keep kubelet volume stats and node/pod resource CPU/memory
  for basic dashboard queries. local-path volume available bytes measures the
  backing data filesystem, not a PVC quota. Container fs does not reliably include
  all pod logs/emptyDirs, so omit PodEphemeralStorageHigh. Cost: no per-pod storage
  attribution alert. Escape: add a measured usable metric/denominator first.
- **D-ALERT-7/8 — configuration and persistence.** Rule ConfigMap uses raw file
  content, preserving annotation templates, with rollout checksum. Alertmanager's
  config has its own checksum; a Recreate Deployment uses a 256Mi local-path PVC
  for silences/nflog. Cost: node-local state and brief replacement downtime.
  Escape: reviewed replicated storage/HA; do not silently discard silences via emptyDir.
- **D-ALERT-9 — thresholds.** Root/data free <20% warning for 10m / <12% critical
  for 2m, before approximate 10–15% eviction. Slot WAL >512MiB for 10m warning /
  >900MiB for 2m critical, approaching the 1GiB checkpoint-time cap. Inactive slot
  15m; pg_wal >2GiB 10m; archive ready >20 15m; scrape down 10m; Watchdog 1m.
  Cost: heuristic lead time cannot guarantee intervention before a rapid fill;
  tune from measured growth/evaluation latency. Every rule includes severity,
  duration, summary, description and [runbook](../runbooks/cdc-slot-wal-retention.md).
- **D-ALERT-10/11/12 — evidence.** Existing PyYAML plus stdlib checker validates
  rendered rules, exact metric allowlist, auth/TLS, RBAC, pins and null receiver;
  15 rule/auth/wiring fixtures plus 25 network fixtures fail closed; the network check
  covers both charts and both ends of each new pod path (D-ALERT-14). This is not a PromQL evaluator. Test 31 uses
  isolated kubeconfig and ephemeral port-forwards, and only reads APIs/status.
  Cost: no offline engine/notification proof; escape: live test plus future engine tests.

- **D-ALERT-13 — endpoint inventory.** The exact runbook annotation is human
  navigation metadata, not pod egress. Exclude only that file-path/URL pattern.
  Cost: a bounded extractor exception; escape: structural endpoint extraction.
  Regression reproduces the original failure and still catches actual URLs in
  the same file or similarly named keys in executable sources. No baseline growth.

## Verification and remaining decisions

Offline: `python3 scripts/ci/check-alerting-pipeline.py`, individual CI gates and
Helm default/SSO/full/Kakao renders, plus non-Cilium opt-out. This worker accessed
no live cluster; the colima observations above are supplied by the orchestrator.
To confirm live: test 31 after deployment and >1m warmup; confirm chart-managed
Cilium rules, authenticated kubelet TLS scrapes on all nodes and both CNPG clusters; verify Grafana SSO rule
and Alertmanager views. Under separately authorized restart testing, observe
pending-state restoration and persistence of silences/nflog. Notification channel,
receiver credentials, owner response targets, HA and per-pod storage remain open.

Rollback: revert chart/values/rules and corresponding inventory together via GitOps.
Removing PVC declaration does not authorize deleting stored silences. No hooks added.

## Upstream references read for this decision

- [Kubelet authentication/authorization](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-authn-authz/): metrics vs proxy subresources.
- [VM Kubernetes SD](https://docs.victoriametrics.com/victoriametrics/sd_configs/#kubernetes_sd_configs): single-node supports node/pod roles and node address/port discovery.
- [vmalert](https://docs.victoriametrics.com/victoriametrics/vmalert/): remote read/write and rules/alerts APIs.
- [VM vmalert proxy](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#vmalert): Grafana rule proxy.
- [Grafana Prometheus config](https://grafana.com/docs/grafana/latest/datasources/prometheus/configure/): manageAlerts/Prometheus view-only rules.
- [Grafana Alertmanager config](https://grafana.com/docs/grafana/latest/datasources/alertmanager/): built-in datasource and silences.
- [CNPG default monitoring](https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/config/manager/default-monitoring.yaml): slot_name label. Metric existence is the owner's 2026-11-13 live evidence, not inferred from upstream defaults.
