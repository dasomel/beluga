# Incident Report: CDC Replication Slot WAL Accumulation and Disk Pressure Eviction Deadlock

English | [한국어](README-ko.md)

## Summary

On 2026-11-11, an idle PostgreSQL database (`shop`) replication slot (`beluga_shop_slot`) used by Debezium CDC retained 22.85 GB of write-ahead logs (1365 WAL segments) across the shared PostgreSQL instance in a state consistent with missing heartbeat queries and an unlimited `max_slot_wal_keep_size=-1` configuration. Other shared databases (`beluga_meta` and `openfga`) were committing transactions while `shop` showed little write activity (`03-postgres-slot.txt`), and `confirmed_flush_lsn` was observed stagnant at `0/3E8BC10` while the instance WAL head was at `5/560399F8`; this is consistent with Debezium receiving no change events from `shop`, but event flow was not measured directly. `/dev/vdb1` usage peaked at 99% (`04-recovery-timeline.txt:51`). Pod evictions with the message `The node was low on resource: ephemeral-storage` (100 Evicted events, `01-k8s-events.txt:219` to `:323`) and a `node.kubernetes.io/disk-pressure` taint were observed (`01-k8s-events.txt:303`, `04-recovery-timeline.txt`); 982 terminated pod objects were purged per `07-orchestrator-actions-before-capture.txt` (a reconstruction from the session transcript, not a live capture). Kafka broker pods were `Pending` with `FailedScheduling` events citing an untolerated taint. Which filesystem crossed the kubelet eviction threshold first is not established. Kafka connection errors in `09-connect-log-growth.txt` begin at `2026-11-11T00:02:03,697` (earliest error line in the onset excerpt, `:199`), about 15 hours before the first eviction event captured in `01-k8s-events.txt:219` (`2026-11-11T15:23:58Z`). The observed evidence is consistent with a circular deadlock where Debezium could not flush offsets while Kafka was Pending, and PostgreSQL could not reclaim WAL. Before live capture started, a no-op UPDATE was executed on `shop.orders` (`07-orchestrator-actions-before-capture.txt`); the slot did not move for about 4 minutes while Kafka was Pending, and whether it contributed to the later catch-up is unknown. The replication slot was not dropped. Recorded actions were pod purges, container cleanup and one manual CHECKPOINT (`07-orchestrator-actions-before-capture.txt`, a reconstruction). Separately, `04-recovery-timeline.txt` shows the slot becoming active again and retained WAL reaching 168.9 MB by `17:04:46Z`. No causal link between the actions and that drain is established by the evidence (reclaiming disk usage back to 54%, with the connector ending in RUNNING state per `06-post-recovery.txt`).

A second disk consumer was found after recovery (a link to the first via Kafka unreachability is not ruled out): connect log files on the node root filesystem (`09-connect-log-growth.txt`). Connect log files generated 1,630,968 B to 3,356,874 B per day on normal days (224,639 B on partial day 2026-11-05), but reached 10,894,138,431 B (~10.89 GB) on 2026-11-11 (`09-connect-log-growth.txt:154-160`), with hourly files of 0.92 to 1.35 GB during hours 08..16 (e.g. 1,177,328,424 B in hour 08 and peaking at 1,345,036,745 B in hour 11; `09-connect-log-growth.txt:142-150`). The hour-00 file was oversized (143,639,341 B; `:166-167`), hours 01..06 were normal-sized (67,939 B to 67,956 B each; `:175-180`), and sustained growth starts in hour 07 (591,711,275 B; `:181`). Deleting the 2026-11-11 rotated files at `2026-11-11T18:05:43Z` reduced root filesystem usage from `/dev/root 19G 16G 3.2G 83% /` to `/dev/root 19G 5.1G 14G 28% /` (`09-connect-log-growth.txt:3,234,236`). Which filesystem crossed the kubelet threshold first is NOT established; eviction messages in `01-k8s-events.txt:219` state `The node was low on resource: ephemeral-storage. Threshold quantity: 2625973491, available: 2153248Ki.` without identifying which filesystem it refers to.

## Environment

- **Cluster topology**: Single-node Colima k3s development cluster (`colima-vz-arm64-k3s-single-node`, node `master-1`) (source: `02-node-disk.txt:1`, `01-k8s-events.txt:324`).
- **Filesystem `/dev/root`**: Size 19G, Used 15G, Avail 4.3G, Use% 77%, mounted on `/` (source: `02-node-disk.txt:9`).
- **Filesystem `/dev/vdb1` (data / Rancher)**: Size 49G, Used 40G at detection (85%), Avail 7.2G, mounted on `/var/lib/rancher` (source: `02-node-disk.txt:10`).
- **Disk allocation in `/var/lib/rancher`** (source: `02-node-disk.txt:11-17`):
  - Container runtime: 17G (`/var/lib/rancher/k3s/agent/containerd`)
  - Volume storage: 24G (`/var/lib/rancher/k3s/storage`)
  - PostgreSQL PVC (`pvc-b513f7fc-a2fd-4ba7-8c4b-ea78beeaefad_database_postgres-main-1`): 22G
  - SeaweedFS storage PVC (`pvc-afb95bd4-ec58-48f3-ac8c-c4532f88c49c_storage_seaweedfs-data-seaweedfs-0`): 712M
  - Beluga Manager DB PVC (`pvc-e81d26cc-b2f4-421f-ae29-691b61caffb0_platform-system_manager-db-1`): 591M
  - Kafka message bus PVC (`pvc-4d14e2fe-e558-4fc0-9682-0302aa330fc8_streaming_data-0-beluga-kafka-mixed-0`): 140M
  - APISIX etcd PVC (`pvc-df397c1d-db7d-4809-a964-2fd2a1a385e3_platform-system_apisix-etcd-data`): 124M
- **Node conditions at initial capture** (`02-node-disk.txt:2-7`):
  - `NetworkUnavailable=False` (reason: `CiliumIsUp`, lastTransition: `2026-11-04T14:14:38Z`)
  - `MemoryPressure=False` (reason: `KubeletHasSufficientMemory`, lastTransition: `2026-11-04T14:13:58Z`)
  - `DiskPressure=False` (reason: `KubeletHasNoDiskPressure`, lastTransition: `2026-11-11T16:19:13Z`)
  - `PIDPressure=False` (reason: `KubeletHasSufficientPID`, lastTransition: `2026-11-04T14:13:58Z`)
  - `Ready=True` (reason: `KubeletReady`, lastTransition: `2026-11-04T14:13:58Z`)
  - `taints`: None at `16:19:42Z` (flapped back to `[node.kubernetes.io/disk-pressure]` under workload).

## Timeline (UTC)

Built from raw evidence files `01-k8s-events.txt`, `04-recovery-timeline.txt`, `05-actions.txt`, `06-post-recovery.txt`, `08-post-fix-verification.txt`, and `09-connect-log-growth.txt`. Actions taken prior to live capture are documented in `07-orchestrator-actions-before-capture.txt`, which is a reconstruction from the session transcript, not a live capture.

