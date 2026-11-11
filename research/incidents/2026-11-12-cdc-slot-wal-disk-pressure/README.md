# Incident Report: CDC Replication Slot WAL Accumulation and Disk Pressure Eviction Deadlock

English | [한국어](README-ko.md)

## Summary

On 2026-11-11, an idle PostgreSQL database (`shop`) replication slot (`beluga_shop_slot`) used by Debezium CDC retained 22.85 GB of write-ahead logs (1365 WAL segments) across the shared PostgreSQL instance in a state consistent with missing heartbeat queries and an unlimited `max_slot_wal_keep_size=-1` configuration. Active transactions from other shared databases (`beluga_meta` and `openfga`) continuously advanced PostgreSQL's global WAL position, but the absence of change events on `shop` prevented Debezium from receiving records and advancing its confirmed flush LSN. The resulting disk exhaustion on `/dev/vdb1` (peaking at 99% utilization) caused kubelet to trigger mass pod evictions (100 Evicted events, 982 terminated pod objects purged per `07-orchestrator-actions-before-capture.txt`, a reconstruction from the session transcript, not a live capture) and apply `node.kubernetes.io/disk-pressure`, which prevented the Kafka broker pod from scheduling (`FailedScheduling`). The observed evidence is consistent with a circular deadlock where Debezium could not flush offsets while Kafka was Pending, and PostgreSQL could not reclaim WAL. Before live capture started, a no-op UPDATE was executed on `shop.orders` (`07-orchestrator-actions-before-capture.txt`); the slot did not move for about 4 minutes while Kafka was Pending, and whether it contributed to the later catch-up is unknown. The replication slot was not dropped. Recorded actions were pod purges, container cleanup and one manual CHECKPOINT (`07-orchestrator-actions-before-capture.txt`, a reconstruction). Separately, `04-recovery-timeline.txt` shows the slot becoming active again and retained WAL reaching 168.9 MB by `17:04:46Z`. No causal link between the actions and that drain is established by the evidence (reclaiming disk usage back to 54%, with the connector ending in RUNNING state per `06-post-recovery.txt`).

## Environment

- **Cluster topology**: Single-node Colima k3s development cluster (`colima-vz-arm64-k3s-single-node`, node `master-1`) (source: `02-node-disk.txt:1`, `01-k8s-events.txt:323`).
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

Built from raw evidence files `01-k8s-events.txt`, `04-recovery-timeline.txt`, `05-actions.txt`, and `06-post-recovery.txt`. Actions taken prior to live capture are documented in `07-orchestrator-actions-before-capture.txt`, which is a reconstruction from the session transcript, not a live capture.

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
| `2026-11-11T15:23:58Z` | `01-k8s-events.txt:32` | `streaming/flink-cluster-774ccc5dfc-k76s2` | First recorded pod eviction due to low ephemeral-storage | Evicted (threshold quantity: 2625973491, available: 4945768Ki) |
| `2026-11-11T15:54:11Z` | `01-k8s-events.txt:218` | `master-1` | `EvictionThresholdMet`: Attempting to reclaim ephemeral-storage | Kubelet begins aggressive reclamation |
| `2026-11-11T16:00:22Z` | `01-k8s-events.txt:219` | `master-1` | `FreeDiskSpaceFailed`: Failed to free disk space by deleting images | 86% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:05:22Z` | `01-k8s-events.txt:220` | `master-1` | `FreeDiskSpaceFailed`: Second failed image prune | 85% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:10:23Z` | `01-k8s-events.txt:221` | `master-1` | `FreeDiskSpaceFailed`: Third failed image prune | 94% of 48.9 GiB used, freed 0 bytes |
| `2026-11-11T16:10:36Z` | `01-k8s-events.txt:222` | `master-1` | `NodeHasDiskPressure`: Node condition set to DiskPressure | Taint `node.kubernetes.io/disk-pressure:NoSchedule` applied |
| `2026-11-11T16:17:23Z` | `01-k8s-events.txt:322` | `metallb-system/metallb-frr-k8s-rbv22` | Last recorded pod eviction in event capture buffer | The node had condition: [DiskPressure] |
| `2026-11-11T16:19:13Z` | `01-k8s-events.txt:323` | `master-1` | `NodeHasNoDiskPressure`: Temporary clearance after mass eviction | Node condition momentarily cleared |
| `2026-11-11T16:19:42Z` | `02-node-disk.txt:1` | Node filesystem | Disk snapshot captured during brief clearance | `/dev/vdb1` 40G/49G (85%), postgres PVC 22G, taints: [] |
| `2026-11-11T16:20:04Z` | `03-postgres-slot.txt:1` | `database/postgres-main-1` | Slot snapshot captured: `beluga_shop_slot` inactive, WAL pinned | retained=22,852,328,992 B, waldir=1365 segs (22.88 GB), `max_slot_wal_keep_size=-1` |
| `2026-11-11T16:21:21Z` | `04-recovery-timeline.txt:2` | Node & PostgreSQL | Timeline monitoring starts; DiskPressure taint returns under load | retained=22,868,891,728 B, active=true, segs=1366, notRunning=7, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:21:59Z` | `04-recovery-timeline.txt:3` | Workloads | Pod failure cascade accelerates | retained=22,869,097,976 B, active=true, segs=1366, notRunning=13, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:22:36Z` | `04-recovery-timeline.txt:4` | `beluga_shop_slot` | Slot becomes inactive (`active: false`); disk reaches 97% | retained=22,869,113,128 B, active=false, segs=1366, notRunning=20, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:09Z` | `04-recovery-timeline.txt:5` | Workloads | Unhealthy pods increase | retained=22,869,179,032 B, active=false, segs=1366, notRunning=26, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:41Z` | `04-recovery-timeline.txt:6` | Node filesystem | Kubelet pod eviction drops disk usage to 83%; notRunning reaches 31 | retained=22,869,195,328 B, active=false, segs=1366, notRunning=31, taints=[disk-pressure], disk=39G/49G 83% |
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

