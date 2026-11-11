# 장애 보고서: CDC 복제 슬롯 WAL 적체 및 디스크 압박 Eviction 교착 장애

[English](README.md) | 한국어

## 요약

2026-11-11, 단일 인스턴스를 공유하는 PostgreSQL 환경에서 Debezium CDC가 사용하는 유휴 데이터베이스(`shop`)의 논리 복제 슬롯(`beluga_shop_slot`)이 하트비트 쿼리 부재 및 무제한 `max_slot_wal_keep_size=-1` 설정과 부합하는 상태에서 22.85 GB의 WAL(1365개 세그먼트)을 보존했습니다. 공유 인스턴스의 다른 DB(`beluga_meta`, `openfga`)는 수백만 건의 커밋으로 전역 WAL LSN을 계속 전진시켰으나, `shop` DB에는 변경 트래픽이 없어 Debezium이 레코드를 소비하지 못하고 확인 플러시 LSN(confirmed_flush_lsn)이 전진하지 못했습니다. 그 결과 데이터 디스크(`/dev/vdb1`, 사용률 최대 99%)가 고갈되어 kubelet이 파드 대량 축출(100건 Evicted, 세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt` 기준 982개 종료 파드 객체 정리)을 유발하고 `node.kubernetes.io/disk-pressure` 테인트를 부여했습니다. 이로 인해 Kafka 브로커 파드가 스케줄링 불가(`FailedScheduling`, Pending)에 빠졌으며, 관측된 증거는 Kafka가 Pending인 동안 Debezium이 오프셋을 플러시하지 못하고 PostgreSQL이 WAL을 회수하지 못하는 순환 교착 상태와 부합합니다. 실시간 캡처 시작 전 `shop.orders`에 no-op UPDATE가 실행되었으나(세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt`), Kafka가 Pending인 약 4분 동안 슬롯은 움직이지 않았으며 이 UPDATE가 이후 캐치업에 기여했는지는 알 수 없습니다. 플랫폼은 슬롯을 삭제하지 않고 파드 정리, 컨테이너 정리, 수동 CHECKPOINT 수행을 거쳐 Kafka와 Debezium 스트리밍을 재개함으로써 잔여 WAL을 168.9 MB로 해소(디스크 사용률 54%로 회복, `06-post-recovery.txt` 기준 커넥터 RUNNING)하여 복구되었습니다.

## 환경

- **클러스터 토폴로지**: 단일 노드 Colima k3s 개발 클러스터 (`colima-vz-arm64-k3s-single-node`, 노드 `master-1`) (원천: `02-node-disk.txt:1`, `01-k8s-events.txt:323`).
- **파일시스템 `/dev/root`**: 전체 19G, 사용 15G, 가용 4.3G, 사용률 77%, 마운트 `/` (원천: `02-node-disk.txt:9`).
- **파일시스템 `/dev/vdb1` (데이터 / Rancher)**: 전체 49G, 감지 시점 사용 40G (85%), 가용 7.2G, 마운트 `/var/lib/rancher` (원천: `02-node-disk.txt:10`).
- **`/var/lib/rancher` 디스크 점유 내역** (원천: `02-node-disk.txt:11-17`):
  - 컨테이너 런타임: 17G (`/var/lib/rancher/k3s/agent/containerd`)
  - 볼륨 스토리지: 24G (`/var/lib/rancher/k3s/storage`)
  - PostgreSQL PVC (`pvc-b513f7fc-a2fd-4ba7-8c4b-ea78beeaefad_database_postgres-main-1`): 22G
  - SeaweedFS 스토리지 PVC (`pvc-afb95bd4-ec58-48f3-ac8c-c4532f88c49c_storage_seaweedfs-data-seaweedfs-0`): 712M
  - Beluga Manager DB PVC (`pvc-e81d26cc-b2f4-421f-ae29-691b61caffb0_platform-system_manager-db-1`): 591M
  - Kafka 메시지 버스 PVC (`pvc-4d14e2fe-e558-4fc0-9682-0302aa330fc8_streaming_data-0-beluga-kafka-mixed-0`): 140M
  - APISIX etcd PVC (`pvc-df397c1d-db7d-4809-a964-2fd2a1a385e3_platform-system_apisix-etcd-data`): 124M
- **최초 수집 시점 노드 상태** (`02-node-disk.txt:2-7`):
  - `NetworkUnavailable=False` (원인: `CiliumIsUp`, lastTransition: `2026-11-04T14:14:38Z`)
  - `MemoryPressure=False` (원인: `KubeletHasSufficientMemory`, lastTransition: `2026-11-04T14:13:58Z`)
  - `DiskPressure=False` (원인: `KubeletHasNoDiskPressure`, lastTransition: `2026-11-11T16:19:13Z`)
  - `PIDPressure=False` (원인: `KubeletHasSufficientPID`, lastTransition: `2026-11-04T14:13:58Z`)
  - `Ready=True` (원인: `KubeletReady`, lastTransition: `2026-11-04T14:13:58Z`)
  - `taints`: `16:19:42Z` 시점에 일시적으로 빈 값(축출 직후 일시 해소되었으나 워크로드 재개로 즉시 재발).

## 타임라인 (UTC)

원시 증거 파일 `01-k8s-events.txt`, `04-recovery-timeline.txt`, `05-actions.txt`, `06-post-recovery.txt`를 기반으로 작성되었습니다. 실시간 캡처 시작 전 수행된 조치는 세션 트랜스크립트로부터 재구성된 기록인 `07-orchestrator-actions-before-capture.txt`(실시간 캡처 아님)에 문서화되어 있습니다.

