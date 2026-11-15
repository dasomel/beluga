# Incident Report: VM Clock Jump, Kafka Log Write Saturation and Hung Boots

English | [한국어](README-ko.md)

## Summary

**Measured:** The Colima lab guest read `2122-01-07T00:27:01Z` while the host read `2026-11-15T15:15:26Z` and the RTC read `2026-11-15 15:15:27`; uptime showed 24,855 days ([raw/01](raw/01-clock-state.txt)). Three `kafka.Kafka -Xmx1024m` processes had cumulative `write_bytes` of 101,266,726,912, 101,297,623,040 and 101,883,527,168 bytes. Container stdout contained `CertificateExpiredException: NotAfter: Thu Nov 04 14:26:33 GMT 2027`, SSL handshake failures and KRaft FETCH `NETWORK_EXCEPTION` ([raw/07](raw/07-kafka-write-and-log-sample.txt)).

**Inferred:** The future clock made certificates appear expired; repeated TLS failures and KRaft retries are consistent with the container log write storm. An almost-full 56-bit counter wrap is consistent with the clock offset. The counter samples at the jump were not captured; the trigger is unknown. This report separates measured captures, verified upstream source, and inference. No cluster or network access was used to write it.

**Measured second root cause:** Root filesystem corruption forced fsck into failure and systemd into an emergency shell, preventing SSH startup ([raw/20](raw/20-failed-boot-journal.txt)). Both disks were repaired offline; the lab then booted HWE kernel `7.0.0-43-generic`. **Owner decisions, 2026-11-16:** apply the kernel mitigation and retain unattended guard reboot. Recurrence prevention and the real-jump reboot path remain unproven.

## Environment and impact

**Measured at the jump:** Guest kernel `6.8.0-117-generic`, clocksource `arch_sys_counter` ([raw/01](raw/01-clock-state.txt)); 56-bit mask, 24 MHz timer ([raw/05](raw/05-kernel-at-jump.txt), [raw/06](raw/06-counter-and-rtc.txt)). Host: Apple M4 Pro, macOS 27.2.1 build 26B131, Lima 2.3.0, Colima 0.10.3. The host power summary records no Sleep/Wake/DarkWake lines on November 14 or 15 ([raw/04](raw/04-host-power-summary.txt)); this does not identify the trigger.