## Root Cause Chain

### 1. Slot Retained Bytes and WAL Segment Count vs Database Sizes
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

### 2. Transaction Commit Activity: Idle `shop` vs Active Shared Databases
- Evidence (`03-postgres-slot.txt:22-30`):
  - `beluga_meta`: `xact_commit = 11,919,884`, `tup_inserted = 296`, `tup_updated = 271,233`, `tup_deleted = 10`
  - `openfga`: `xact_commit = 6,306,884`, `tup_inserted = 60`, `tup_updated = 0`, `tup_deleted = 12`
  - `lakekeeper`: `xact_commit = 651,751`, `tup_inserted = 20,099`, `tup_updated = 55,336`, `tup_deleted = 6,919`
  - `keycloak`: `xact_commit = 138,584`, `tup_inserted = 15,299`, `tup_updated = 3,603`, `tup_deleted = 15,239`
  - `shop`: `xact_commit = 49,015`, `tup_inserted = 0`, `tup_updated = 57`, `tup_deleted = 0`
- Analysis: In PostgreSQL, all databases hosted within the same instance share a single, unified Write-Ahead Logging stream. System workloads (`beluga_meta` and `openfga`) committed over 18.2 million transactions, driving the instance write head forward to `pg_current_wal_lsn() = 5/560399F8`. Meanwhile, the `shop` database was largely idle with only 57 tuple updates.

### 3. Unlimited Slot WAL Retention (`max_slot_wal_keep_size = -1`)
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

### 4. Missing Debezium Heartbeat Mechanism
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
- Analysis: The Debezium connector configured logical replication via `pgoutput` on database `shop` with publication filter `public.orders,public.customers`. Debezium advances its acknowledged LSN (`confirmed_flush_lsn`) only when it processes and commits change events emitted by the PostgreSQL logical decoding plugin. Because no writes were occurring on `shop.orders` or `shop.customers`, the logical decoding stream produced zero events for Debezium to consume. Without `heartbeat.interval.ms` and `heartbeat.action.query` configured to write synthetic heartbeat transactions into `shop`, `confirmed_flush_lsn` remained stagnant at `0/3E8BC10` while the instance WAL head progressed to `5/560399F8`.