### `01-k8s-events.txt` 이벤트 분석
`01-k8s-events.txt` 전체 라인 수: 324행 (헤더 1행 `# captured 2026-11-11T16:19:40Z` + 이벤트 323행).
- `FailedScheduling`: 217건 (타임스탬프 `<nil>`, untolerated taint `node.kubernetes.io/disk-pressure`).
- `Evicted`: 100건 (최초 타임스탬프 `2026-11-11T15:23:58Z`, 최종 타임스탬프 `2026-11-11T16:17:23Z`).
- `FreeDiskSpaceFailed`: 3건 (`2026-11-11T16:00:22Z`, `2026-11-11T16:05:22Z`, `2026-11-11T16:10:23Z`).
- `EvictionThresholdMet`: 1건 (`2026-11-11T15:54:11Z`).
- `NodeHasDiskPressure`: 1건 (`2026-11-11T16:10:36Z`).
- `NodeHasNoDiskPressure`: 1건 (`2026-11-11T16:19:13Z`).

### 상태 전이 및 관측 시퀀스

| 타임스탬프 (UTC) | 원천 | 대상 / 범위 | 이벤트 / 상태 전이 설명 | 지표 (잔여 바이트 / 세그먼트 / 디스크 / 파드) |
|---|---|---|---|---|
| `2026-11-11T15:23:58Z` | `01-k8s-events.txt:32` | `streaming/flink-cluster-774ccc5dfc-k76s2` | ephemeral-storage 부족으로 인한 최초 파드 축출 기록 | Evicted (임계량: 2625973491, 가용: 4945768Ki) |
| `2026-11-11T15:54:11Z` | `01-k8s-events.txt:218` | `master-1` | `EvictionThresholdMet`: ephemeral-storage 회수 시도 | Kubelet 강제 회수 프로세스 시작 |
| `2026-11-11T16:00:22Z` | `01-k8s-events.txt:219` | `master-1` | `FreeDiskSpaceFailed`: 미사용 이미지 삭제로 디스크 공간 확보 실패 | 48.9 GiB 중 86% 사용, 확보된 용량 0바이트 |
| `2026-11-11T16:05:22Z` | `01-k8s-events.txt:220` | `master-1` | `FreeDiskSpaceFailed`: 2차 이미지 정리 실패 | 48.9 GiB 중 85% 사용, 확보된 용량 0바이트 |
| `2026-11-11T16:10:23Z` | `01-k8s-events.txt:221` | `master-1` | `FreeDiskSpaceFailed`: 3차 이미지 정리 실패 | 48.9 GiB 중 94% 사용, 확보된 용량 0바이트 |
| `2026-11-11T16:10:36Z` | `01-k8s-events.txt:222` | `master-1` | `NodeHasDiskPressure`: 노드 조건 DiskPressure 설정 | 테인트 `node.kubernetes.io/disk-pressure:NoSchedule` 부여 |
| `2026-11-11T16:17:23Z` | `01-k8s-events.txt:322` | `metallb-system/metallb-frr-k8s-rbv22` | 이벤트 캡처 버퍼 내 마지막 파드 축출 기록 | 노드 상태: [DiskPressure] |
| `2026-11-11T16:19:13Z` | `01-k8s-events.txt:323` | `master-1` | `NodeHasNoDiskPressure`: 대량 축출 후 일시적 해소 | 노드 상태 일시 정상화 |
| `2026-11-11T16:19:42Z` | `02-node-disk.txt:1` | 노드 파일시스템 | 일시 정상화 시점의 디스크 스냅샷 수집 | `/dev/vdb1` 40G/49G (85%), postgres PVC 22G, taints: [] |
| `2026-11-11T16:20:04Z` | `03-postgres-slot.txt:1` | `database/postgres-main-1` | 슬롯 스냅샷 수집: `beluga_shop_slot` 비활성, WAL 적체 | retained=22,852,328,992 B, waldir=1365 segs (22.88 GB), `max_slot_wal_keep_size=-1` |
| `2026-11-11T16:21:21Z` | `04-recovery-timeline.txt:2` | 노드 및 PostgreSQL | 복구 모니터링 개시; 워크로드 재개로 DiskPressure 테인트 재발 | retained=22,868,891,728 B, active=true, segs=1366, notRunning=7, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:21:59Z` | `04-recovery-timeline.txt:3` | 워크로드 | 파드 장애 확산 가속 | retained=22,869,097,976 B, active=true, segs=1366, notRunning=13, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:22:36Z` | `04-recovery-timeline.txt:4` | `beluga_shop_slot` | 슬롯 비활성화(`active: false`); 디스크 97% | retained=22,869,113,128 B, active=false, segs=1366, notRunning=20, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:09Z` | `04-recovery-timeline.txt:5` | 워크로드 | 미기동 파드 증가 | retained=22,869,179,032 B, active=false, segs=1366, notRunning=26, taints=[disk-pressure], disk=45G/49G 97% |
| `2026-11-11T16:23:41Z` | `04-recovery-timeline.txt:6` | 노드 파일시스템 | Kubelet 파드 축출로 디스크 일시적 83% 하락; notRunning=31 | retained=22,869,195,328 B, active=false, segs=1366, notRunning=31, taints=[disk-pressure], disk=39G/49G 83% |
| `2026-11-11T16:26:06Z` | `04-recovery-timeline.txt:10` | PostgreSQL | WAL 세그먼트 수 1367개로 증가 | retained=22,885,652,400 B, active=false, segs=1367, notRunning=31, taints=[disk-pressure], disk=39G/49G 83% |
| `2026-11-11T16:29:07Z` | `04-recovery-timeline.txt:15` | 노드 테인트 | DiskPressure 테인트 일시 해소 (`taints=[]`) | retained=22,885,854,744 B, active=false, segs=1367, notRunning=29, taints=[], disk=39G/49G 83% |
| `2026-11-11T16:29:49Z` | `04-recovery-timeline.txt:16` | 노드 파일시스템 | 파드 재시작으로 디스크 사용량 상승 | retained=22,885,875,192 B, active=false, segs=1367, notRunning=29, taints=[], disk=41G/49G 88% |
| `2026-11-11T16:30:27Z` | `04-recovery-timeline.txt:17` | 노드 파일시스템 | 디스크 사용률 96% 급등; notRunning=19 | retained=22,885,890,160 B, active=false, segs=1367, notRunning=19, taints=[], disk=45G/49G 96% |
| `2026-11-11T16:31:17Z` | `04-recovery-timeline.txt:18` | 노드 테인트 및 슬롯 | DiskPressure 테인트 재부여; 슬롯 일시 연결; segs=1368 | retained=22,902,443,272 B, active=true, segs=1368, notRunning=20, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:31:54Z` | `04-recovery-timeline.txt:19` | 워크로드 | notRunning=26으로 증가 | retained=22,902,525,680 B, active=true, segs=1368, notRunning=26, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:32:32Z` | `04-recovery-timeline.txt:20` | `beluga_shop_slot` | 슬롯 재단절 (`active: false`) | retained=22,902,542,864 B, active=false, segs=1368, notRunning=29, taints=[disk-pressure], disk=45G/49G 96% |
| `2026-11-11T16:33:15Z` | `04-recovery-timeline.txt:21` | 노드 파일시스템 | 축출 재개; notRunning=37 | retained=22,902,596,088 B, active=false, segs=1368, notRunning=37, taints=[disk-pressure], disk=43G/49G 91% |
| `2026-11-11T16:33:52Z` | `04-recovery-timeline.txt:22` | 노드 파일시스템 | 디스크 84% 하강; notRunning=42 | retained=22,902,674,152 B, active=false, segs=1368, notRunning=42, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:36:06Z` | `04-recovery-timeline.txt:26` | PostgreSQL | WAL 세그먼트 수 1369개로 증가 | retained=22,919,206,296 B, active=false, segs=1369, notRunning=42, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:38:41Z` | `04-recovery-timeline.txt:31` | 노드 테인트 | DiskPressure 테인트 2차 해소 (`taints=[]`) | retained=22,919,429,096 B, active=false, segs=1369, notRunning=42, taints=[], disk=39G/49G 84% |
| `2026-11-11T16:39:12Z` | `04-recovery-timeline.txt:32` | 노드 파일시스템 | 디스크 88% 재상승; notRunning=38 | retained=22,919,446,280 B, active=false, segs=1369, notRunning=38, taints=[], disk=41G/49G 88% |
| `2026-11-11T16:39:45Z` | `04-recovery-timeline.txt:33` | 노드 파일시스템 | 디스크 94% 재상승; notRunning=32 | retained=22,919,461,032 B, active=false, segs=1369, notRunning=32, taints=[], disk=44G/49G 94% |
| `2026-11-11T16:40:18Z` | `04-recovery-timeline.txt:34` | 노드 테인트 | DiskPressure 테인트 3차 재부여; 디스크 98% | retained=22,919,485,832 B, active=false, segs=1369, notRunning=27, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:40:58Z` | `04-recovery-timeline.txt:35` | PostgreSQL | WAL 세그먼트 수 1370개로 증가; notRunning=35 | retained=22,935,982,176 B, active=false, segs=1370, notRunning=35, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:41:37Z` | `04-recovery-timeline.txt:36` | 워크로드 | notRunning=40으로 증가 | retained=22,936,023,632 B, active=false, segs=1370, notRunning=40, taints=[disk-pressure], disk=46G/49G 98% |
| `2026-11-11T16:42:13Z` | `04-recovery-timeline.txt:37` | 노드 파일시스템 | 축출 재개; 디스크 91%; notRunning=46 | retained=22,936,124,976 B, active=false, segs=1370, notRunning=46, taints=[disk-pressure], disk=43G/49G 91% |
| `2026-11-11T16:42:47Z` | `04-recovery-timeline.txt:38` | 노드 파일시스템 | 디스크 86% 하강; notRunning=54 | retained=22,936,174,472 B, active=false, segs=1370, notRunning=54, taints=[disk-pressure], disk=40G/49G 86% |
| `2026-11-11T16:43:19Z` | `04-recovery-timeline.txt:39` | 노드 파일시스템 | 디스크 84% 도달; notRunning=54 유지 | retained=22,936,188,368 B, active=false, segs=1370, notRunning=54, taints=[disk-pressure], disk=39G/49G 84% |
| `2026-11-11T16:45:54Z` | `04-recovery-timeline.txt:44` | PostgreSQL | WAL 세그먼트 수 최고치 1371개 도달; notRunning=55 | retained=22,942,163,912 B, active=false, segs=1371, notRunning=55, taints=[disk-pressure], disk=39G/49G 85% |
| `2026-11-11T16:48:33Z` | `04-recovery-timeline.txt:49` | 노드 테인트 | DiskPressure 테인트 3차 해소 (`taints=[]`); notRunning=48 | retained=22,952,901,728 B, active=false, segs=1371, notRunning=48, taints=[], disk=42G/49G 89% |
| `2026-11-11T16:49:08Z` | `04-recovery-timeline.txt:50` | 슬롯 활동 | 슬롯 활성화(`active: true`); 잔여 WAL 감소 시작 | retained=22,699,657,080 B, active=true, segs=1371, notRunning=44, taints=[], disk=44G/49G 95% |
| `2026-11-11T16:49:42Z` | `04-recovery-timeline.txt:51` | 노드 테인트 및 슬롯 | DiskPressure 테인트 재부여; 디스크 최고치 99% 도달; 슬롯은 활성 유지 | retained=21,492,253,680 B, active=true, segs=1371, notRunning=41, taints=[disk-pressure], disk=46G/49G 99% |
| `2026-11-11T16:50:45Z` | `05-actions.txt:1-21` | 운영자 작업 | 비복구 워크로드 스케일다운 시도: 쉘 단어 분리 버그로 완전 실패; 0개 스케일다운; stale `superset-dashboard-import` Job만 삭제 | 쉘 오류: `error: You must provide one or more resources...` |
| `2026-11-11T16:56:01Z` | `04-recovery-timeline.txt:52` | PostgreSQL | 폴링 간격 후 관측: 잔여 WAL 14.88 GB로 감소, 세그먼트 1371개에서 892개로 감소, 디스크 70%로 감소 | retained=14,881,064,864 B, active=false, segs=892, notRunning=65, taints=[disk-pressure], disk=33G/49G 70% |
| `2026-11-11T16:56:13Z` | `04-recovery-timeline.txt:53` | 슬롯 상태 | 슬롯 일시 `active: f` 보고 | retained=14,881,071,328 B, active=f, segs=892, notRunning=65, taints=[disk-pressure], disk=33G/49G 70% |
| `2026-11-11T16:57:24Z` | `06-post-recovery.txt:9` | 노드 상태 | `DiskPressure` 조건 False 전이 (`lastTransition=2026-11-11T16:57:24Z`, 캡처 종료 시까지 False 유지) | Kubelet 노드 정상 표시 |
| `2026-11-11T16:57:47Z` | `04-recovery-timeline.txt:56` | 노드 테인트 | DiskPressure 테인트 해소 (`taints=[]`, 캡처 종료 시까지 해소 유지) | retained=14,881,235,888 B, active=f, segs=892, notRunning=60, taints=[], disk=34G/49G 72% |
| `2026-11-11T16:58:22Z` | `04-recovery-timeline.txt:57` | 워크로드 | 워크로드 재기동; notRunning=55 | retained=14,881,260,592 B, active=f, segs=892, notRunning=55, taints=[], disk=37G/49G 79% |
| `2026-11-11T16:58:55Z` | `04-recovery-timeline.txt:58` | 워크로드 | notRunning=52로 하강 | retained=14,881,277,160 B, active=f, segs=892, notRunning=52, taints=[], disk=38G/49G 82% |
| `2026-11-11T16:59:28Z` | `04-recovery-timeline.txt:59` | 워크로드 | 파드 급속 복구: notRunning이 52에서 18로 급감 | retained=14,881,292,936 B, active=f, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:03:42Z` | `04-recovery-timeline.txt:67` | `beluga_shop_slot` | Debezium 재연결 (`active: t`); 슬롯 백로그 처리 시작 | retained=13,187,214,328 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:04:14Z` | `04-recovery-timeline.txt:68` | `beluga_shop_slot` | 잔여 WAL 급속 드레인 (~2.47 GiB) | retained=2,651,833,800 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:04:46Z` | `04-recovery-timeline.txt:69` | `beluga_shop_slot` | 잔여 WAL이 최초로 1 GiB 미만(168,974,344 B, ~161 MiB)으로 하강 | retained=168,974,344 B, active=t, segs=892, notRunning=18, taints=[], disk=39G/49G 83% |
| `2026-11-11T17:05:27Z` | `06-post-recovery.txt:1-27` | 클러스터 및 Connect | 복구 후 상태 수집: 슬롯 정상 추적, 커넥터 RUNNING, WAL 세그먼트 38개(620 MB), 디스크 54% | retained=169,516,000 B, waldir=38 segs, disk=25G/49G 54%, pods=50 Running, 17 Completed, 1 Pending |

