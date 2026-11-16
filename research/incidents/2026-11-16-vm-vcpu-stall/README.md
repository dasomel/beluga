# Incident Report: VM vCPU Stalls and Host Memory Pressure

English | [한국어](README-ko.md)

## Summary

**Measured:** The Colima single-node lab had two stall episodes on 2026-11-16 KST. Stall A first logged soft lockups at 04:14:01 and ended with a stop at 07:06:41. Stall B's boot journal spans 07:07:01–09:51:33; a 22:30:41 host capture reports an open SSH port but no login within 150 s. Restart completed at 22:41:02 ([raw/10](raw/10-first-stall.txt), [raw/03 stop](raw/03-colima-stop.log), [raw/19](raw/19-prev-boot-summary.txt), [raw/14](raw/14-host-2232.txt), [raw/18](raw/18-start.log)).

**Inferred:** Host memory overcommit is consistent with the symptoms: guest pages could be held in the host compressor, with vCPUs waiting for decompression or being descheduled. **Unknown:** No capture ties a specific guest page or vCPU pause to host compression. A VZ/kernel-7.0 scheduling bug independent of memory is not excluded. The relation to the earlier [kernel-6.8 clock jump](../2026-11-16-vm-clock-jump/README.md) is unknown. No cluster or network access was used to write this report.

## Environment and impact

**Measured:** Colima reports aarch64, 10 vCPU and 24 GiB ([raw/03 summary](raw/03-stop-summary.txt)); startup uses VZ (raw/18). Kernel traces identify `7.0.0-43-generic` and Apple Virtualization Generic Platform (raw/10,19). Host RAM is 64 GB in [raw/12](raw/12-host-memory.txt).

**Measured — Stall A:** Raw/10 reports 2,146 soft lockups, including idle `swapper/3`, and 55 RCU stall matches. Raw/09 reports 108 global OOM kills, no memcg kills, with the first OOM at 06:47:12 ([raw/09](raw/09-oom-history.txt)). At 06:46:48, load was 521.25/519.70/518.41 and MemAvailable 1,766,448 kB ([raw/01](raw/01-vm-memory.txt)). At 06:47:01, `eventpoll_epi` held 16,221,664 objects and `oom_kill` was 106 ([raw/02](raw/02-thread-states-slab.txt)); counts are snapshots with different scopes/times, not interchangeable totals. Raw/09's hourly lockup counts sum to 2,211, whereas raw/10's kind summary says 2,146; query scopes are not preserved, so the latter is a reported summary rather than an independently reconciled count.

**Measured / inferred — timers and wall clock:** [Raw/11](raw/11-time-events.txt) has systemd time-related entries through 04:xx and none in its 05:xx–07:xx buckets; **inferred:** timer progress was disrupted, not a measured proof that every timer stopped. Guestagent reported host synchronization with drifts of +154, −140 and +121 ms at 06:49–06:53. **Inferred:** those samples support a correct wall clock at those instants, not continuous clock correctness through the stall.

**Measured — Stall B:** Raw/19 reports 5 soft lockups, 2 RCU stall matches, 0 OOM and 0 ext4 error matches before the retained journal ends. At 09:51:21 it logs an expedited RCU stall on CPU 3; the excerpt includes `cpuidle_idle_call`. At 09:51:33 `cilium-agent` on CPU 7 is stuck in `smp_call_function_many_cond`. **Inferred:** waiting for an IPI is consistent with this trace; the trace alone does not identify the host-side cause.

**Measured:** Raw/19 labels its memory section “09:20–09:49 (every 5th)” but preserves only six rows, 09:20:18–09:45:18 KST. Available memory is 8,721–8,864 `avail_mb`, `eventpoll_epi` is flat at 6,816 and load falls from 1.05 to 0.54 (intermediate maximum 1.14). It separately records the clock guard finishing at 09:49:58. **Inferred:** no guest memory exhaustion or epoll slab growth is visible in these samples. This argues against either as B's preceding condition, but cannot rule out a change in the unobserved final minutes; “healthy through 09:49” and “trigger ruled out” exceed the preserved evidence. Units are retained as printed rather than asserting 8.7 GiB.

## Timeline (KST, UTC+09:00)

**Measured unless explicitly marked inferred; times below are recorded labels.**

| KST | Observation | Source |
|---|---|---|
| 04:14:01 | First soft lockups: idle swapper and RCU worker | raw/09,10 |
| 06:46–06:53 | High load/slab, OOMs; subsecond guestagent clock drift samples | raw/01,02,09,11 |
| 07:03:07–07:06:41 | Colima stop; containerd stop failed, VZ stopped; exit 0 | raw/03 stop |
| 07:07:01–09:51:33 | B boot's retained journal range; startup command completed 07:09:13 | raw/19, [raw/04](raw/04-colima-start.log) |
| 09:20–09:45 | Preserved guest memory samples show flat epoll slab | raw/19 |
| 09:51:12–09:51:33 | cpuidle trace, CPU 3 RCU stall, cilium-agent soft lockup; journal stops | raw/19 |
| 22:30:41 | Open SSH port, no login within 150 s; pressured host | raw/14 |
| 22:30:48 | Colima stop begins; no completion in this file | [raw/15](raw/15-stop.log) |
| 22:38:06–22:38:36 | Hostagent SIGINT, VZ shutdown, instance shut down, exit 0 | [raw/16](raw/16-limactl-stop.log) |
| 22:38:44 | Host: 51G used, 10G compressor, 12G unused | [raw/17](raw/17-host-after-stop.txt) |
| 22:38:45–22:41:02 | Colima restart, exit 0 | raw/18 |
| 22:43:04–22:43:24 | Supplied tests 03/09/31 pass; test 32 also reports PASS without timestamp | raw/20-* |