Note: the earliest error line in the `09-connect-log-growth.txt` onset excerpt is `2026-11-11T00:02:03,697` (`:199-200`, a fetch `DisconnectException`; node 0 disconnects follow at `00:02:06,022`), and `2026-11-11T00:02:14,306` (`:167`, `:215`) is the first line matching the pattern used by the capture command (`:165-167`). Both are about 15 hours before the first eviction event captured in `01-k8s-events.txt:219` at `2026-11-11T15:23:58Z` (events before that are absent from the capture). The cause of that Kafka unreachability is NOT established.

### Event Breakdown in `01-k8s-events.txt`
Total lines in `01-k8s-events.txt`: 324 (1 header line `# captured 2026-11-11T16:19:40Z` + 323 event lines).
- `FailedScheduling`: 217 events (all timestamps `<nil>`, untolerated taint `node.kubernetes.io/disk-pressure`).
- `Evicted`: 100 events (first timestamp `2026-11-11T15:23:58Z`, last timestamp `2026-11-11T16:17:23Z`).
- `FreeDiskSpaceFailed`: 3 events (`2026-11-11T16:00:22Z`, `2026-11-11T16:05:22Z`, `2026-11-11T16:10:23Z`).
- `EvictionThresholdMet`: 1 event (`2026-11-11T15:54:11Z`).
- `NodeHasDiskPressure`: 1 event (`2026-11-11T16:10:36Z`).
- `NodeHasNoDiskPressure`: 1 event (`2026-11-11T16:19:13Z`).

### Sequence of Observations and State Transitions