## 근본 원인 체인

### 1. 슬롯 잔여 바이트 및 WAL 세그먼트 수 대비 데이터베이스 크기 불균형
- 증거 (`03-postgres-slot.txt:3,10`):
  - 복제 슬롯 `beluga_shop_slot` 보존 바이트: `22,852,328,992` 바이트 (~21.28 GiB, ~22.85 GB).
  - WAL 디렉터리(`waldir`): 1365개 세그먼트 파일, 총 `22,884,122,975` 바이트 (~22.88 GB).
- 증거 (`03-postgres-slot.txt:12-20`):
  - `lakekeeper`: 27,012,243 바이트 (~25.76 MB)
  - `openmetadata`: 26,094,739 바이트 (~24.89 MB)
  - `beluga_meta`: 20,655,251 바이트 (~19.70 MB)
  - `keycloak`: 16,051,347 바이트 (~15.31 MB)
  - `openfga`: 8,260,755 바이트 (~7.88 MB)
  - `shop`: 8,055,955 바이트 (~7.68 MB)
  - `template1`: 7,900,307 바이트
  - `postgres`: 7,826,579 바이트
  - `template0`: 7,668,239 바이트
  - **전체 DB 데이터 크기**: 모든 DB를 합쳐도 약 124 MB에 불과하며 `shop` DB는 단 7.68 MB였습니다. 실 데이터 크기가 8 MB 미만임에도 복제 슬롯 `beluga_shop_slot`에 의해 22.85 GB가 보존되면서 총 22.88 GB의 WAL이 디스크에 유지되었습니다(`03-postgres-slot.txt:3,10`).