**Inferred / arithmetic:** The last journal line to the 22:38:36 shutdown spans about 12.8 h. This is consistent with a prolonged stall, but continuous unresponsiveness was not sampled across that entire interval.

## Host observations and interpretation

**Measured:** At 22:30:41, raw/14 reports 62G PhysMem used, 17G compressor, 1,283M unused, and swap 2,817.38M used of 4,096M. The VZ process is at 722.5% CPU and 6.6G RSS; another VM on the host holds 17.6G RSS. At 07:55:14 (after A, before B), raw/12 reports 63G used, 17G compressor, 316M unused, swap 3,145.38M/4,096M, and the lab VZ PID at 18.4GB RSS. These are snapshots, not a measured onset-time pressure trace. The provided files do not preserve the claimed 22:25–22:32 range or 209M unused minimum.

**Measured / arithmetic:** With the lab stopped, raw/17 reports 12G unused, less than the configured 24 GiB allocation. **Inferred:** the host had insufficient immediately unused memory for that allocation. Unused memory is not the same as reclaimable capacity; compressor occupancy, cumulative decompression counts and low VZ RSS do not prove which guest pages were compressed or the cause of the vCPU stalls.

**Inferred / unproven:** Host memory overcommit with compression/decompression or descheduling is consistent with these observations. **Unknown:** a VZ/kernel-7.0 vCPU scheduling defect independent of memory remains possible; the relationship to the kernel-6.8 +95-year jump is unknown. The A epoll/OOM observations do not establish B's trigger or the ordering of A's slab growth and stalls.

## Recovery actions and result

**Measured:** Raw/15 contains only the 22:30:48 stop request. Raw/16 logs SIGINT at 22:38:06 and shutdown at 22:38:36, exit 0: a 30 s logged interval. **Unknown:** the claimed 420 s Colima timeout and 32 s limactl elapsed time are not preserved. The operator identifies the fallback command as `LIMA_HOME=~/.colima/_lima limactl stop colima-beluga`; its command line is not in raw/16. Clean guest shutdown and next-boot ext4 journal recovery/error status are not established by these captures.

**Measured:** Raw/18 records restart exit 0. Supplied live captures show [test 03](raw/20-test-03.log) passing Flink duplicate-active-job and Lakekeeper/SeaweedFS checks, [test 09](raw/20-test-09.log) passing S3 authorization/network/fsync checks, [test 31](raw/20-test-31.log) passing 3 groups/17 evaluated rules and Watchdog delivery, and [test 32](raw/20-test-32.log) passing point-in-time clock sanity. The documentation worker did not rerun these tests. **Unknown:** no all-pod Ready listing or elapsed readiness measurement is preserved; test 03 does not prove recovery without HA-runbook intervention. After A, [raw/06](raw/06-flink-crashloop.txt) does show broken HA checkpoint handles and failed file verification; [raw/07](raw/07-seaweedfs-fsync-options.txt) is a configuration/help/dry-run capture, not proof of an applied change.

## Open owner decisions and discriminating follow-ups

- **Unknown / owner decision:** Host memory budget: VM size versus other workloads. No allocation change is made here.
- **Unknown / owner decision:** Keep kernel 7.0 or return to 6.8; the earlier clock-jump risk remains relevant. No kernel decision is made here.
- **Inferred discriminator:** Repeat under host memory headroom greater than the VM allocation, and collect host-side per-minute `memory_pressure` alongside the guest sampler. A stable run would strengthen the pressure hypothesis; it would not prove causality by itself.
- **Unknown:** Scheduling traces and compression/page attribution at onset, actual outage duration and data loss, and a controlled reproducer remain absent.

## How to recognise it next time

**Inferred diagnostic procedure, derived from raw/10,12,14,19:**

1. Budget the VM allocation to fit free host memory with headroom for host workloads; compare host compressor/swap/pressure with guest MemAvailable and slab samples.
2. If SSH accepts a connection but cannot log in, inspect host VZ CPU/RSS and guest cpuidle/RCU/IPI traces before attributing the stall to guest OOM.
3. Select journals by boot ID: raw/19 reports that `journalctl -b -1` picked an older boot because year-2122 timestamps from the earlier incident sort last. Use `journalctl --list-boots` to identify the boot, then `journalctl -b 88de76e0381f498f8ce723c97937be19` for B. Do not trust the relative index alone.

## Evidence limits

**Measured scope:** `raw/` contains 23 unchanged nonempty operator captures and a `.gitignore` allowing their logs. The empty input `13-probe-2230.txt` was omitted; raw/14 preserves the SSH observation. All inputs were reviewed for secrets and checked with the repository evidence checker's secret pattern; no secret-bearing file was found. Other VM project identity is not included. Supplied counts and excerpts cannot recover omitted journal lines or command scopes. JSONL revisions identify the documentation baseline, not a verified deployed SHA.

**Measured — documentation checks:** Offline commands, exit codes and output are preserved in [verification.txt](verification.txt). Static checks do not prove live recovery or recurrence prevention. Runtime code, cluster configuration, kernel and host allocation were left unchanged.
