# Colima single-node lab

English | [한국어](colima-single-node-ko.md)

## Scope and evidence

The Beluga 0.2.0 release candidate is tested on a single-node Colima k3s lab.
Record the exact candidate SHA and suite results in the release QA report; this guide
does not establish release readiness.
The four-node Vagrant topology remains the reference; its re-validation is deferred.
This is an existing-lab run/test guide, not an automated Colima installer or evidence of
multi-node resilience. `make up`, `make down` and `scripts/kubeconfig.sh` use Vagrant.

Operator notes dated 2026-10-31 describe profile `beluga`: vz, 10 CPUs, 24 GiB RAM,
50 GiB disk, containerd, with Colima's built-in Kubernetes disabled and Beluga k3s
installed separately. Scripts ran in `/opt/beluga` from a git archive. These are
operator-observed, VM-local, not managed by this repo. They are observations, not
minimum resource requirements.

**Measured / VM-local (2026-11-16):** The lab runs HWE `linux-virtual-hwe-24.04`, kernel `7.0.0-43-generic`, for clock-jump mitigation; 6.8.0-117 remains a fallback. The VM image/kernel is VM-local, not managed by this repository or a platform pin in `VERSIONS.md`. The v7.0 negative-motion guard is verified upstream (raw/18, raw/18a); the running version is measured (raw/25,27). Binary internals and recurrence prevention were not verified. See the [incident record](../research/incidents/2026-11-16-vm-clock-jump/README.md).

## API access from macOS

The repo-local `.kube/config` produced by [scripts/kubeconfig.sh](../scripts/kubeconfig.sh)
uses `vagrant ssh master-1` and the Vagrant API address; it does not target Colima.
Obtain the admin kubeconfig from the Colima VM's `/etc/rancher/k3s/k3s.yaml`, keep it
private, and rewrite only its server endpoint to the host tunnel below. Preserve its
CA and client credentials. Never merge into or change shared `~/.kube/config`.

The 2026-11-06 operator notes record a conflict on host port 6443 with another Lima
instance. Their working tunnel was:

```bash
ssh -F ~/.colima/_lima/colima-beluga/ssh.config -f -N -L 16443:127.0.0.1:6443 lima-colima-beluga
```

Set the copied kubeconfig's server to `https://127.0.0.1:16443`. The SSH profile,
port conflict and tunnel are operator-observed, VM-local, not managed by this repo;
confirm them for the actual profile. With the prepared file at
`/tmp/beluga-colima-kubeconfig.yaml`, create the isolated task copy required by
[AGENTS.md](../AGENTS.md), then use it for every kubectl/Helm command:

```bash
umask 077
kubectl --kubeconfig /tmp/beluga-colima-kubeconfig.yaml config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
kubectl get nodes -o wide
```

## Gateway access from macOS

Operator-observed on 2026-11-05: the MetalLB VIP `192.168.77.200` had no route from
macOS through vz. Lima forwarded host ports 443/80 to the VM; root `socat` relays
inside the VM forwarded those ports to the VIP. Host domain records were changed
to `127.0.0.1`. All ten tested hosts then passed TLS verification (verify result 0),
and HTTP returned 301. Relays must be restored after VM restart. These relays and
host DNS changes are operator-observed, VM-local, not managed by this repo.

Resolve the service names in the [domain registry](../AGENTS.md)
to loopback for this path, and ensure the VM relays exist before testing. The notes
used ClusterDeck's `~/.clusterdeck/dns/zones.json` (DNS at `127.0.0.1:15353`), which
ClusterDeck may regenerate; that file is not a repository configuration source.
Use HTTPS 443 and trust the cluster's `beluga-internal-ca`; HTTP 80 redirects to HTTPS.
See the [access guide](access-guide-en.md) for service names and authentication, but
do not apply its Vagrant host routing assumptions to Colima.

## Run the live suite