### 2. 트랜잭션 커밋 활동: 유휴 `shop` vs 활성 공유 데이터베이스
- 증거 (`03-postgres-slot.txt:22-30`):
  - `beluga_meta`: `xact_commit = 11,919,884`, `tup_inserted = 296`, `tup_updated = 271,233`, `tup_deleted = 10`
  - `openfga`: `xact_commit = 6,306,884`, `tup_inserted = 60`, `tup_updated = 0`, `tup_deleted = 12`
  - `lakekeeper`: `xact_commit = 651,751`, `tup_inserted = 20,099`, `tup_updated = 55,336`, `tup_deleted = 6,919`
  - `keycloak`: `xact_commit = 138,584`, `tup_inserted = 15,299`, `tup_updated = 3,603`, `tup_deleted = 15,239`
  - `shop`: `xact_commit = 49,015`, `tup_inserted = 0`, `tup_updated = 57`, `tup_deleted = 0`
- 분석: PostgreSQL은 단일 클러스터 내 모든 데이터베이스가 하나의 공유 WAL 스트림을 씁니다. 시스템 메타데이터 워크로드(`beluga_meta`, `openfga`)가 1,820만 건 이상의 커밋을 발생시키며 전역 WAL 위치를 `5/560399F8`까지 빠르게 전진시켰으나, `shop` DB는 57건의 갱신에 불과해 극도로 유휴했습니다.