### 5. Circular Deadlock Mechanism
```
+-----------------------------------------------------------------------------------+
| 1. Idle shop DB + No heartbeat -> Slot restart_lsn stagnant at 0/3E8BBD8           |
| 2. Other DBs commit millions of txns -> Global WAL advances to 5/560399F8        |
| 3. max_slot_wal_keep_size=-1 -> 1365 WAL segments (22.88 GB) pinned in pg_wal     |
| 4. Data disk /dev/vdb1 fills to 98-99% -> Kubelet applies DiskPressure taint      |
| 5. Mass evictions trigger -> Kafka broker evicted & cannot schedule (Pending)    |
| 6. Debezium Connect cannot produce to Kafka -> Connector inactive (active: false) |
| 7. Slot cannot advance flush LSN -> PostgreSQL cannot prune WAL                   |
+-----------------------------------------------------------------------------------+
```
The observed evidence is consistent with a circular deadlock:
- **Taint and Kafka pod scheduling**: The node disk exhaustion triggered a `node.kubernetes.io/disk-pressure` taint. Kafka broker pods (`beluga-kafka-mixed-0`) did not tolerate the taint, resulting in 217 `FailedScheduling` events and remaining `Pending` while the taint was present (`01-k8s-events.txt:3`, `03-postgres-slot.txt`, `04-recovery-timeline.txt`, and `07-orchestrator-actions-before-capture.txt`, which is a reconstruction from the session transcript, not a live capture).
- **Slot active flag transitions**: The slot's `active` flag was observed flipping between `true` and `false` across the monitoring period in `04-recovery-timeline.txt` (`active=true` at `16:21:21Z`-`16:21:59Z`, flipping to `false` at `16:22:36Z`; briefly `true` at `16:31:17Z`-`16:31:54Z`, flipping to `false` at `16:32:32Z`; `true` at `16:49:08Z`-`16:49:42Z`, `false`/`f` at `16:56:01Z`-`17:03:11Z`, and `t` at `17:03:42Z`-`17:04:46Z`).
- **Retained bytes reductions**: Every decrease observed in `04-recovery-timeline.txt` starts at or after a sample where the taint was absent (the taint was present again at `16:49:42Z`, and the `16:49:42Z`-`16:56:01Z` gap has no samples, so the decrease inside that gap cannot be attributed):
  1. `16:48:33Z` to `16:49:42Z` (following taint clearance at `16:48:33Z`, retained bytes dropped from 22,952,901,728 B to 22,699,657,080 B at `16:49:08Z` and 21,492,253,680 B at `16:49:42Z`, and into the `16:49:42Z`-`16:56:01Z` interval where retained bytes reached 14,881,064,864 B).
  2. `17:03:11Z` to `17:04:46Z` (after taint cleared at `16:57:47Z`, retained bytes dropped from 14,898,146,704 B to 13,187,214,328 B at `17:03:42Z`, 2,651,833,800 B at `17:04:14Z`, and 168,974,344 B at `17:04:46Z`).
From `16:21:21Z` to `16:48:33Z` retained bytes only increased (22,868,891,728 B to 22,952,901,728 B); the taint was present at most samples in that window and absent at some (`16:29:07Z`, `16:38:41Z`), so taint absence alone did not coincide with a decrease. In post-recovery verification (`06-post-recovery.txt:25`), the connector ended in `RUNNING` status (`shop-cdc connector=RUNNING tasks=RUNNING`).

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
   - *Rationale*: Relieved etcd pressure and k3s node storage overhead caused by cascading eviction artifacts.
3. **Container runtime image pruning & exited container cleanup (prior to live capture)**:
   - *Action*: Attempted `k3s crictl rmi --prune` and removed exited container instances.
   - *Evidence*: `07-orchestrator-actions-before-capture.txt` (reconstructed from the session transcript, not a live capture) records that `crictl rmi --prune` deleted 0 images because required pods referenced them, while removal of exited containers observed the disk-pressure taint clearing once with 14 pods entering `ContainerCreating`. `01-k8s-events.txt:219-221` separately records that kubelet's image GC freed 0 bytes.
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

## What Was NOT Verified