| Timestamp (UTC) | Source | Entity / Scope | Event / State Transition Description | Metrics (Retained Bytes / Segs / Disk / Pods) |
|---|---|---|---|---|
| `2026-11-11T00:02:03,697` | `09-connect-log-growth.txt:199-200` | `streaming/debezium-connect` | Earliest error line in the onset excerpt (lines 140-170 of `connect-service.log.2026-11-11-00`): INFO `Error sending fetch request ... DisconnectException`; node 0 disconnects follow at `00:02:06,022` (`:201-212`) | Earlier lines of the file are not in the excerpt |
| `2026-11-11T00:02:14,306` | `09-connect-log-growth.txt:166-167,215-216` | `streaming/debezium-connect` | First line matching the capture's grep pattern (`Error connecting to node`); `connect-service.log.2026-11-11-00` is the first hourly file over 100 MB (143,639,341 B) | `WARN [Producer clientId=debezium-cluster-configs] Error connecting to node beluga-kafka-mixed-0... java.net.UnknownHostException` |
| `2026-11-11T07:00Z` - `2026-11-11T16:59Z` | `09-connect-log-growth.txt:141-150,181-190` | `streaming/debezium-connect` | Hours 01..06 are normal-sized (67,939 B to 67,956 B each; `09-connect-log-growth.txt:175-180`); sustained growth starts in hour 07. Hours 07..16: 10 hourly files range from min 591,711,275 B (hour 07) to max 1,345,036,745 B (hour 11) | 8 of 10 hourly files exceed 1 GB; total on 2026-11-11 reaches 10,894,138,431 B (~10.89 GB) |
| `2026-11-11T15:23:58Z` | `01-k8s-events.txt:219` | `streaming/flink-cluster-774ccc5dfc-k76s2` | First recorded pod eviction (message: low on resource: ephemeral-storage) | Evicted (threshold quantity: 2625973491, available: 2153248Ki) |
| `2026-11-11T15:54:11Z` | `01-k8s-events.txt:280` | `master-1` | `EvictionThresholdMet`: Attempting to reclaim ephemeral-storage | Event message as recorded |
| `2026-11-11T16:00:22Z` | `01-k8s-events.txt:286` | `master-1` | `FreeDiskSpaceFailed`: Failed to free disk space by deleting images | 86% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:05:22Z` | `01-k8s-events.txt:301` | `master-1` | `FreeDiskSpaceFailed`: Second failed image prune | 85% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:10:23Z` | `01-k8s-events.txt:302` | `master-1` | `FreeDiskSpaceFailed`: Third failed image prune | 94% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:10:36Z` | `01-k8s-events.txt:303` | `master-1` | `NodeHasDiskPressure`: Node status is now NodeHasDiskPressure | Taint `node.kubernetes.io/disk-pressure` seen in `FailedScheduling` messages (timestamps `<nil>`) |
| `2026-11-11T16:17:23Z` | `01-k8s-events.txt:323` | `metallb-system/metallb-frr-k8s-rbv22` | Last recorded pod eviction in event capture buffer | The node had condition: [DiskPressure] |
| `2026-11-11T16:19:13Z` | `01-k8s-events.txt:324` | `master-1` | `NodeHasNoDiskPressure`: Temporary clearance after mass eviction | Node condition momentarily cleared |
| `2026-11-11T16:19:42Z` | `02-node-disk.txt:1` | Node filesystem | Disk snapshot captured during brief clearance | `/dev/vdb1` 40G/49G (85%), postgres PVC 22G, taints: [] |
| `2026-11-11T16:20:04Z` | `03-postgres-slot.txt:1` | `database/postgres-main-1` | Slot snapshot captured: `beluga_shop_slot` inactive, WAL pinned | retained=22,852,328,992 B, waldir=1365 segs (22.88 GB), `max_slot_wal_keep_size=-1` |
| `2026-11-11T16:21:21Z` | `04-recovery-timeline.txt:2` | Node & PostgreSQL | Timeline monitoring starts; DiskPressure taint returns under load | retained=22,868,891,728 B, active=true, segs=1366, notRunning=7, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:21:59Z` | `04-recovery-timeline.txt:3` | Workloads | Pod failure cascade accelerates | retained=22,869,097,976 B, active=true, segs=1366, notRunning=13, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:22:36Z` | `04-recovery-timeline.txt:4` | `beluga_shop_slot` | Slot becomes inactive (`active: false`); disk reaches 97% | retained=22,869,113,128 B, active=false, segs=1366, notRunning=20, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:09Z` | `04-recovery-timeline.txt:5` | Workloads | Unhealthy pods increase | retained=22,869,179,032 B, active=false, segs=1366, notRunning=26, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:41Z` | `04-recovery-timeline.txt:6` | Node filesystem | Disk usage drops to 83%; notRunning reaches 31 | retained=22,869,195,328 B, active=false, segs=1366, notRunning=31, taints=[disk-pressure], disk=39G/49G 83% |
| `2026-11-11T16:26:06Z` | `04-recovery-timeline.txt:10` | PostgreSQL | WAL segment count increases to 1367 | retained=22,885,652,400 B, active=false, segs=1367, notRunning=31, taints=[disk-pressure], disk=39G/49G 83% |
| `2026-11-11T16:29:07Z` | `04-recovery-timeline.txt:15` | Node taint | DiskPressure taint temporarily clears (`taints=[]`) | retained=22,885,854,744 B, active=false, segs=1367, notRunning=29, taints=[], disk=39G/49G 83% |
| `2026-11-11T16:29:49Z` | `04-recovery-timeline.txt:16` | Node filesystem | Disk climbs as pods restart | retained=22,885,875,192 B, active=false, segs=1367, notRunning=29, taints=[], disk=41G/49G 88% |
| `2026-11-11T16:30:27Z` | `04-recovery-timeline.txt:17` | Node filesystem | Disk climbs to 96%; notRunning drops to 19 | retained=22,885,890,160 B, active=false, segs=1367, notRunning=19, taints=[], disk=45G/49G 96% |
| `2026-11-11T16:31:17Z` | `04-recovery-timeline.txt:18` | Node taint & slot | DiskPressure taint reappears; slot briefly reconnects; segs=1368 | retained=22,902,443,272 B, active=true, segs=1368, notRunning=20, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:31:54Z` | `04-recovery-timeline.txt:19` | Workloads | notRunning climbs to 26 | retained=22,902,525,680 B, active=true, segs=1368, notRunning=26, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:32:32Z` | `04-recovery-timeline.txt:20` | `beluga_shop_slot` | Slot drops connection again (`active: false`) | retained=22,902,542,864 B, active=false, segs=1368, notRunning=29, taints=[disk-pressure], disk=45G/49G 96% |
| `2026-11-11T16:33:15Z` | `04-recovery-timeline.txt:21` | Node filesystem | Evictions resume; notRunning climbs to 37 | retained=22,902,596,088 B, active=false, segs=1368, notRunning=37, taints=[disk-pressure], disk=43G/49G 91% |
| `2026-11-11T16:33:52Z` | `04-recovery-timeline.txt:22` | Node filesystem | Disk drops to 84%; notRunning reaches 42 | retained=22,902,674,152 B, active=false, segs=1368, notRunning=42, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:36:06Z` | `04-recovery-timeline.txt:26` | PostgreSQL | WAL segment count increases to 1369 | retained=22,919,206,296 B, active=false, segs=1369, notRunning=42, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:38:41Z` | `04-recovery-timeline.txt:31` | Node taint | DiskPressure taint clears again (`taints=[]`) | retained=22,919,429,096 B, active=false, segs=1369, notRunning=42, taints=[], disk=39G/49G 84% |
| `2026-11-11T16:39:12Z` | `04-recovery-timeline.txt:32` | Node filesystem | Disk climbs to 88%; notRunning drops to 38 | retained=22,919,446,280 B, active=false, segs=1369, notRunning=38, taints=[], disk=41G/49G 88% |
| `2026-11-11T16:39:45Z` | `04-recovery-timeline.txt:33` | Node filesystem | Disk climbs to 94%; notRunning drops to 32 | retained=22,919,461,032 B, active=false, segs=1369, notRunning=32, taints=[], disk=44G/49G 94% |
| `2026-11-11T16:40:18Z` | `04-recovery-timeline.txt:34` | Node taint | DiskPressure taint reappears for 3rd time; disk at 98% | retained=22,919,485,832 B, active=false, segs=1369, notRunning=27, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:40:58Z` | `04-recovery-timeline.txt:35` | PostgreSQL | WAL segment count increases to 1370; notRunning climbs to 35 | retained=22,935,982,176 B, active=false, segs=1370, notRunning=35, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:41:37Z` | `04-recovery-timeline.txt:36` | Workloads | notRunning climbs to 40 | retained=22,936,023,632 B, active=false, segs=1370, notRunning=40, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:42:13Z` | `04-recovery-timeline.txt:37` | Node filesystem | Evictions resume; disk drops to 91%; notRunning climbs to 46 | retained=22,936,124,976 B, active=false, segs=1370, notRunning=46, taints=[disk-pressure], disk=43G/49G 91% |
| `2026-11-11T16:42:47Z` | `04-recovery-timeline.txt:38` | Node filesystem | Disk drops to 86%; notRunning climbs to 54 | retained=22,936,174,472 B, active=false, segs=1370, notRunning=54, taints=[disk-pressure], disk=40G/49G 86% |
| `2026-11-11T16:43:19Z` | `04-recovery-timeline.txt:39` | Node filesystem | Disk reaches 84%; notRunning remains 54 | retained=22,936,188,368 B, active=false, segs=1370, notRunning=54, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:45:54Z` | `04-recovery-timeline.txt:44` | PostgreSQL | WAL segment count reaches peak of 1371; notRunning=55 | retained=22,942,163,912 B, active=false, segs=1371, notRunning=55, taints=[disk-pressure], disk=39G/49G 85% |
| `2026-11-11T16:48:33Z` | `04-recovery-timeline.txt:49` | Node taint | DiskPressure taint clears again (`taints=[]`); notRunning drops to 48 | retained=22,952,901,728 B, active=false, segs=1371, notRunning=48, taints=[], disk=42G/49G 89% |
| `2026-11-11T16:49:08Z` | `04-recovery-timeline.txt:50` | Slot activity | Slot becomes active (`active: true`); retained WAL begins decreasing | retained=22,699,657,080 B, active=true, segs=1371, notRunning=44, taints=[], disk=44G/49G 95% |
| `2026-11-11T16:49:42Z` | `04-recovery-timeline.txt:51` | Node taint & slot | DiskPressure taint returns; disk hits peak 99%; slot remains active | retained=21,492,253,680 B, active=true, segs=1371, notRunning=41, taints=[disk-pressure], disk=46G/49G 99% |
| `2026-11-11T16:50:45Z` | `05-actions.txt:1-21` | Operator action | Emergency scale-down attempted: FAILED due to shell word-splitting bug; 0 workloads scaled down; deleted stale `superset-dashboard-import` Job | Shell error: `error: You must provide one or more resources...` |
| `2026-11-11T16:56:01Z` | `04-recovery-timeline.txt:52` | PostgreSQL | Observed after gap: retained WAL drops to 14.88 GB, segments drop from 1371 to 892; disk drops to 70% | retained=14,881,064,864 B, active=false, segs=892, notRunning=65, taints=[disk-pressure], disk=33G/49G 70% |
| `2026-11-11T16:56:13Z` | `04-recovery-timeline.txt:53` | Slot status | Slot reports `active: f` | retained=14,881,071,328 B, active=f, segs=892, notRunning=65, taints=[disk-pressure], disk=33G/49G 70% |
| `2026-11-11T16:57:24Z` | `06-post-recovery.txt:9` | Node condition | `DiskPressure` transitions to False (`lastTransition=2026-11-11T16:57:24Z`), remaining False through end of capture | Kubelet marks node clean |
| `2026-11-11T16:57:47Z` | `04-recovery-timeline.txt:56` | Node taint | DiskPressure taint clears (`taints=[]`), remaining clear through end of capture | retained=14,881,235,888 B, active=f, segs=892, notRunning=60, taints=[], disk=34G/49G 72% |
| `2026-11-11T16:58:22Z` | `04-recovery-timeline.txt:57` | Workloads | Workloads restarting; notRunning drops to 55 | retained=14,881,260,592 B, active=f, segs=892, notRunning=55, taints=[], disk=37G/49G 79% |
| `2026-11-11T16:58:55Z` | `04-recovery-timeline.txt:58` | Workloads | notRunning drops to 52 | retained=14,881,277,160 B, active=f, segs=892, notRunning=52, taints=[], disk=38G/49G 82% |
| `2026-11-11T16:59:28Z` | `04-recovery-timeline.txt:59` | Workloads | Rapid recovery of pods: notRunning plunges from 52 to 18 | retained=14,881,292,936 B, active=f, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:03:42Z` | `04-recovery-timeline.txt:67` | `beluga_shop_slot` | Debezium reconnects (`active: t`); slot drains backlog | retained=13,187,214,328 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:04:14Z` | `04-recovery-timeline.txt:68` | `beluga_shop_slot` | Retained WAL rapidly clears down to ~2.47 GiB | retained=2,651,833,800 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:04:46Z` | `04-recovery-timeline.txt:69` | `beluga_shop_slot` | Retained WAL first drops below 1 GiB (168,974,344 B, ~161 MiB) | retained=168,974,344 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:05:27Z` | `06-post-recovery.txt:1-27` | Cluster & Connect | Post-recovery capture: slot caught up, connector RUNNING, WAL segments at 38 (620 MB), disk at 54% | retained=169,516,000 B, waldir=38 segs, disk=25G/49G 54%, pods=50 Running, 17 Completed, 1 Pending |
| `2026-11-11T18:02:01Z` | `08-post-fix-verification.txt:1` | Live verification capture | Verification capture after PR #399 (commit 2c1488f) | `max_slot_wal_keep_size=1GB`, connector=RUNNING tasks=RUNNING, publication: customers,orders,cdc_heartbeat |
| `2026-11-11T18:02:02Z` - `2026-11-11T18:04:18Z` | `08-post-fix-verification.txt:14-18` | `beluga_shop_slot` | 4 slot samples (45 s apart): confirmed_flush advanced 1->2 and 3->4 and is identical in samples 2 and 3; business-table counters are a single cumulative snapshot, not a delta | retained: 16,342,680 B -> 160,624 B -> 205,168 B -> 104,816 B; confirmed_flush: 5/6B01D8F0 -> 5/6B044460 -> 5/6B044460 -> 5/6B050050 |
| `2026-11-11T18:04:20Z` | `08-post-fix-verification.txt:27-32` | `tests/29-cdc-slot-wal-retention.sh` | First live test run: FAIL on nodefs free space | FAIL: master-1/nodefs free 17.17% below 20.0% (available 3,379,208,192 B); retained_bytes=105,000, cap_bytes=1,073,741,824 |
| `2026-11-11T18:05:43Z` | `09-connect-log-growth.txt:234` | Node root filesystem | Operator deletes rotated `connect-service.log.2026-11-11-*` files | `/kafka/logs` dropped from 10,905,566,377 B to 11,428,491 B; `/dev/root` usage dropped from 16G (83%) to 5.1G (28%) |
| `2026-11-11T18:06:14Z` | `08-post-fix-verification.txt:34-39` | `tests/29-cdc-slot-wal-retention.sh` | Second live test run: PASS | PASS: master-1/nodefs free 72.52% (available 14,273,028,096 B); retained_bytes=16,371,808, cap_bytes=1,073,741,824 |

## Contributing Conditions Observed

Two conditions consuming node disk space were observed, on different filesystems (`/dev/vdb1`, `/dev/root`). A link between them via Kafka unreachability is not ruled out. Their relative contribution and ordering (which condition crossed the kubelet eviction threshold first) are NOT established.

### Condition (a): Replication Slot WAL Retention on Data Disk (`/dev/vdb1`)

#### 1. Slot Retained Bytes and WAL Segment Count vs Database Sizes
- Evidence (`03-postgres-slot.txt:3,10`):
  - Replication slot `beluga_shop_slot` retained `22,852,328,992` bytes (~21.28 GiB, ~22.85 GB).
  - WAL directory (`waldir`) held 1365 WAL segment files totaling `22,884,122,975` bytes (~22.88 GB).
- Evidence (`03-postgres-slot.txt:12-20`):
  - `lakekeeper`: 27,012,243 bytes (~25.76 MB)
  - `openmetadata`: 26,094,739 bytes (~24.89 MB)
  - `beluga_meta`: 20,655,251 bytes (~19.70 MB)
  - `keycloak`: 16,051,347 bytes (~15.31 MB)
  - `openfga`: 8,260,755 bytes (~7.88 MB)
  - `shop`: 8,055,955 bytes (~7.68 MB)
  - `template1`: 7,900,307 bytes
  - `postgres`: 7,826,579 bytes
  - `template0`: 7,668,239 bytes
  - **Total database data size**: ~124 MB across all databases. The database `shop` itself was only ~7.68 MB. While business data required under 8 MB, PostgreSQL retained 22.88 GB of WAL files with 22.85 GB retained by replication slot `beluga_shop_slot` (`03-postgres-slot.txt:3,10`).

#### 2. Transaction Commit Activity: Idle `shop` vs Active Shared Databases
- Evidence (`03-postgres-slot.txt:22-30`):
  - `beluga_meta`: `xact_commit = 11,919,884`, `tup_inserted = 296`, `tup_updated = 271,233`, `tup_deleted = 10`
  - `openfga`: `xact_commit = 6,306,884`, `tup_inserted = 60`, `tup_updated = 0`, `tup_deleted = 12`
  - `lakekeeper`: `xact_commit = 651,751`, `tup_inserted = 20,099`, `tup_updated = 55,336`, `tup_deleted = 6,919`
  - `keycloak`: `xact_commit = 138,584`, `tup_inserted = 15,299`, `tup_updated = 3,603`, `tup_deleted = 15,239`
  - `shop`: `xact_commit = 49,015`, `tup_inserted = 0`, `tup_updated = 57`, `tup_deleted = 0`
- Analysis: In PostgreSQL, all databases hosted within the same instance share a single, unified Write-Ahead Logging stream. System workloads (`beluga_meta` and `openfga`) committed over 18.2 million transactions (cumulative counters), consistent with advancing the shared write head to `pg_current_wal_lsn() = 5/560399F8`. Meanwhile, the `shop` database was largely idle with only 57 tuple updates.

#### 3. Unlimited Slot WAL Retention (`max_slot_wal_keep_size = -1`)
- Evidence:
  - `03-postgres-slot.txt:5`: `max_slot_wal_keep_size = -1`.
  - `gitops/charts/beluga-data/templates/02-cnpg.yaml:48-51` (on `origin/main`):
    ```yaml
        parameters:
          wal_level: "logical"
          max_wal_senders: "10"
          max_replication_slots: "10"
    ```
- Analysis: No `max_slot_wal_keep_size` parameter was declared in the CNPG cluster specification. It defaulted to PostgreSQL's system default of `-1` (unlimited). In this incident, WAL segments accumulated to 1365 files (22.88 GB, peaking at 1371 segments / 22.95 GB) while the slot was behind (`restart_lsn` at `0/3E8BBD8` vs instance WAL head at `5/560399F8`). By design, WAL needed by a replication slot is retained (upstream docs; not verified here).

#### 4. Missing Debezium Heartbeat Mechanism
- Evidence: `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:256-272` (on `origin/main`):
  ```json
  {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres-main-rw.database.svc.cluster.local",
    "database.port": "5432",
    "database.user": "beluga_admin",
    "database.password": "__PGPASSWORD__",
    "database.dbname": "shop",
    "topic.prefix": "cdc.shop",
    "plugin.name": "pgoutput",
    "slot.name": "beluga_shop_slot",
    "table.include.list": "public.orders,public.customers",
    "publication.autocreate.mode": "filtered",
    "decimal.handling.mode": "string",
    "snapshot.mode": "when_needed"
  }
  ```
- Analysis: The Debezium connector configured logical replication via `pgoutput` on database `shop` with publication filter `public.orders,public.customers`. Debezium advances its acknowledged LSN (`confirmed_flush_lsn`) only when it processes and commits change events emitted by the PostgreSQL logical decoding plugin (upstream behavior; not verified here). `shop` shows 0 inserts and 57 updates in cumulative counters (`03-postgres-slot.txt:22-30`), consistent with few or no change events reaching Debezium; event flow itself was not measured. No `heartbeat.interval.ms` or `heartbeat.action.query` was configured to write synthetic heartbeat transactions into `shop` (config fact above), and `confirmed_flush_lsn` was observed at `0/3E8BC10` while the instance WAL head was at `5/560399F8`.

#### 5. Circular Deadlock Mechanism (hypothesis)
Hypothesis only: the arrows show a proposed order that is consistent with the observations below but is not established; in particular step 4 (which filesystem crossed the kubelet threshold first) is not established.
```
+-----------------------------------------------------------------------------------+
| 1. Idle shop DB + No heartbeat -> Slot restart_lsn stagnant at 0/3E8BBD8           |
| 2. Other DBs commit millions of txns -> Global WAL advances to 5/560399F8        |
| 3. max_slot_wal_keep_size=-1 -> 1365 WAL segments (22.88 GB) pinned in pg_wal     |
| 4. Data disk /dev/vdb1 at 98-99% -> DiskPressure taint observed                    |
| 5. Evictions observed; Kafka broker Pending (FailedScheduling)                   |
| 6. Debezium Connect cannot produce to Kafka -> Connector inactive (active: false) |
| 7. Slot cannot advance flush LSN -> PostgreSQL cannot prune WAL                   |
+-----------------------------------------------------------------------------------+
```
The observed evidence is consistent with a circular deadlock:
- **Taint and Kafka pod scheduling**: A `node.kubernetes.io/disk-pressure` taint was present (consistent with node disk pressure; which filesystem crossed the kubelet threshold first is not established). Kafka broker pods (`beluga-kafka-mixed-0`) did not tolerate the taint, with 217 `FailedScheduling` events and remaining `Pending` while the taint was present (`01-k8s-events.txt:3`, `03-postgres-slot.txt`, `04-recovery-timeline.txt`, and `07-orchestrator-actions-before-capture.txt`, which is a reconstruction from the session transcript, not a live capture).
- **Slot active flag transitions**: The slot's `active` flag was observed flipping between `true` and `false` across the monitoring period in `04-recovery-timeline.txt` (`active=true` at `16:21:21Z`-`16:21:59Z`, flipping to `false` at `16:22:36Z`; briefly `true` at `16:31:17Z`-`16:31:54Z`, flipping to `false` at `16:32:32Z`; `true` at `16:49:08Z`-`16:49:42Z`, `false`/`f` at `16:56:01Z`-`17:03:11Z`, and `t` at `17:03:42Z`-`17:04:46Z`).
- **Retained bytes reductions**: Every decrease observed in `04-recovery-timeline.txt` starts at or after a sample where the taint was absent (the taint was present again at `16:49:42Z`, and the `16:49:42Z`-`16:56:01Z` gap has no samples, so the decrease inside that gap cannot be attributed):
  1. `16:48:33Z` to `16:49:42Z` (following taint clearance at `16:48:33Z`, retained bytes dropped from 22,952,901,728 B to 22,699,657,080 B at `16:49:08Z` and 21,492,253,680 B at `16:49:42Z`, and into the `16:49:42Z`-`16:56:01Z` interval where retained bytes reached 14,881,064,864 B).
  2. `17:03:11Z` to `17:04:46Z` (after taint cleared at `16:57:47Z`, retained bytes dropped from 14,898,146,704 B to 13,187,214,328 B at `17:03:42Z`, 2,651,833,800 B at `17:04:14Z`, and 168,974,344 B at `17:04:46Z`).
From `16:21:21Z` to `16:48:33Z` retained bytes only increased (22,868,891,728 B to 22,952,901,728 B); the taint was present at most samples in that window and absent at some (`16:29:07Z`, `16:38:41Z`), so taint absence alone did not coincide with a decrease. In post-recovery verification (`06-post-recovery.txt:25`), the connector ended in `RUNNING` status (`shop-cdc connector=RUNNING tasks=RUNNING`).

### Condition (b): Unbounded Connect File Logging on Root Disk (`/dev/root`)

- Evidence (`09-connect-log-growth.txt:1-236`):
  - In `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:187-188` (on `origin/main`), the `debezium-connect` Deployment declared a volume `kafka-logs` backed by an `emptyDir` with no `sizeLimit`:
    ```yaml
              volumeMounts:
                - name: kafka-logs
                  mountPath: /kafka/logs
          volumes:
            - name: kafka-logs
              emptyDir: {}
    ```
  - Pod `debezium-connect-848597646b-p8hqz` (UID `52af5d05-2cd9-4a8d-93ef-4b249cbe98b8`, started `2026-11-04T14:26:29Z`) had its emptyDir directory located on the node root filesystem (`/dev/root`, nodefs) under `/var/lib/kubelet/pods/52af5d05-2cd9-4a8d-93ef-4b249cbe98b8` occupying `10,650,708` KiB (~10.9 GB, ~10.16 GiB) (`09-connect-log-growth.txt:5,8`).
  - Total directory size of `/kafka/logs` reached `10,905,566,377` bytes across 140 files (`09-connect-log-growth.txt:10-11`).
  - While normal daily logging produced 1,630,968 B to 3,356,874 B per day (224,639 B on partial day 2026-11-05), connect logging on 2026-11-11 produced `10,894,138,431` bytes (`09-connect-log-growth.txt:154-160`).
  - The first oversized hourly file occurred in hour 00 (`connect-service.log.2026-11-11-00`, `143,639,341` bytes). The onset excerpt (lines 140-170 of that file; `09-connect-log-growth.txt:198-230`) begins with INFO-level disconnect/fetch errors at `2026-11-11T00:02:03,697` and `00:02:06,022` (`:199-212`); `2026-11-11T00:02:14,306` is the first line matching the capture's grep pattern: `WARN [Producer clientId=debezium-cluster-configs] Error connecting to node beluga-kafka-mixed-0... java.net.UnknownHostException: beluga-kafka-mixed-0.beluga-kafka-kafka-brokers.streaming.svc: Name or service not known` (`:166-167,215-216`). Hours 01..06 were normal-sized (`67,939` to `67,956` bytes each; `:175-180`); sustained growth starts in hour 07 (`591,711,275` bytes; `:181`).
  - From hour 07 through hour 16, hourly log files ranged from 591,711,275 B to 1,345,036,745 B, with 8 of 10 hours exceeding 1 GB each (e.g. hour 08: 1,177,328,424 B; hour 09: 1,168,445,777 B; hour 10: 1,065,680,970 B; hour 11: 1,345,036,745 B; hour 12: 1,054,481,193 B; hour 13: 1,090,463,269 B; hour 15: 1,102,514,791 B; hour 16: 1,238,462,178 B) (`09-connect-log-growth.txt:141-150`).
  - Message class counts for `connect-service.log.2026-11-11-11` (`09-connect-log-growth.txt:230-233`). The three numbers are unlabelled in the file and are attributed here in capture-command order: `23,649` (`grep -c "Error connecting to node"`), `16,603` (`grep -c "NoRouteToHostException"`), `4,674,860` (`wc -l`, total lines). The 4,674,860 figure is the total line count, not a single message class.
  - Root filesystem usage reached 16G of 19G (83% used, 3.2G available) before cleanup (`09-connect-log-growth.txt:3`).
- Analysis: No `sizeLimit` was declared on the `kafka-logs` emptyDir (config fact above). Gigabyte-scale connect log output on nodefs is consistent with contributing to nodefs exhaustion. `09-connect-log-growth.txt` was captured after recovery (root filesystem 83% used, 3.2G available at capture, `:3`) and does not establish ordering relative to the `/dev/vdb1` pressure, or whether nodefs crossed the kubelet threshold. That the log volume came from connection retry loops is also not established: `:231-233` count `Error connecting to node` and `NoRouteToHostException` matches (23,649 and 16,603) against 4,674,860 total lines in the hour-11 file.

## Impact

- **Terminated pod count before cleanup**:
  - The orchestrator observed **1032 pod objects** in the cluster, of which **982 terminated pod objects** (719 Failed, 263 Succeeded) were purged before live capture started (source: `07-orchestrator-actions-before-capture.txt`, a reconstruction from the session transcript, not a live capture).
  - Raw evidence in `01-k8s-events.txt` captured **100 `Evicted` events** and **217 `FailedScheduling` events**.
  - In `04-recovery-timeline.txt:2-52`, unhealthy pods not in Running state reached a peak of **65 pods**.
- **Impacted components across namespaces**:
  - `streaming`: Kafka broker `beluga-kafka-mixed-0` and `beluga-kafka-mixed-1`, Entity Operator `beluga-kafka-entity-operator`, Flink cluster `flink-cluster`, Flink operator `flink-kubernetes-operator`.
  - `analytics`: Trino coordinator `trino-coordinator`, Superset `superset`, Superset import job `superset-dashboard-import`.
  - `metallb-system`: MetalLB speaker `metallb-frr-k8s-rbv22`, MetalLB controller `metallb-controller`.
  - `kube-system`: Cilium operator `cilium-operator`.
  - Ingestion pipeline: Debezium connector `shop-cdc` stopped streaming changes.

## Recovery Actions Taken

The incident was remediated through the following sequential operations:

1. **Execution of no-op UPDATE on `shop.orders` (prior to live capture)**:
   - *Action*: Executed an update against an existing order in database `shop`: `update orders set status = status where order_id = (select min(order_id) from orders);` (source: `07-orchestrator-actions-before-capture.txt`, a reconstruction from the session transcript, not a live capture). The row before update was `order_id=1, status=COMPLETED, total_amount=150.00`.
   - *Evidence / Observation*: `06-post-recovery.txt:26-27` checked this row in downstream `lake.orders` and confirmed it was unaffected (`1|COMPLETED|150.00`).
   - *Outcome*: As recorded in 07, the slot's retained bytes did not decrease during ~4 minutes of polling right after the update while Kafka pods were Pending, and whether this UPDATE contributed to the later catch-up is unknown.
2. **Deletion of Failed / Succeeded pod objects (prior to live capture)**:
   - *Action*: Deleted 982 accumulated terminated pod objects from the cluster (`kubectl delete pods -A --field-selector=status.phase=Failed` [719 pods] and `status.phase=Succeeded` [263 pods]).
   - *Evidence*: `07-orchestrator-actions-before-capture.txt` (reconstructed from the session transcript, not a live capture). Pod objects dropped from 1032 before to 51 after (30 Running, 21 Pending).
   - *Rationale*: Intended to relieve etcd pressure and k3s node storage overhead attributed to accumulated eviction artifacts; the effect was not measured.
3. **Container runtime image pruning & exited container cleanup (prior to live capture)**:
   - *Action*: Attempted `k3s crictl rmi --prune` and removed exited container instances.
   - *Evidence*: `07-orchestrator-actions-before-capture.txt` (reconstructed from the session transcript, not a live capture) records that `crictl rmi --prune` deleted 0 images because required pods referenced them, while removal of exited containers observed the disk-pressure taint clearing once with 14 pods entering `ContainerCreating`. `01-k8s-events.txt:286,301-302` separately record that kubelet's image GC freed 0 bytes.
4. **Attempted scale-down of non-recovery workloads (FAILED)**:
   - *Action*: Attempted to scale down non-essential deployments to release resources for Kafka and Debezium.
   - *Evidence*: `05-actions.txt:1-21` explicitly records:
     ```
     # 2026-11-11T16:50:45Z emergency: scale down non-recovery workloads so Kafka/Debezium keep running
     error: You must provide one or more resources by argument or filename.
     ...
     job.batch "superset-dashboard-import" deleted from analytics namespace
     # NOTE: the scale-down commands above FAILED (shell word-splitting bug); nothing was scaled down. Only the stale superset-dashboard-import Job was deleted.
     ```
   - *Fact*: Due to a shell variable expansion bug, the scale-down commands failed completely and scaled nothing down. Only the stale batch Job `superset-dashboard-import` was deleted.
5. **Manual `CHECKPOINT` execution**:
   - *Action*: Executed `CHECKPOINT;` directly on PostgreSQL primary `postgres-main-1`.
   - *Evidence / Observed Sequence*: `04-recovery-timeline.txt` and `06-post-recovery.txt` show the observed sequence: retained WAL was 21.49 GB (`21,492,253,680` bytes) at `16:49:42Z`, dropped to 14.88 GB (`14,881,064,864` bytes) at `16:56:01Z`, and reached 168,974,344 bytes at `17:04:46Z`. WAL segment files dropped from 1371 to 892, and down to 38 segments (`06-post-recovery.txt:5`) after the final `CHECKPOINT`.
   - *Observation*: This sequence of WAL segment reclamation and disk usage reduction is consistent with the replication slot advancing.
6. **Replication slot preserved (NOT dropped)**:
   - *Action*: The replication slot `beluga_shop_slot` was **deliberately preserved and not dropped**.
   - *Evidence*: `04-recovery-timeline.txt:67-69` and `06-post-recovery.txt:3` show `beluga_shop_slot` transitioning to `active: t`, advancing its `restart_lsn` from `0/3E8BBD8` to `5/550061F8` and `confirmed_flush_lsn` to `5/55006C60`, reducing retained bytes to `169,516,000` bytes with status `reserved`.
   - *Rationale & Caveat*: The slot was kept so that Debezium could resume from its confirmed position without recreating the replication stream. Whether duplicate records or data loss occurred downstream was NOT verified.

## Result

### Before vs After Recovery Comparison

| Metric / Attribute | Pre-Recovery / Peak Value | Post-Recovery Value | Evidence Reference |
|---|---|---|---|
| **Slot Retained WAL Bytes** | 22,852,328,992 bytes (~22.85 GB) | 169,516,000 bytes (~169.5 MB) (first dropped <1 GiB to 168,974,344 B at `17:04:46Z`) | `03-postgres-slot.txt:3`, `04-recovery-timeline.txt:69`, `06-post-recovery.txt:3` |
| **WAL Segment Files** | 1365 segments (peaked at 1371 in `04:44`) | 38 segments in waldir | `03-postgres-slot.txt:10`, `04-recovery-timeline.txt:44`, `06-post-recovery.txt:5` |
| **Data Disk (`/dev/vdb1`) Usage** | 40G / 49G (85% in `02:10`, peaked at 46G / 99% in `04:51`) | 25G / 49G (54%) | `02-node-disk.txt:10`, `04-recovery-timeline.txt:51`, `06-post-recovery.txt:15` |
| **Node Taints** | `[node.kubernetes.io/disk-pressure]` (flapping in `04`) | `[]` (empty) | `04-recovery-timeline.txt`, `06-post-recovery.txt:12` |
| **DiskPressure Node Condition** | True (flapping; transition to False at `16:57:24Z`, remaining False in `06`) | False (`KubeletHasNoDiskPressure`) | `06-post-recovery.txt:9` |
| **Debezium Connector Status** | Inactive (`active: f`, Kafka unschedulable) | `shop-cdc connector=RUNNING tasks=RUNNING` | `03-postgres-slot.txt:3`, `06-post-recovery.txt:25` |
| **Replication Slot Status** | `active: f`, `wal_status: extended` | `active: t`, `wal_status: reserved` | `03-postgres-slot.txt:3`, `06-post-recovery.txt:3` |
| **Cluster Pod States** | 100 Evicted events, peak 65 pods notRunning | 50 Running, 17 Completed, 1 Pending | `01-k8s-events.txt`, `04-recovery-timeline.txt:52`, `06-post-recovery.txt:17-19` |
| **ArgoCD Application States** | Not captured during peak outage | `beluga-data` OutOfSync/Healthy, `beluga-platform` Synced/Healthy, `beluga-root` Synced/Healthy | `06-post-recovery.txt:21-23` |
| **Sample Data Verification (Row 1)** | Not verified prior to recovery | `lake.orders` row 1 unaffected: `1\|COMPLETED\|150.00` | `06-post-recovery.txt:26-27` |

### Post-Fix Live Verification

Live verification was captured at `2026-11-11T18:02:01Z` on the same colima cluster after PR #399 (commit `2c1488f901711df98b1c55e37bf3b2fcb279b9cc`) (`08-post-fix-verification.txt:1`):
- **PostgreSQL WAL Keep Cap**: `max_slot_wal_keep_size=1GB` (`08-post-fix-verification.txt:3`).
- **Heartbeat Configuration**: Selected connector configuration keys verified (`08-post-fix-verification.txt:5-9`):
  - `heartbeat.interval.ms=10000`
  - `heartbeat.action.query=INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`
  - `topic.heartbeat.prefix=__debezium-heartbeat`
  - `table.include.list=public.orders,public.customers,public.cdc_heartbeat`
  - `publication.autocreate.mode=filtered`
- **Connector and Publication State**:
  - `connector=RUNNING tasks=RUNNING` (`08-post-fix-verification.txt:11`).
  - Publication tables: `dbz_publication|customers,orders,cdc_heartbeat` (`08-post-fix-verification.txt:13`).
- **Replication Slot Advancement (4 Samples, 45 s apart)** (`08-post-fix-verification.txt:14-18`):
  ```
  2026-11-11T18:02:02Z | 2026-11-11 18:01:55.403193+00 | 5/6B01D8F0 5/6A08C888 5/6B022720 16342680
  2026-11-11T18:02:47Z | 2026-11-11 18:02:46.1918+00   | 5/6B044460 5/6B01FBB0 5/6B046F20 160624
  2026-11-11T18:03:33Z | 2026-11-11 18:03:26.799339+00 | 5/6B044460 5/6B01FBB0 5/6B051D20 205168
  2026-11-11T18:04:18Z | 2026-11-11 18:04:17.546492+00 | 5/6B050050 5/6B046650 5/6B05FFC0 104816
  ```
  `confirmed_flush_lsn` was `5/6B01D8F0` in sample 1, `5/6B044460` in samples 2 and 3 (identical), and `5/6B050050` in sample 4: it advanced between samples 1 and 2 and between samples 3 and 4, but not between samples 2 and 3. Retained WAL was between 104,816 B and 16,342,680 B in the four samples.
- **Shop Table Counters (single cumulative snapshot)** (`08-post-fix-verification.txt:19-22`):
  The `n_tup_ins/upd/del` counters are one cumulative snapshot, not a before/after delta (`orders` n_tup_upd=1, `customers` 0, `cdc_heartbeat` n_tup_upd=37). They do not by themselves show that business tables were unchanged during the sampling window:
  ```
  cdc_heartbeat|1|37|0
  customers|0|0|0
  orders|0|1|0
  ```
- **WAL Directory and Data Disk**:
  - `waldir`: 38 segments (`620,757,343` bytes) (`08-post-fix-verification.txt:24`).
  - `/dev/vdb1`: 49G total, 26G used, 21G avail, 56% on `/var/lib/rancher` (`08-post-fix-verification.txt:25`).
- **Automated Detection Test Execution (`tests/29-cdc-slot-wal-retention.sh`)**:
  - First run (`2026-11-12T03:04:20+0900` / `2026-11-11T18:04:20Z`) resulted in FAIL on nodefs headroom (`08-post-fix-verification.txt:27-32`):
    `FAIL CDC WAL: master-1/nodefs: free 17.17% below 20.0%`
    (with `slot=beluga_shop_slot retained_bytes=105000 cap_bytes=1073741824 confirmed_flush_lsn=5/6B050050 active=True`, `node=master-1 filesystem=nodefs available_bytes=3379208192 free_percent=17.17`, imagefs/containerfs free 42.61%).
  - Second run (`2026-11-12T03:06:14+0900` / `2026-11-11T18:06:14Z`, following connect log cleanup at `18:05:43Z`) resulted in PASS (`08-post-fix-verification.txt:34-39`):
    `PASS CDC WAL: heartbeat configured, bounded active slot, retained WAL and node free space within thresholds`
    (with `slot=beluga_shop_slot retained_bytes=16371808 cap_bytes=1073741824 confirmed_flush_lsn=5/6B08B3D8 active=True`, `node=master-1 filesystem=nodefs available_bytes=14273028096 free_percent=72.52`, imagefs/containerfs free 42.78%).
- **Recorded Deviation** (`08-post-fix-verification.txt:33`):
  ArgoCD did not re-run the Sync-hook Jobs `shop-seed` and `debezium-register-shop` for this revision (automated selective sync; a later full sync reported 'no more tasks'). The orchestrator ran both Jobs from the main-branch chart render (`helm template gitops/charts/beluga-data -f gitops/values/sso.yaml`) at about `2026-11-11T17:57Z`. Before that, the connector had no heartbeat settings and the publication lacked `cdc_heartbeat`.

## What Was NOT Verified

- **Downstream data consistency and potential duplicates or loss**: While `shop.orders id=1` was verified to be unaffected in `lake.orders` (`06-post-recovery.txt:27`), downstream data consistency was not verified. Full reconciliation across all downstream tables (`lake.orders`, `lake.customers`, Flink streaming state) was not performed, and whether duplicate events were emitted or messages were lost was not verified.
- **Contribution of no-op UPDATE**: As documented in `07-orchestrator-actions-before-capture.txt` (a reconstruction from the session transcript, not a live capture), the slot did not move for about 4 minutes while Kafka was Pending, and whether this UPDATE contributed to the later catch-up is unknown.
- **Exact wall-clock onset of disk accumulation**: Kubernetes events prior to `2026-11-11T15:23:58Z` are absent from the capture (an events retention limit is suspected, not verified). The exact timestamp when disk space first breached warning levels could not be determined.
- **Whether non-shop CDC events were delayed or dropped**: The platform relies on Flink pipelines reading Kafka; whether any in-flight buffer drops occurred during Kafka's `FailedScheduling` window was not captured.
- **Ordering and relative contribution of the two disk consumers**: Whether replication slot WAL accumulation on `/dev/vdb1` or connect log growth on `/dev/root` crossed kubelet eviction thresholds first is not established.
- **Cause of Kafka unreachability in connect logs**: Kafka connection errors in `debezium-connect` began at `2026-11-11T00:02:14,306` (`09-connect-log-growth.txt:167`), hours before the first eviction event captured at `2026-11-11T15:23:58Z` (`01-k8s-events.txt:219`). The underlying cause of Kafka unreachability starting from ~00Z..~07Z was not established.
- **Whether log deletion removed evidence beyond preserved samples**: Rotated files `connect-service.log.2026-11-11-*` were deleted inside the pod at `2026-11-11T18:05:43Z` to reclaim root filesystem space (`09-connect-log-growth.txt:234`). Only the summarized counts and line samples in `09-connect-log-growth.txt` were preserved; whether deleted logs contained additional diagnostic evidence was not verified.

## Follow-up and Remediation

Based on changes in this repository and worktree:

1. **Debezium Heartbeat Mechanism**:
   - Configured `heartbeat.interval.ms: "10000"` and `heartbeat.action.query: "INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at"` in `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`.
   - Dedicated schema created in `gitops/charts/beluga-data/files/shop-schema.sql` with single-row constraint `CHECK (id = 1)` and ownership/permissions for `beluga_admin`.
   - *Status*: Merged in PR #399 and live-verified per `08-post-fix-verification.txt`.
2. **Dedicated Kafka Heartbeat Topics**:
   - Provisioned `cdc.shop.public.cdc_heartbeat` and `__debezium-heartbeat.cdc.shop` in `gitops/charts/beluga-data/templates/03-cdc-heartbeat-topics.yaml` with 1-day retention and hourly segment rolling.
   - *Status*: Merged in PR #399 and live-verified per `08-post-fix-verification.txt`.
3. **PostgreSQL Slot WAL Retention Cap**:
   - Added `max_slot_wal_keep_size: "1GB"` under `spec.postgresql.parameters` in `gitops/charts/beluga-data/templates/02-cnpg.yaml` (D-WAL-1). This bounds replication slot retention to 1 GB against the 5 GiB PGDATA PVC, sacrificing slot validity (`wal_status: lost`) in extreme lag scenarios rather than evicting the entire node.
   - *Status*: Merged in PR #399 and live-verified per `08-post-fix-verification.txt`.
4. **Automated Detection Test**:
   - Implemented `tests/29-cdc-slot-wal-retention.sh` and python unit test `tests/test_cdc_slot_wal_retention.py`, verifying heartbeat configuration, positive WAL caps, active slot status, retained WAL <1 GiB, and node free space >=20%. Added to `tests/run-all.sh`.
   - *Status*: Merged in PR #399 and live-verified per `08-post-fix-verification.txt`.
5. **Debezium Connect Log Retention and emptyDir Bounding**:
   - Bounding `kafka-logs` emptyDir volume with `sizeLimit` in `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml` and provisioning log4j retention configuration in `gitops/charts/beluga-data/files/connect-log4j.properties` (confirmed present via `git status --short`).
   - *Status*: Merged in PR #401; live-verified per `raw/10-post-log-fix-verification.txt` within the limits listed in the raw/10 section.
6. **Operational Recovery Runbook**:
   - Documented operational recovery procedures in `docs/runbooks/cdc-slot-wal-retention.md` and `docs/runbooks/cdc-slot-wal-retention-ko.md`.
   - Recorded architectural decisions and historical context in `docs/mistakes-log.md`.
   - *Status*: Merged in PR #399.
7. **Automated Continuous Alerting**:
   - *Status*: Open / Not implemented. VictoriaMetrics does not currently scrape CNPG's replication slot exporter metrics (port 9187) or filesystem thresholds, and no routing alert rules are currently provisioned in the cluster.

## Threats to Validity

- **Single dev cluster**: Observations were gathered exclusively from a single-node Colima k3s ARM64 virtual environment. Node eviction thresholds, scheduling preemption, and disk reclamation dynamics may behave differently on multi-node or cloud-managed Kubernetes topologies.
- **Single occurrence**: The incident reflects a single historical failure sequence observed on 2026-11-11; performance under varied database transaction rates was not observed.
- **Timeline polling resolution**: State transitions in `04-recovery-timeline.txt` were recorded via periodic shell polling about every 30 s (with some longer gaps, such as between `16:49:42Z` and `16:56:01Z`), so shorter transitions are not captured.
- **Kubernetes events retention limit**: Events prior to `15:23:58Z` are absent from the capture, consistent with the Kubernetes Events API default retention of about 1 hour (not verified here), limiting visibility into the initial onset of the disk accumulation.
- **Live verification scope**: While heartbeat and WAL cap fixes were merged in PR #399 and live-verified per `08-post-fix-verification.txt`, the connect log retention and volume bounding fix was merged in PR #401 and checked live per `raw/10-post-log-fix-verification.txt`; hourly rollover and behaviour during a Kafka outage remain unverified.
- **Ordering and relative contribution**: As noted, the relative contribution and ordering between the two disk consumers are not established.

## Post log-fix live verification (raw/10)

Captured `2026-11-11T19:04:45Z` after PR #401 (main `4b42b04`), from `raw/10-post-log-fix-verification.txt`. Observations only:

- Pod `debezium-connect-9665f6dbf-z7lsv`: `phase=Running`, `restarts=0`, started `2026-11-11T19:02:51Z`.
- Volumes: `kafka-logs sizeLimit=256Mi`, `tmp sizeLimit=128Mi`; container `ephemeral-storage` request `128Mi`, limit `512Mi`.
- Process arguments contain `log4j.configuration=file:/kafka/config/log4j.properties`; the mounted file starts with the `D-LOG-1` console-only header.
- `/kafka/logs` holds no files (`du -sk` reports `4`).
- Connector `shop-cdc`: `connector=RUNNING tasks=RUNNING`.
- `tests/29-cdc-slot-wal-retention.sh`: PASS with `connect_log_bytes=4096` (limit `209715200`), `retained_bytes=130824` (cap `1073741824`), nodefs `free_percent=72.57`, imagefs `free_percent=42.61`.

Not verified: behaviour across an hourly rollover or during a Kafka outage (the capture is about two minutes after pod start), kubelet enforcement of the ephemeral-storage limit, and container-runtime rotation of stdout logs.