### 3. 무제한 슬롯 WAL 보존 설정 (`max_slot_wal_keep_size = -1`)
- 증거:
  - `03-postgres-slot.txt:5`: `max_slot_wal_keep_size = -1`.
  - `gitops/charts/beluga-data/templates/02-cnpg.yaml:48-51` (`origin/main` 기준):
    ```yaml
        parameters:
          wal_level: "logical"
          max_wal_senders: "10"
          max_replication_slots: "10"
    ```
- 분석: CNPG 매니페스트에 `max_slot_wal_keep_size` 파라미터가 선언되지 않아 PostgreSQL 기본값인 `-1`(무제한)이 적용되었습니다. 본 장애에서는 슬롯이 뒤처져 있는 동안(`restart_lsn` `0/3E8BBD8` 대비 WAL 헤드 `5/560399F8`) WAL 세그먼트가 1365개 파일(22.88 GB, 피크 시 1371개 세그먼트 / 22.95 GB)까지 누적되었습니다. PostgreSQL 설계상 복제 슬롯이 필요로 하는 WAL은 보존됩니다(업스트림 공식 문서 기준; 본 건에서 직접 검증되지는 않음).

### 4. Debezium 하트비트 부재
- 증거: `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml:256-272` (`origin/main` 기준):
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
- 분석: Debezium 커넥터는 `shop` DB에 대해 `public.orders,public.customers` 대상의 필터링된 발행(`pgoutput`)을 구독하도록 구성되었습니다. Debezium은 발행 대상 테이블에 변경 레코드가 발생하여 이를 읽고 커밋할 때만 PostgreSQL에 확인 플러시 LSN(`confirmed_flush_lsn`)을 회신합니다. `shop` 비즈니스 테이블에 쓰기가 없었기 때문에 복제 스트림에서 이벤트가 발생하지 않았고, `heartbeat.interval.ms`와 `heartbeat.action.query`가 설정되지 않아 인스턴스 WAL 헤드가 `5/560399F8`로 전진하는 동안 `confirmed_flush_lsn`은 `0/3E8BC10`에 머물렀습니다.

### 5. 순환 교착(Deadlock) 메커니즘
```
+-----------------------------------------------------------------------------------+
| 1. 유휴 shop DB + 하트비트 부재 -> 슬롯 restart_lsn이 0/3E8BBD8에 정체             |
| 2. 타 DB 수백만 건 트랜잭션 -> 전역 WAL LSN이 5/560399F8로 계속 전진             |
| 3. max_slot_wal_keep_size=-1 -> 1365개 WAL 세그먼트(22.88 GB)가 pg_wal에 보존     |
| 4. 데이터 디스크 /dev/vdb1 사용률 98-99% 도달 -> Kubelet이 DiskPressure 테인트 부여 |
| 5. 대량 축출 발생 -> Kafka 브로커 축출 후 재스케줄링 실패 (FailedScheduling, Pending) |
| 6. Debezium Connect가 Kafka에 메시지 발행 불가 -> 커넥터 비활성화 (active: false) |
| 7. 슬롯 플러시 LSN 전진 불가 -> PostgreSQL WAL 정리 불가                          |
+-----------------------------------------------------------------------------------+
```
관측된 증거는 순환 교착 상태와 부합합니다:
- **테인트 및 Kafka 파드 스케줄링**: 노드 디스크 고갈로 `node.kubernetes.io/disk-pressure` 테인트가 부여되었습니다. Kafka 브로커 파드(`beluga-kafka-mixed-0`)는 해당 테인트를 용인하지 않아 217건의 `FailedScheduling` 이벤트가 발생하고 테인트가 존재하는 동안 `Pending` 상태를 유지했습니다(`01-k8s-events.txt:3`, `03-postgres-slot.txt`, `04-recovery-timeline.txt`, 및 세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt`).
- **슬롯 active 플래그 상태 전이**: 슬롯의 `active` 플래그는 `04-recovery-timeline.txt` 모니터링 전반에 걸쳐 `true`와 `false` 사이를 오가는 양상이 관측되었습니다(`16:21:21Z`~`16:21:59Z`에 `active=true`, `16:22:36Z`에 `false` 전이; `16:31:17Z`~`16:31:54Z`에 일시 `true`, `16:32:32Z`에 `false` 전이; `16:49:08Z`~`16:49:42Z`에 `true`, `16:56:01Z`~`17:03:11Z`에 `false`/`f`, `17:03:42Z`~`17:04:46Z`에 `t`).
- **잔여 바이트 감소 구간**: 잔여 바이트는 테인트가 해소된 이후의 특정 구간에서만 감소했습니다:
  1. `16:48:33Z` ~ `16:49:42Z` (`16:48:33Z` 테인트 해소 직후, 잔여 바이트가 22,952,901,728 B에서 `16:49:08Z` 22,699,657,080 B, `16:49:42Z` 21,492,253,680 B로 감소했고, `16:49:42Z`~`16:56:01Z` 간격에 걸쳐 14,881,064,864 B로 하락).
  2. `17:03:11Z` ~ `17:04:46Z` (`16:57:47Z` 테인트 해소 후, 잔여 바이트가 14,898,146,704 B에서 `17:03:42Z` 13,187,214,328 B, `17:04:14Z` 2,651,833,800 B, `17:04:46Z` 168,974,344 B로 급감).
테인트가 지속되던 구간에서는 잔여 바이트가 감소하지 않았습니다. 복구 후 최종 검증(`06-post-recovery.txt:25`)에서 커넥터는 `RUNNING` 상태(`shop-cdc connector=RUNNING tasks=RUNNING`)로 종료되었습니다.

## 장애 영향도

- **정리 전 비정상 파드 객체 수**:
  - 오케스트레이터 세션 기록 기준, 실시간 캡처 시작 전 클러스터 내 **1032개의 파드 객체**가 관측되었으며 이 중 **982개의 종료된 파드 객체**(Failed 719개, Succeeded 263개)가 삭제되었습니다 (원천: 세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt`, 실시간 캡처 아님).
  - 원시 증거 `01-k8s-events.txt`에는 **100건의 `Evicted` 이벤트**와 **217건의 `FailedScheduling` 이벤트**가 기록되었습니다.
  - 타임라인 `04-recovery-timeline.txt:2-52`에서 Running이 아닌 비정상 파드는 최대 **65개**까지 치솟았습니다.