- **Downstream data consistency and potential duplicates or loss**: While `shop.orders id=1` was verified to be unaffected in `lake.orders` (`06-post-recovery.txt:27`), downstream data consistency was not verified. Full reconciliation across all downstream tables (`lake.orders`, `lake.customers`, Flink streaming state) was not performed, and whether duplicate events were emitted or messages were lost was not verified.
- **Contribution of no-op UPDATE**: As documented in `07-orchestrator-actions-before-capture.txt` (a reconstruction from the session transcript, not a live capture), the slot did not move for about 4 minutes while Kafka was Pending, and whether this UPDATE contributed to the later catch-up is unknown.
- **Exact wall-clock onset of disk accumulation**: Kubernetes event history retention truncated events prior to `2026-11-11T15:23:58Z`. The exact timestamp when disk space first breached warning levels could not be determined.
- **Whether non-shop CDC events were delayed or dropped**: The platform relies on Flink pipelines reading Kafka; whether any in-flight buffer drops occurred during Kafka's `FailedScheduling` window was not captured.
- **Live verification of permanent repository changes**: Permanent code additions in this worktree (heartbeat topics, CNPG WAL keep size limit, detection test) have been verified via static and template validation, but live-cluster end-to-end verification remains pending.

## Follow-up and Remediation

Based on changes present in this worktree's diff (`git status --short` and `git diff --stat`):

1. **Debezium Heartbeat Mechanism**:
   - Configured `heartbeat.interval.ms: "10000"` and `heartbeat.action.query: "INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at"` in `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`.
   - Dedicated schema created in `gitops/charts/beluga-data/files/shop-schema.sql` with single-row constraint `CHECK (id = 1)` and ownership/permissions for `beluga_admin`.
   - *Status*: Implemented in the same change, live verification pending.
2. **Dedicated Kafka Heartbeat Topics**:
   - Provisioned `cdc.shop.public.cdc_heartbeat` and `__debezium-heartbeat.cdc.shop` in `gitops/charts/beluga-data/templates/03-cdc-heartbeat-topics.yaml` with 1-day retention and hourly segment rolling.
   - *Status*: Implemented in the same change, live verification pending.
3. **PostgreSQL Slot WAL Retention Cap**:
   - Added `max_slot_wal_keep_size: "1GB"` under `spec.postgresql.parameters` in `gitops/charts/beluga-data/templates/02-cnpg.yaml` (D-WAL-1). This bounds replication slot retention to 1 GB against the 5 GiB PGDATA PVC, sacrificing slot validity (`wal_status: lost`) in extreme lag scenarios rather than evicting the entire node.
   - *Status*: Implemented in the same change, live verification pending.
4. **Automated Detection Test**:
   - Implemented `tests/29-cdc-slot-wal-retention.sh` and python unit test `tests/test_cdc_slot_wal_retention.py`, verifying heartbeat configuration, positive WAL caps, active slot status, retained WAL <1 GiB, and node free space >=20%. Added to `tests/run-all.sh`.
   - *Status*: Implemented in the same change, live verification pending.
5. **Operational Recovery Runbook**:
   - Documented operational recovery procedures in `docs/runbooks/cdc-slot-wal-retention.md` and `docs/runbooks/cdc-slot-wal-retention-ko.md`.
   - Recorded architectural decisions and historical context in `docs/mistakes-log.md`.
   - *Status*: Implemented in the same change, live verification pending.
6. **Automated Continuous Alerting**:
   - *Status*: Open / Not implemented. VictoriaMetrics does not currently scrape CNPG's replication slot exporter metrics (port 9187) or filesystem thresholds, and no routing alert rules are currently provisioned in the cluster.

## Threats to Validity

- **Single dev cluster**: Observations were gathered exclusively from a single-node Colima k3s ARM64 virtual environment. Node eviction thresholds, scheduling preemption, and disk reclamation dynamics may behave differently on multi-node or cloud-managed Kubernetes topologies.
- **Single occurrence**: The incident reflects a single historical failure sequence observed on 2026-11-11; performance under varied database transaction rates was not observed.
- **Timeline polling resolution**: State transitions in `04-recovery-timeline.txt` were recorded via periodic shell polling about every 30 s (with some longer gaps, such as between `16:49:42Z` and `16:56:01Z`), so shorter transitions are not captured.
- **Kubernetes events retention limit**: Because the Kubernetes Events API retains historical events for only 1 hour by default, early events prior to `15:23:58Z` were evicted from the API buffer, limiting visibility into the initial onset of the disk accumulation.