Run from the repository root with the isolated kubeconfig and working gateway/DNS/TLS.
The 0.2.0 test changes in [PR #413](https://github.com/dasomel/beluga/pull/413)
are required: `tests/01` accepts `EXPECTED_NODES` (default 4). On Colima:

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml EXPECTED_NODES=1 make test
```

This invokes [tests/run-all.sh](../tests/run-all.sh); it is a live suite, including
checks that create temporary workloads or exercise application writes. Retain the
commit, environment, exit code and individual skips as release evidence.

- `tests/28` skips without `MAINT_RUN_ID`; provide a successful, explicitly authorized
  `iceberg_table_maintenance` run. This test observes it and does not trigger maintenance.
- `tests/30` needs `MANAGER_LAKEKEEPER_LIVE=1` after reader deployment.
- `tests/25` skips GitHub PR creation/replay/cancellation when `manager-github-app` is absent.
  Record this scope gap even when the suite exits 0.
- `tests/27` skips when `DBT_RUN_ID` is unset. Follow [dbt/README.md](../dbt/README.md)
  to authorize, unpause and manually trigger `dbt_shop_medallion`, then pass that run ID
  in the suite environment. The test observes the supplied run; it does not trigger it.
- Owner-measured on 2026-11-14: `tests/31` fails within about one minute of monitoring
  pod startup, before scrapes and Watchdog are ready. Wait for readiness before running;
  the script explicitly requires Watchdog firing and received by Alertmanager.
- Owner-measured on 2026-11-14: macOS system curl still trusts `beluga-internal-ca`
  through the login keychain even when trying to isolate its trust roots. PR #413 makes
  `tests/10` step 3 use OpenSSL with a public-root bundle for the negative TLS check.
- PR #413 also makes `tests/03` fail rather than skip when Flink is declared but down.
  These PR changes are part of 0.2.0; a checkout predating #413 does not have them.
- Cilium's default two operator replicas compete for a hostPort on one node. On
  2026-11-14, the owner authorized changing this Colima lab to one operator replica.
  Helm upgrade revision 2 kept chart 1.20.0 and existing values, setting only
  `operator.replicas=1`; `tests/01` then passed with all pods Running or Completed.
  This is a lab-specific Helm override, not a Vagrant default or GitOps chart change.
  Back up `helm get values cilium -n kube-system` before changing it. With the isolated
  kubeconfig, the command used was:

  ```bash
  helm upgrade cilium cilium/cilium --namespace kube-system --version 1.20.0 --reuse-values --set operator.replicas=1 --wait --timeout 180s
  ```

  Keep the version aligned with VERSIONS.md. A Pending pod still fails `tests/01`;
  `EXPECTED_NODES=1` does not waive pod health.

## Known gotchas and Vagrant differences

The following historical VM workarounds are operator-observed, VM-local, not managed
by this repo. Check current VM state before repeating them.

| Observation | Repository cross-check / operational consequence |
|-------------|--------------------------------------------------|
| 2026-10-31: node IP `192.168.5.3`, `ROLE=master` in `/etc/beluga/node.env`; overrides `MASTER_IP=192.168.5.3`, `BELUGA_PROFILE=32`, `METALLB_INTERFACE=eth0`, `UPSTREAM_DNS=192.168.5.2` | `scripts/common/env.sh` reads `/etc/beluga/cluster.override.env`; `03-cni-metallb.sh` accepts the interface and `10-dnsmasq.sh` accepts upstream DNS. The actual values and node file are operator observations. |
| 2026-10-31: `/opt/cni/bin` owned by uid 1001 caused Cilium mount-cgroup EPERM | Operator corrected ownership to root; no Colima ownership repair is provided here. |
| 2026-10-31: pre-existing dnsmasq needed a restart; dig/nslookup were absent | Current `10-dnsmasq.sh` stops then starts dnsmasq; the note that it only starts is stale. The operator restarted it and installed dnsutils at the time. |
| 2026-11-06: k3s started before the data disk mounted at `/var/lib/rancher`, exposing stale root-disk state | Operator added `/etc/systemd/system/k3s.service.d/10-wait-data-disk.conf` with an ExecStartPre mountpoint wait and restarted k3s. This was not data loss. |
| 2026-11-06: DHCP changed `.3` to `.1`, breaking Cilium's API path | Operator added `192.168.5.3/24` as a secondary address in `/etc/netplan/60-beluga-node-ip.yaml`, then restarted k3s and Cilium pods. |
| 2026-11-06: rolling restart of cilium-operator left replacement pods Pending | Operator used `rollout undo`; avoid blindly restarting it on a single node. |
| 2026-11-01: agent certificates no longer matched the k3s CA after a stop | Operator rebuilt k3s; this is historical incident evidence, not a prescribed rebuild procedure. |
| 2026-11-16: measured guest clock in 2122, RTC/host in 2026, uptime ~24,855 days; broker writes ~3.4 MB/s, stdout only ~0.15 MB/s (orchestrator measurements); remaining write destination unmeasured | [Incident and raw evidence](../research/incidents/2026-11-16-vm-clock-jump/README.md); upstream [Lima #5665](https://github.com/lima-vm/lima/issues/5665) verified in raw/18 with raw/18a. Counter-wrap attribution is inferred, trigger unknown. Stop/start restored time. [VM-local guard](../scripts/colima/README.md) may reboot unattended; real-counter-jump reboot recovery is unproven. |
| 2026-11-16 recovery: orchestrator measured a bare second IP line in Colima's `/etc/dnsmasq.d/01-colima.conf` on a two-address VM | dnsmasq startup failed. VM-local [ExecStartPre strip and original checkconfig](../scripts/colima/README.md) restored it. Raw/11 preserves failed/active status, not the malformed file. GitOps does not apply the workaround. |
| 2026-11-15: orchestrator measured `CreateContainerError` / `failed to reserve container name` after an unclean stop; k3s restart did not help | Delete the affected controller-managed pods to recreate them; the subsequent recovery deleted 11 ([raw/16](../research/incidents/2026-11-16-vm-clock-jump/raw/16-stuck-pods-deleted.txt)). Raw/16 preserves the deletion list, not the earlier failed k3s restart. Use the isolated kubeconfig and inspect affected pods before deletion. |

Vagrant supplies one master and three workers with reference addresses and lifecycle
scripts. Colima places all workloads on one node, uses a tunnel for the host API path
and VM relays for the gateway, and needs the VM-specific setup above. A successful
single-node run does not establish node-failure tolerance.

## After an unclean shutdown

Owner-measured incident: after hard host power loss on 2026-11-13, Flink JobManager
crash-looped on an unreadable HA checkpoint handle. SeaweedFS `fs.verify /buckets`
reported 4 affected files out of 24,577, all Flink checkpoint files. This is incident
scope, not proof that other data is intact. Recovery and remaining gaps are tracked in
[issue #412](https://github.com/dasomel/beluga/issues/412) (owner-supplied incident facts;
not independently re-run here).

For that failure, the operator recovery was:

1. Back up the three `flink-cluster-<jobid>-config-map` ConfigMaps in `streaming`.
2. Remove the `checkpointID-…` key pointing to the unreadable object from each affected
   ConfigMap, preserving other entries.
3. Delete the JobManager pod so it is recreated.

This is a state-discarding recovery: jobs restart without checkpoint state, using Kafka
group offsets. It is not transparent HA recovery. Obtain authorization for the cluster
mutation and retain the backups; do not remove arbitrary checkpoint keys. Flink HA does
not recover automatically from this unreadable-handle case. See the
[Flink HA broken checkpoint runbook](runbooks/flink-ha-broken-checkpoint.md) for full
diagnosis (`weed shell` `fs.verify`), recovery, verification, and the declared
`FlinkNoRunningJobs` / `FlinkJobManagerRestarting` vmalert rules ([ADR-0011](adr/0011-alerting-vmalert-alertmanager.md) `D-ALERT-21`, #412).

## Start timeout: root fsck / emergency shell

**Measured:** `colima start` launched about 00:42 and 00:52 KST; each waited ~10 minutes (599 s), then exited 1 around 00:52 and 01:02 (exact exits not captured). [Raw/20](../research/incidents/2026-11-16-vm-clock-jump/raw/20-failed-boot-journal.txt) records root fsck failure and systemd starting the emergency shell for the 00:42 boot, with no sshd lines. Port 22 refused SSH throughout the wait ([raw/24](../research/incidents/2026-11-16-vm-clock-jump/raw/24-hung-boot-network-probe.txt), probe labelled 01:03). **Inferred:** the emergency shell explains SSH unreachability; the uncaptured 00:52 boot and identical November 13 05:06/05:22 symptoms share that cause. Raw/02 has EXT4 error reminders about 5.5 minutes after both November 13 boots, but no fsck/emergency-shell journals. Refusal alone is not proof; read the failed boot journal from disk before retrying or waiting.

This **offline repair outline** is reconstructed from the operator action summary and raw/21–23; this documentation worker did not execute it.

1. Fully stop the target Colima VM; APFS-clone both root `disk` and data `datadisk`. The latter holds k3s, containerd and local-path PVs. Repair the clones, retaining originals.
2. Import each clone with `limactl disk import` and attach to a small temporary Lima rescue VM using `additionalDisks`, for example `additionalDisks: [{name: beluga-root-rescue, format: false}, {name: beluga-data-rescue, format: false}]`. **WARNING: without `format: false`, Lima may format a disk it considers empty.**
3. Identify actual devices/partitions with `lsblk -f` in the rescue VM. Inspect the journal read-only, then unmount every filesystem to be checked. Do not copy device names from an earlier capture.
4. Run `e2fsck -fy <identified-partition>` on each unmounted ext4 filesystem and re-check. `-y` accepts all repair prompts. Check output as well as exit codes and confirm a clean re-check.
5. Stop the rescue VM, detach clones, then swap repaired clones into Colima. Keep originals and check clean startup, EXT4 logs and workloads. This incident retained `disk.bak-pre-fsck-20261116`, `datadisk.bak-pre-fsck-20261116` and `disk.bak-pre-hwe-kernel-20261116` in the host instance directory (operator-reported). Delete only after stable lab operation.