**Measured — orchestrator-provided summary, incomplete raw coverage:** Each broker wrote approximately 3.4 MB/s (approximately 96 GB cumulative each in the operator's units); Kafka data occupied 25 MB, with no KRaft metadata log advance since November 15. Container stdout rotated approximately 10 MB every minute per broker at 57k lines/min, with VOTE/FETCH `NETWORK_EXCEPTION`. Root usage was 39%, data disk 56%: the reported saturation was write I/O, not exhausted capacity. Raw/07 supports the cumulative counters, rotated stdout sizes/timestamps, certificate and FETCH errors, but does not preserve rate samples, data-directory size, metadata progress, VOTE excerpt or pre-recovery `df` output. Those details are retained as the orchestrator's measurements, not independently reproducible from raw/07.

**Measured / inferred:** The orchestrator reported roughly 100–200 restarts on many pods on November 14/15 and k3s `current time 2122-01-06` certificate errors. Raw/16 preserves restart counts up to 111 for deleted pods and raw/02 a truncated k3s CA-validation error; raw/08 is not a usable pod-state capture. Attribution of the earlier restarts to the same clock mechanism is **inferred**, consistent with these symptoms, not proven per pod.

## Timeline (KST, UTC+09:00)

**Measured:** Journal entries below are recorded labels, not precise jump instants. The journal warns of a truncated file and missed messages; future-dated timestamps are not reliable elapsed-time measurements ([raw/02](raw/02-journal-year-transitions.txt), raw/05).

| KST / UTC where captured | Observation | Source |
|---|---|---|
| 2026-11-13 22:03:06 KST | Boot preceding first recorded year transition | raw/02 |
| 2026-11-14 18:35:24 KST → 2122-01-06 05:45:51 KST | Last normal entry → first future entry, at journald restart | raw/02 |
| 2026-11-15 11:50:48 KST | Boot preceding second recorded transition | raw/02 |
| 2026-11-15 15:49:02 KST → 2122-01-07 01:02:08 KST | Last normal entry → first future entry; missed kernel messages | raw/02, raw/05 |
| 2026-11-16 00:15:26 KST / 2026-11-15 15:15:26Z | Host/guest/RTC disagreement captured | raw/01 |
| 2026-11-16 00:18:13 KST / 2026-11-15 15:18:13Z | Recovery start; Colima shutdown completes at 00:18:28 KST | [raw/11](raw/11-recovery.log) |
| 2026-11-16 00:21:06 KST / 2026-11-15 15:21:06Z | Correct VM/RTC time; synchronized=yes | raw/11 |
| 2026-11-16 00:21:29–30 KST / 2026-11-15 15:21:29–30Z | Realtime-only injection returns to normal after 1 s | [raw/12](raw/12-clock-guard-injection-test.txt) |
| 2026-11-16 00:23:28 KST / 2026-11-15 15:23:28Z | Second realtime-only test corrected after 12 s | [raw/15](raw/15-clock-guard-test.txt) |
| 2026-11-16 00:31:38 KST / 2026-11-15 15:31:38Z; checks through 00:32:10 KST | Host/VM agree; workload verification below | [raw/17](raw/17-post-recovery.txt) |
| 2026-11-16 00:42 / 00:52 KST | Two starts failed on SSH timeout; failed journal begins 00:42:29 | [raw/19](raw/19-kernel-upgrade.log), [raw/20](raw/20-failed-boot-journal.txt), [raw/24](raw/24-hung-boot-network-probe.txt) |
| 2026-11-16 01:04–01:07 KST (operator-reported window; raw has no repair timestamps) | Rescue VM: root/data disk fsck repairs, clean re-checks | [raw/21](raw/21-root-fsck.txt), [raw/22](raw/22-data-fsck-check.txt), [raw/23](raw/23-data-fsck.txt) |
| 2026-11-16 01:10 KST | Start after fsck exited 0 | raw/24 |
| 2026-11-16 01:11–01:14 KST (operator-reported window); start exit 0 at 01:13; snapshot 01:13:55 KST / 16:13:55Z | Kernel install/reboot; `7.0.0-43-generic` running | [raw/25](raw/25-kernel-install.txt), [raw/27](raw/27-kernel7-boot.txt), raw/24 |
| 2026-11-16 01:15:52 KST / 2026-11-15 16:15:52Z | Post-kernel-7 verification snapshot; operator labels the run 01:16, individual tests untimestamped | [raw/28](raw/28-post-kernel7-verification.txt) |

## Mechanism and why it did not self-heal

**Measured / arithmetic:** `2^56 / 24e6 = 3,002,399,751.58 s`, approximately 95.142 years. System minus RTC was 3,002,433,095 s: 33,343 s above that wrap, about 11 ppm ([raw/06](raw/06-counter-and-rtc.txt), [raw/09](raw/09-wrap-arithmetic.txt)). **Inferred:** This difference is consistent with clocksource multiplier rounding / NTP frequency correction; neither contribution was isolated.

**Verified upstream, only from [raw/18](raw/18-upstream-verification.txt):** v6.8 `clocksource_delta` computes `(now - last) & mask` without a negative-motion guard unless `CONFIG_CLOCKSOURCE_VALIDATE_LAST_CYCLE` is enabled; the guest config check had count 0. A slightly lower next counter value can therefore become an almost-full-wrap forward delta. **Inferred:** That mechanism is consistent with both the future wall clock and enormous uptime here; the counter values themselves were not captured, so the backward step is not directly observed. What makes the vz counter step backward is unknown.

**Measured:** systemd-timesyncd repeatedly logged `Failed to call clock_adjtime(): Invalid argument`, usually about 32 s apart ([raw/03](raw/03-timesyncd-journal.txt)); the NTP offset read `-95y 1month 3w` (raw/01). Lima guestagent logged `SyncTime: failed to set system time` / `invalid argument` at 10 s intervals, with 5,923 matching lines in the captured boot query ([raw/13](raw/13-lima-guestagent.txt)).

**Verified upstream:** v6.8 `do_settimeofday64` returns `-EINVAL` when `timespec64_compare(&tk->wall_to_monotonic, &ts_delta) > 0` (raw/18). **Inferred:** The jumped monotonic clock (consistent with uptime) explains refusal to restore wall time to 2026: the requested wall time would precede CLOCK_MONOTONIC. Repeated sync cannot repair that state; a reboot resets it. The stop/start recovery is measured below; a direct counter trace is absent.

**Verified upstream (raw/18):** [Lima #5665](https://github.com/lima-vm/lima/issues/5665), open when captured, created 2026-10-22, reports a vz guest +95-year jump and sync EINVAL until restart. [#5543](https://github.com/lima-vm/lima/issues/5543) reports guestagent backward wall-clock steps under host load; [PR #4527](https://github.com/lima-vm/lima/pull/4527) added host-to-guest sync. These do not prove the local counter trigger. Linux `c163e40af9b2` (2024-10-31, “timekeeping: Always check for negative motion”) and `76031d9536a0` (2024-12-03, “clocksource: Make negative motion detection more robust”) address negative motion. v6.13 source contains the guard returning 0 when delta exceeds `max_delta`; v7.0 also contains this guard (same raw/18). The applied guest kernel and verification limits are recorded below. Architecture-specific Kconfig selection claims and other unconfirmed material from [raw/10](raw/10-research-lane-unverified.md) are excluded.

## Recovery actions and result

**Measured:** The orchestrator stopped/started Colima during 2026-11-16 00:18–00:32 KST. Raw/11 records shutdown, startup checks, failed then active dnsmasq, enabled guard timer and corrected clock. Raw/16 lists the 11 deleted pods; raw/17 records host/guest agreement, write rates 9, 9, 10 and 0 KB/s for four sampled Kafka PIDs, three Flink jobs RUNNING and exit 0 for `tests/02-ingest-cdc`, `tests/03-stream-iceberg`, `tests/29-cdc-slot-wal-retention`. Post-recovery root usage was 37%, data disk 56% (raw/17). These are supplied live captures, not tests rerun by this documentation worker.

**Measured — orchestrator-provided action/result summary:** dnsmasq failed because Colima emitted a bare second IP line in `/etc/dnsmasq.d/01-colima.conf` for a two-address VM. A VM-local ExecStartPre strip script repaired it. Eleven pods stuck in `CreateContainerError` / `failed to reserve container name` were deleted; restarting k3s had not helped in the November 15 observation. All three ArgoCD applications were Synced/Healthy and the Kafka CR Ready. Raw/11 and raw/16 support the recovery outline, but do not preserve the malformed file, error detail, failed k3s restart, or ArgoCD/Kafka status output. See the [installation record](../../../scripts/colima/README.md) for reconstructed units and dnsmasq drop-in.

## Second root cause: filesystem errors blocked boot

**Measured:** At 00:42 and 00:52 KST, `colima start` failed after the SSH wait (raw/24: timeout=599), despite a running VM. Raw/24 records connection refused on `192.168.5.1:22` and `.3:22`. **Measured — orchestrator summary:** both attempts timed out after ten minutes with “did not receive an event with the running status”; hypervisor status was running and the serial log empty. Two identical symptoms on 2026-11-13 at 05:06 and 05:22 KST had been recorded as “cause unknown”; those earlier boot journals are not in this raw set. Attribution of those earlier failures to the same cause is **inferred**, consistent with this symptom.

**Measured:** The failed boot journal reports `cloudimg-rootfs contains a file system with errors, check forced`, corrupted orphan linked-list inodes, `UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY`, fsck exit status 4, failure of `systemd-fsck-root.service`, then `Started emergency.service - Emergency Shell` (raw/20). This explains the current hung boots and absent sshd. Raw/05 contains prior EXT4 errors on vda1/vdb1; raw/20 records root error count 1 and initial error epoch `1793839819` (epoch conversion: 2026-11-05 00:50:19 UTC). **Measured — orchestrator summary:** earlier boots recorded data error count 7. **Inferred:** check forcing is consistent with each boot's filesystem error/mount state; damage is consistent with earlier unclean stops (host power loss / forced stops). Neither the damaging event nor the earlier boots' check decisions were traced.

**Measured — orchestrator action summary, results in raw/21–23:** Both disks were APFS-cloned, attached unformatted to a temporary Lima rescue VM, unmounted and repaired with `e2fsck -fy`. Root repaired orphan-list/bitmap/count errors and re-check exited 0 (raw/21). The data disk holds k3s state, containerd and local-path PVs: the read-only check showed block/inode bitmap differences and “Filesystem still has errors” despite recorded check rc=0 (raw/22); the repair also fixed two “deleted inode has zero dtime” entries and re-check exited 0 (raw/23). Do not treat the raw/22 rc alone as a clean result. Repaired clones replaced the originals. Original disks remain in the host Colima instance directory as `disk.bak-pre-fsck-20261116` and `datadisk.bak-pre-fsck-20261116`, alongside `disk.bak-pre-hwe-kernel-20261116` (the last backup is listed in raw/19; the swap/other names are operator-reported). First start after repair exited 0 (raw/24); the operator reports no EXT4 errors in dmesg, raw/27 also ends with an unlabeled `0`, without the query text, so it does not independently establish that check’s scope.

## Applied kernel prevention and owner decisions

**Owner-approved, 2026-11-16:** `D-CLOCK-2` moves the guest to a kernel with negative-motion detection; `D-CLOCK-1` retains unattended reboot when the guard cannot restore time. The cost is a guest kernel transition and whole-node interruption on reboot. Escape hatches are the retained `6.8.0-117-generic` fallback (which lacks this mitigation) and disabling the guard timer as described in the installation record. No repository-managed component version changed.

**Measured:** `linux-virtual-hwe-24.04` installation selected `7.0.0-43-generic`; 6.8 remains available (raw/25). Boot capture confirms 7.0, still `arch_sys_counter`, 56 bits at 24 MHz (raw/27): the counter itself is unchanged. **Verified upstream:** v7.0 `clocksource_delta` returns 0 when the masked delta exceeds `max_delta`, rather than applying it (raw/18). The guest binary was not inspected beyond its version. **Inferred:** this addresses the mechanism consistent with the observed jump; it does not establish immunity.

**Measured:** Raw/28 records three ArgoCD applications Synced/Healthy, Kafka Ready, Cilium OK, `tests/01`, `02`, `03`, `29` exit 0, `tests/31` PASS (3 groups/14 healthy evaluated rules; Watchdog delivered), and broker write rates 9/9/9 KB/s (fourth sampled PID 0). **Measured — orchestrator summary:** node Ready on 7.0, all pods Running/Completed without manual deletion, `tests/01` used `EXPECTED_NODES=1`; raw/28 does not include node/pod listings or that environment setting. These are supplied live observations, not worker reruns.

## Mitigation and limits

**Measured:** [raw/14](raw/14-beluga-clock-guard.sh) is the installed VM-local guard, copied to [scripts/colima/beluga-clock-guard.sh](../../../scripts/colima/beluga-clock-guard.sh). The enabled timer appears in raw/11–12. The 30 s timer compares system time with RTC; above 120 s absolute skew it tries `date -s @rtc`. Failure logs and reboots the VM unattended (`D-CLOCK-1`). This is VM-local, outside GitOps. It assumes a readable, correct RTC and a running timer; it does not prevent the counter fault or guarantee recovery latency.

**Measured:** Raw/12 and raw/15 show realtime-only jumps corrected within seconds, consistent with Lima guestagent SyncTime / guard operation; raw/15 attributes the 12 s correction to SyncTime. Raw/12 does not isolate the correcting actor. Only a forced-failure **dry-run** exercised the “cannot set → reboot” branch. Userspace injection did not jump CLOCK_MONOTONIC. **Inferred / unproven:** Automatic reboot and workload recovery after a real counter jump remain unverified. The copied script's introductory mechanism comments describe the diagnosis, not a captured counter trace.

## Open questions and follow-ups

- **Inferred / unknown:** The vz counter's backward-step trigger; no Sleep/Wake events were found, but this does not establish an alternative cause.
- **Inferred / unverified:** Whether the timer and unattended reboot recover a real counter jump, and what persisted future timestamps affect.
- **Measured — orchestrator-reported gap:** No clock-skew or runaway-container-log-volume alert exists for this incident; no delivery test for those signals was captured (raw/28 tests Watchdog delivery).
- **Inferred / unproven:** Recurrence on 7.0 cannot be excluded: no deliberate counter-step reproducer exists. Track `uptime` and system clock versus RTC over time.
- **Follow-up:** Delete the retained disk backups only once the lab has run stably; they remain available for rollback/inspection.

## How to recognise it next time

Diagnostic checklist derived from measured raw/01, raw/03, raw/06 and raw/07:

1. Compare `date -u` / `date +%s` with `cat /sys/class/rtc/rtc0/since_epoch` and trusted host time.
2. Check `uptime` for approximately 24,855 days on a recently booted VM.
3. Run `journalctl -u systemd-timesyncd` for `clock_adjtime(): Invalid argument`; check guestagent SyncTime errors too.
4. Locate the written bytes: compare Kafka data files and container stdout logs before tuning Kafka or JVM settings. Future timestamps and certificate-expiry retry storms are consistent with this incident.
5. If `colima start` times out while the hypervisor says running and SSH is refused, suspect root fsck / emergency shell. Read the failed boot journal from disk before retrying or waiting; repair offline using cloned disks and a rescue VM (raw/20–24; [procedure](../../../docs/colima-single-node.md)).

## Evidence limitations

**Measured scope:** Raw captures are partial, include truncated journals and future-dated entries, and lack some operator-summary measurements identified above. Evidence records use the documentation baseline revision as context, not a verified deployed SHA. No exact incident duration, loss count, complete service outage interval, direct counter cause or real-jump reboot success is established. Static repository gates cannot establish live recovery.

**Measured — documentation checks:** Offline gate commands, exit codes and output excerpts are retained in [verification.txt](verification.txt). These do not prove live VM behavior.