- **영향을 받은 핵심 컴포넌트**:
  - `streaming`: Kafka 브로커 `beluga-kafka-mixed-0`, `beluga-kafka-mixed-1`, Entity Operator `beluga-kafka-entity-operator`, Flink 클러스터 `flink-cluster`, Flink 오퍼레이터 `flink-kubernetes-operator`.
  - `analytics`: Trino 코디네이터 `trino-coordinator`, Superset `superset`, 대시보드 임포트 Job `superset-dashboard-import`.
  - `metallb-system`: MetalLB speaker `metallb-frr-k8s-rbv22`, MetalLB 컨트롤러 `metallb-controller`.
  - `kube-system`: Cilium 오퍼레이터 `cilium-operator`.
  - 데이터 수집 파이프라인: Debezium `shop-cdc` 변경 데이터 캡처 전면 중단.

## 실제 수행된 복구 작업 내역

운영자가 순서대로 수행한 실제 복구 작업은 다음과 같습니다:

1. **`shop.orders`에 대한 no-op UPDATE 실행 (실시간 캡처 이전)**:
   - *작업*: 실시간 캡처 시작 전 `shop` DB의 기존 주문에 대해 갱신을 실행했습니다: `update orders set status = status where order_id = (select min(order_id) from orders);` (원천: 세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt`, 실시간 캡처 아님). 갱신 전 행 데이터는 `order_id=1, status=COMPLETED, total_amount=150.00`이었습니다.
   - *증거 및 관측*: `06-post-recovery.txt:26-27`에서 다운스트림 `lake.orders`의 해당 행이 영향받지 않았음(`1|COMPLETED|150.00`)을 확인했습니다.
   - *결과*: 07에 기록된 바와 같이, 실행 직후 Kafka 파드가 Pending인 약 4분 동안 슬롯의 보존 바이트는 줄어들지 않았으며, 이 UPDATE가 이후 캐치업에 기여했는지는 알 수 없습니다.
2. **Failed / Succeeded 종료 파드 객체 대량 삭제 (실시간 캡처 이전)**:
   - *작업*: 클러스터에 누적된 982개의 종료 파드 객체를 삭제했습니다(`status.phase=Failed` 719개 및 `status.phase=Succeeded` 263개).
   - *증거*: `07-orchestrator-actions-before-capture.txt` (세션 트랜스크립트 재구성 기록, 실시간 캡처 아님). 파드 객체 수가 작업 전 1032개에서 작업 후 51개(30 Running, 21 Pending)로 감소했습니다.
   - *의도*: 연쇄 축출로 인해 폭증한 etcd 부하와 k3s 로컬 메타데이터 점유를 해소했습니다.
3. **컨테이너 런타임 이미지 정리(`crictl rmi --prune`) 및 종료 컨테이너 삭제 (실시간 캡처 이전)**:
   - *작업*: `k3s crictl rmi --prune` 실행 및 중지된 컨테이너 정리를 시도했습니다.
   - *증거*: `07-orchestrator-actions-before-capture.txt` (세션 트랜스크립트 재구성 기록, 실시간 캡처 아님)에 따르면 모든 이미지가 참조 중이라 0개의 이미지가 삭제되었으나, 종료된 컨테이너 제거 후 disk-pressure 테인트가 1회 해소되고 14개 파드가 `ContainerCreating`에 진입한 것이 관측되었습니다. `01-k8s-events.txt:219-221`에서도 kubelet 이미지 GC가 0바이트를 확보한 것이 별도로 기록되었습니다.
4. **비복구 워크로드 스케일다운 시도 (실패)**:
   - *작업*: Kafka와 Debezium을 살리기 위해 비필수 워크로드 스케일다운을 시도했습니다.
   - *증거*: `05-actions.txt:1-21`에 그대로 기록됨:
     ```
     # 2026-11-11T16:50:45Z emergency: scale down non-recovery workloads so Kafka/Debezium keep running
     error: You must provide one or more resources by argument or filename.
     ...
     job.batch "superset-dashboard-import" deleted from analytics namespace
     # NOTE: the scale-down commands above FAILED (shell word-splitting bug); nothing was scaled down. Only the stale superset-dashboard-import Job was deleted.
     ```
   - *사실 확인*: 쉘 변수 확장(word-splitting) 버그로 인해 스케일다운 명령어가 모두 실패하여 단 하나의 워크로드도 스케일다운되지 않았습니다. 완료 후 방치된 배치 Job인 `superset-dashboard-import` 1개만 삭제되었습니다.
5. **수동 `CHECKPOINT` 실행**:
   - *작업*: PostgreSQL primary인 `postgres-main-1`에 직접 접속하여 `CHECKPOINT;`를 실행했습니다.
   - *증거 및 관측 시퀀스*: `04-recovery-timeline.txt` 및 `06-post-recovery.txt`에 기록된 관측 시퀀스는 다음과 같습니다: 보존 WAL은 `16:49:42Z`에 21.49 GB(`21,492,253,680` 바이트)였고, `16:56:01Z`에 14.88 GB(`14,881,064,864` 바이트)로 감소했으며, `17:04:46Z`에 168,974,344 바이트에 도달했습니다. WAL 세그먼트 파일 수는 1371개에서 892개로 감소한 후, 최종 `CHECKPOINT` 이후 38개 세그먼트(`06-post-recovery.txt:5`)까지 줄어들었습니다.
   - *관측 내용*: 이러한 WAL 세그먼트 회수 및 디스크 사용량 감소 시퀀스는 복제 슬롯 전진과 부합합니다.
6. **복제 슬롯 보존 (삭제하지 않음)**:
   - *작업*: 복제 슬롯 `beluga_shop_slot`을 **삭제하지 않고 유지**했습니다.
   - *증거*: `04-recovery-timeline.txt:67-69` 및 `06-post-recovery.txt:3`에서 슬롯명이 동일하게 유지되며 `active: t`, `restart_lsn`이 `0/3E8BBD8`에서 `5/550061F8`로, `confirmed_flush_lsn`이 `5/55006C60`으로 전진하고, 보존 바이트가 `169,516,000` 바이트(상태 `reserved`)로 정돈되었습니다.
   - *의도 및 유의사항*: Debezium이 확인된 위치에서 스트리밍을 재개할 수 있도록 슬롯을 유지했습니다. 다만 다운스트림의 중복 데이터 발생 또는 데이터 유실 여부는 검증되지 않았습니다.

## 결과

### 복구 전후 비교 표

| 지표 / 항목 | 복구 전 / 피크 수치 | 복구 후 수치 | 증거 원천 |
|---|---|---|---|
| **슬롯 잔여 WAL 바이트** | 22,852,328,992 바이트 (~22.85 GB) | 169,516,000 바이트 (~169.5 MB) (`17:04:46Z`에 168,974,344 B로 최초 1 GiB 미만 달성) | `03-postgres-slot.txt:3`, `04-recovery-timeline.txt:69`, `06-post-recovery.txt:3` |
| **WAL 세그먼트 파일 수** | 1365개 (피크 시점 `04:44`에 1371개) | 38개 (`waldir` 기준) | `03-postgres-slot.txt:10`, `04-recovery-timeline.txt:44`, `06-post-recovery.txt:5` |
| **데이터 디스크(`/dev/vdb1`) 사용량** | 40G / 49G (`02:10`에서 85%, 피크 시점 `04:51`에 46G / 99%) | 25G / 49G (54%) | `02-node-disk.txt:10`, `04-recovery-timeline.txt:51`, `06-post-recovery.txt:15` |
| **노드 테인트** | `[node.kubernetes.io/disk-pressure]` (`04`에서 요동) | `[]` (비어있음) | `04-recovery-timeline.txt`, `06-post-recovery.txt:12` |
| **노드 DiskPressure 조건** | True (요동; `16:57:24Z`에 False로 전환 후 `06` 캡처 시점까지 유지) | False (`KubeletHasNoDiskPressure`) | `06-post-recovery.txt:9` |
| **Debezium 커넥터 상태** | 비활성 (`active: f`, Kafka 스케줄 불가) | `shop-cdc connector=RUNNING tasks=RUNNING` | `03-postgres-slot.txt:3`, `06-post-recovery.txt:25` |
| **복제 슬롯 상태** | `active: f`, `wal_status: extended` | `active: t`, `wal_status: reserved` | `03-postgres-slot.txt:3`, `06-post-recovery.txt:3` |
| **클러스터 파드 기동 상태** | 100건 축출 이벤트, 비정상 파드 최대 65개 | 50 Running, 17 Completed, 1 Pending | `01-k8s-events.txt`, `04-recovery-timeline.txt:52`, `06-post-recovery.txt:17-19` |
| **ArgoCD Application 상태** | 장애 피크 시점 미수집 | `beluga-data` OutOfSync/Healthy, `beluga-platform` Synced/Healthy, `beluga-root` Synced/Healthy | `06-post-recovery.txt:21-23` |
| **샘플 데이터 확인 (1번 행)** | 복구 전 미확인 | `lake.orders` 1번 행 영향 없음: `1\|COMPLETED\|150.00` | `06-post-recovery.txt:26-27` |

## 미검증 사항

- **다운스트림 정합성 및 중복·유실 여부**: `shop.orders id=1` 행이 `lake.orders`에서 영향받지 않았음이 확인되었으나(`06-post-recovery.txt:27`), 다운스트림 데이터 정합성은 검증되지 않았습니다. 다운스트림 전체 테이블(`lake.orders`, `lake.customers`, Flink 스트리밍 상태)의 전수 대조는 수행되지 않았으며, 중복 데이터 유입이나 메시지 유실 발생 여부는 검증되지 않았습니다.
- **no-op UPDATE의 기여 여부**: 세션 트랜스크립트 재구성 기록인 `07-orchestrator-actions-before-capture.txt`(실시간 캡처 아님)에 명시된 바와 같이, UPDATE 실행 후 Kafka가 Pending인 약 4분 동안 슬롯은 움직이지 않았으며 이 UPDATE가 이후 캐치업에 기여했는지는 알 수 없습니다.
- **디스크 최초 누적 시점**: 쿠버네티스 Events API의 1시간 보존 정책으로 인해 `2026-11-11T15:23:58Z` 이전의 이벤트가 유실되어, 디스크가 최초로 경고 수준에 도달한 정확한 벽시계 시점은 확인되지 않았습니다.
- **CDC 이벤트 유실 또는 지연 여부**: Kafka 브로커의 `FailedScheduling` 장애 시간 동안 인플라이트 버퍼 유실이 발생했는지 여부는 raw 증거에 포함되지 않았습니다.
- **영구 수정 사항의 라이브 클러스터 종단 검증**: 본 워크트리에 구현된 영구 방지책(하트비트 토픽, CNPG WAL 보존 상한, 감지 테스트)은 정적/매니페스트 검증만 통과했으며, 라이브 클러스터 배포를 통한 종단 검증은 아직 수행되지 않았습니다.

## 후속 조치 및 개선 사항

본 작업 공간의 diff(`git status --short` 및 `git diff --stat`)에 존재하는 항목:

1. **Debezium 하트비트 메커니즘 도입**:
   - `gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml`에 `heartbeat.interval.ms: "10000"` 및 `heartbeat.action.query: "INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at"` 구성.
   - `gitops/charts/beluga-data/files/shop-schema.sql`에 단일 행 제약 `CHECK (id = 1)`을 가진 `public.cdc_heartbeat` 테이블 스키마와 `beluga_admin` 소유권/권한 부여.
   - *상태*: 같은 변경에서 구현 완료, 라이브 검증 대기 중(implemented in the same change, live verification pending).
2. **전용 Kafka 하트비트 토픽 생성**:
   - `gitops/charts/beluga-data/templates/03-cdc-heartbeat-topics.yaml`에 `cdc.shop.public.cdc_heartbeat` 및 `__debezium-heartbeat.cdc.shop` 토픽(1일 보존, 1시간 세그먼트 롤링) 선언.
   - *상태*: 같은 변경에서 구현 완료, 라이브 검증 대기 중(implemented in the same change, live verification pending).
3. **PostgreSQL 슬롯 WAL 보존 상한 설정**:
   - `gitops/charts/beluga-data/templates/02-cnpg.yaml`의 `spec.postgresql.parameters`에 `max_slot_wal_keep_size: "1GB"` 추가 (D-WAL-1). 5Gi PGDATA PVC 대비 복제 슬롯이 점유할 수 있는 WAL을 1GB로 제한하여, 노드 전체 축출 대신 지연 슬롯 무효화(`wal_status: lost`)를 선택하도록 통제.
   - *상태*: 같은 변경에서 구현 완료, 라이브 검증 대기 중(implemented in the same change, live verification pending).
4. **자동화된 감지 테스트 도입**:
   - `tests/29-cdc-slot-wal-retention.sh` 및 단위 테스트 `tests/test_cdc_slot_wal_retention.py` 구현. 하트비트 설정, 양수 WAL 상한, 슬롯 활성 상태, 잔여 WAL 1GB 미만, 노드 여유 공간 20% 이상을 점검하며 `tests/run-all.sh`에 등록.
   - *상태*: 같은 변경에서 구현 완료, 라이브 검증 대기 중(implemented in the same change, live verification pending).
5. **운영 복구 런북 문서화**:
   - 운영 복구 절차를 `docs/runbooks/cdc-slot-wal-retention.md` 및 `docs/runbooks/cdc-slot-wal-retention-ko.md`에 기술하고 `docs/mistakes-log.md`에 기록.
   - *상태*: 같은 변경에서 구현 완료, 라이브 검증 대기 중(implemented in the same change, live verification pending).
6. **자동화된 연속 알림**:
   - *상태*: 미구현 / 오픈 이슈. VictoriaMetrics가 CNPG 복제 슬롯 익스포터(9187 포트)나 노드 파일시스템 지표를 상시 스크랩하고 라우팅하는 알림 규칙은 클러스터에 배포되지 않았습니다.

## 유효성 위협 (Threats to Validity)

- **단일 개발 클러스터**: 본 장애 및 복구 데이터는 단일 노드 Colima k3s ARM64 가상 머신 환경에서만 관측되었습니다. 멀티 노드나 독립 디스크가 구성된 환경에서는 축출 임계점과 스케줄링 양상이 다를 수 있습니다.
- **단일 발생 사례**: 2026-11-11 단 한 차례 발생한 장애 사례를 기반으로 수집되었으며, 다양한 트랜잭션 유입량에서의 재현 검증은 이루어지지 않았습니다.
- **타임라인 폴링 주기 해상도**: `04-recovery-timeline.txt`의 상태 전이는 약 30초 간격의 쉘 폴링(16:49:42Z와 16:56:01Z 사이처럼 더 긴 간격 포함)으로 기록되어, 더 짧은 순간의 전이는 포착되지 않았습니다.
- **쿠버네티스 Events API 보존 주기 한계**: K8s Events API의 1시간 보존 제한으로 인해 `15:23:58Z` 이전의 초기 축출 이벤트가 유실되어, 디스크 적체가 시작된 최초 시점의 파악에 한계가 있습니다.
